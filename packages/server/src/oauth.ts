import crypto from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { ServerConfig } from './config.js';
import type { KernLike, User } from './types.js';
import { ALLE_SCOPES, type Scope, type TokenEintrag, type ZugangLike } from './zugang.js';
import type { SicherheitsEreignis } from './protokoll.js';
import { leseKernYaml } from './config.js';
import { Fenster } from './grenzen.js';

/**
 * v1.4 6.1/6.2: Jede Instanz ist ihr eigener OAuth-2.1-Autorisierungsserver für MCP.
 * Client ID Metadata Documents (CIMD) zuerst, Dynamic Client Registration nur als Rückfall.
 * PKCE S256 Pflicht, `resource` (RFC 8707) Pflicht und geprüft, `iss` in der Antwort (RFC 9207).
 * Speicher und Kryptografie liegen in core (`kern.zugang`); hier sind nur die HTTP-Endpunkte.
 */

export interface OAuthClient { clientId: string; name: string; redirectUris: string[]; erstellt?: string; art?: 'dcr' | 'cimd' }
interface TokenPaar { zugriff: { token: string; eintrag: TokenEintrag }; erneuerung: { token: string; eintrag: TokenEintrag } }
/** OAuth-Teil von core `Zugangsspeicher` (optional, fehlt bei der Attrappe). */
export interface OAuthSpeicher {
  registriereClient(c: { name: string; redirectUris: string[] }): OAuthClient;
  holeClient(clientId: string): OAuthClient | null;
  erzeugeCode(fuer: User, c: { clientId: string; redirectUri: string; codeChallenge: string; scopes: Scope[]; zielgruppe: string }): string;
  loeseCodeEin(code: string, c: { clientId: string; redirectUri: string; codeVerifier: string }): TokenPaar | null;
  erneuere(refreshToken: string, e?: { clientId?: string }): TokenPaar | null;
  merkeCimdClient?(c: { clientId: string; name: string; redirectUris: string[] }): OAuthClient;
}

export function oauthVon(z: ZugangLike): OAuthSpeicher | null {
  const o = z as unknown as Partial<OAuthSpeicher>;
  return typeof o.registriereClient === 'function' && typeof o.erzeugeCode === 'function' && typeof o.loeseCodeEin === 'function' ? (o as OAuthSpeicher) : null;
}

/** Scopes, die über OAuth vergeben werden (nie kern:verwalten), mit Mindestrolle (6.3). */
export const OAUTH_SCOPES: Scope[] = ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht'];
export const STANDARD_SCOPE = 'kern:lesen kern:fragen';
const MINDESTROLLE: Record<Scope, (u: User) => boolean> = {
  'kern:lesen': () => true,
  'kern:fragen': () => true,
  'kern:vorschlagen': (u) => u.rollen.some((r) => r === 'autor' || r === 'freigeber' || r === 'admin'),
  'kern:bericht': (u) => u.rollen.some((r) => r === 'autor' || r === 'freigeber' || r === 'admin'),
  'kern:verwalten': () => false,
};
export const scopeErlaubt = (u: User, s: Scope) => MINDESTROLLE[s](u);

/** Bekannte Apps für den Schalter „Nur bekannte Apps“ (Hostnamen der CIMD-URL bzw. Redirect-URI). */
const BEKANNTE_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com', 'openai.com', 'localhost', '127.0.0.1'];

/** Pflichthinweis Datenfluss F12 (6.4), nicht wegklickbar. */
export const F12_HINWEIS = 'Was dieses Programm über MCP abruft (Suchtreffer, Artikel, Antworten, die du sehen darfst), geht an den Anbieter dieses Programms und landet im Kontext seines Modells. Kern kann das nur über die Rechte dieses Zugangs begrenzen.';

export interface OAuthKontext {
  app: Hono;
  kern: KernLike;
  config: ServerConfig;
  zugang: ZugangLike;
  basisUrl(c: Context): string;
  /** Angemeldeter Benutzer aus der Sitzung samt Sitzungs-ID, sonst null. */
  sitzungsNutzer(c: Context): Promise<{ user: User; sitzung: string } | null>;
  /** Anmeldung mit allen Bremsen; gibt den Benutzer oder eine Fehlermeldung zurück und setzt das Cookie. */
  anmelden(c: Context, name: string, passwort: string): Promise<{ user: User } | { fehler: string; status: number }>;
  prot(c: Context, e: SicherheitsEreignis, benutzer: string | null, ergebnis?: 'ok' | 'abgelehnt' | 'fehler', ziel?: string): void;
  ip(c: Context): string;
  /** Abruf mit SSRF-Schutz aus core; fehlt er, ist CIMD aus. */
  abruf?: (url: string) => Promise<{ status: number; text: () => string; typ: string }>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const SCOPE_TEXT: Record<Scope, string> = {
  'kern:lesen': 'Suchen und lesen, was du sehen darfst',
  'kern:fragen': 'Fragen stellen (verbraucht KI-Kontingent)',
  'kern:vorschlagen': 'Änderungen vorschlagen (ein Mensch gibt frei)',
  'kern:bericht': 'Berichte abrufen',
  'kern:verwalten': 'Verwalten',
};

const STIL = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1b1b1b}main{max-width:34rem;margin:2rem auto;padding:1.5rem;background:#fff;border:1px solid #ddd;border-radius:12px}
h1{font-size:1.3rem;margin-top:0}.hinweis{background:#fff6dc;border:1px solid #e5c55c;padding:.75rem;border-radius:8px}.warnung{background:#fde8e8;border:1px solid #e08a8a;padding:.75rem;border-radius:8px}
label{display:block;margin:.75rem 0 .25rem}input[type=text],input[type=password]{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}button{font:inherit;padding:.6rem 1rem;margin:.75rem .5rem 0 0;border-radius:8px;border:1px solid #333;background:#fff;cursor:pointer}
button.ja{background:#1b1b1b;color:#fff}li{margin:.25rem 0}code{word-break:break-all}`;

function seite(titel: string, inhalt: string, produkt: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(titel)} · ${esc(produkt)}</title><link rel="stylesheet" href="/oauth/stil.css"></head><body><main>${inhalt}</main></body></html>`;
}

interface AuthAnfrage {
  client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string;
  scope: string; state: string; resource: string; response_type: string;
}
const FELDER: (keyof AuthAnfrage)[] = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource', 'response_type'];

export function oauthRouten(k: OAuthKontext): { verfuegbar: boolean } {
  const { app, config, zugang } = k;
  const speicher = oauthVon(zugang);
  const produkt = config.produktName;
  const registrierLimit = new Fenster(20, 3600_000);
  const tokenLimit = new Fenster(120, 60_000);
  const cimdCache = new Map<string, { client: OAuthClient; bis: number }>();

  const issuer = (c: Context) => k.basisUrl(c);
  const resourceUrl = (c: Context) => `${k.basisUrl(c)}/mcp`;
  const nurBekannte = (): boolean => {
    const y = leseKernYaml(config.dataDir) as { oauth?: { nur_bekannte_apps?: boolean; bekannte_hosts?: string[] } };
    return y.oauth?.nur_bekannte_apps === true;
  };
  const bekannteHosts = (): string[] => {
    const y = leseKernYaml(config.dataDir) as { oauth?: { bekannte_hosts?: string[] } };
    return [...BEKANNTE_HOSTS, ...(Array.isArray(y.oauth?.bekannte_hosts) ? y.oauth!.bekannte_hosts!.filter((h) => typeof h === 'string') : [])];
  };
  const hostBekannt = (url: string) => { try { const h = new URL(url).hostname; return bekannteHosts().some((b) => h === b || h.endsWith(`.${b}`)); } catch { return false; } };

  // Metadaten des Autorisierungsservers (RFC 8414)
  app.get('/.well-known/oauth-authorization-server', (c) => {
    if (!speicher) return c.json({ fehler: 'OAuth ist in dieser Installation nicht verfügbar.' }, 404);
    const b = issuer(c);
    return c.json({
      issuer: b,
      authorization_endpoint: `${b}/oauth/authorize`,
      token_endpoint: `${b}/oauth/token`,
      registration_endpoint: `${b}/oauth/register`,
      revocation_endpoint: `${b}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: !!k.abruf && typeof speicher.merkeCimdClient === 'function',
      authorization_response_iss_parameter_supported: true,
      scopes_supported: OAUTH_SCOPES,
      service_documentation: `${b}/`,
    }, 200, { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
  });

  app.get('/oauth/stil.css', (c) => c.body(STIL, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));

  if (!speicher) {
    app.all('/oauth/*', (c) => c.json({ error: 'temporarily_unavailable', error_description: 'OAuth braucht den Zugangsspeicher von core.' }, 404));
    return { verfuegbar: false };
  }

  /** Client auflösen: CIMD (client_id ist eine HTTPS-URL) oder registriert (DCR). */
  const loeseClient = async (clientId: string): Promise<OAuthClient | { fehler: string }> => {
    if (/^https:\/\//i.test(clientId)) {
      if (!k.abruf || typeof speicher.merkeCimdClient !== 'function') return { fehler: 'Client ID Metadata Documents werden hier noch nicht unterstützt.' };
      const im = cimdCache.get(clientId);
      if (im && im.bis > Date.now()) return im.client;
      let url: URL;
      try { url = new URL(clientId); } catch { return { fehler: 'client_id ist keine gültige Adresse.' }; }
      if (url.hash || url.username || url.password || url.pathname === '/') return { fehler: 'client_id muss eine HTTPS-Adresse mit Pfad sein.' };
      if (nurBekannte() && !hostBekannt(clientId)) return { fehler: 'Nur bekannte Apps sind erlaubt (Einstellung des Admins).' };
      let doc: Record<string, unknown>;
      try {
        const r = await k.abruf(clientId);
        if (r.status !== 200) return { fehler: `Metadaten des Clients nicht abrufbar (HTTP ${r.status}).` };
        doc = JSON.parse(r.text()) as Record<string, unknown>;
      } catch {
        return { fehler: 'Metadaten des Clients nicht abrufbar oder kein JSON.' };
      }
      if (doc.client_id !== clientId) return { fehler: 'client_id im Dokument stimmt nicht mit der Adresse überein.' };
      const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((x): x is string => typeof x === 'string') : [];
      const methode = doc.token_endpoint_auth_method;
      if (methode !== undefined && methode !== 'none') return { fehler: 'Nur öffentliche Clients (token_endpoint_auth_method: none).' };
      const name = typeof doc.client_name === 'string' ? doc.client_name.slice(0, 80) : url.hostname;
      try {
        const client = speicher.merkeCimdClient({ clientId, name, redirectUris: uris });
        cimdCache.set(clientId, { client, bis: Date.now() + 5 * 60_000 });
        return client;
      } catch (e) {
        return { fehler: (e as Error).message };
      }
    }
    const cl = speicher.holeClient(clientId);
    return cl ?? { fehler: 'Unbekannter Client.' };
  };

  const fehlerSeite = (c: Context, text: string, status = 400) =>
    c.html(seite('Verbindung nicht möglich', `<h1>Verbindung nicht möglich</h1><p>${esc(text)}</p><p>Du kannst dieses Fenster schließen.</p>`, produkt), status as 400);

  const zurueck = (redirectUri: string, werte: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [a, b] of Object.entries(werte)) if (b) u.searchParams.set(a, b);
    return u.toString();
  };

  const formularToken = (sitzung: string, a: AuthAnfrage) =>
    crypto.createHmac('sha256', config.secret).update(`oauth|${sitzung}|${FELDER.map((f) => a[f]).join('|')}`).digest('base64url');

  /** Prüft die Anfrage. Fehler vor gesicherter redirect_uri → Fehlerseite, danach Umleitung mit error (RFC 6749 4.1.2.1). */
  const pruefeAnfrage = async (c: Context, a: AuthAnfrage): Promise<{ client: OAuthClient; scopes: Scope[] } | Response> => {
    if (!a.client_id) return fehlerSeite(c, 'client_id fehlt.');
    const client = await loeseClient(a.client_id);
    if ('fehler' in client) return fehlerSeite(c, client.fehler);
    if (!a.redirect_uri || !client.redirectUris.includes(a.redirect_uri)) return fehlerSeite(c, 'Die Rücksprungadresse (redirect_uri) ist für diesen Client nicht eingetragen.');
    if (nurBekannte() && !hostBekannt(a.redirect_uri) && !hostBekannt(a.client_id)) return fehlerSeite(c, 'Nur bekannte Apps sind erlaubt (Einstellung des Admins).');
    const iss = issuer(c);
    const fehler = (error: string, beschreibung: string) => c.redirect(zurueck(a.redirect_uri, { error, error_description: beschreibung, state: a.state, iss }), 302);
    if (a.response_type !== 'code') return fehler('unsupported_response_type', 'Nur response_type=code.');
    if (a.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(a.code_challenge)) return fehler('invalid_request', 'PKCE mit S256 ist Pflicht.');
    if (!a.resource) return fehler('invalid_target', 'resource (RFC 8707) fehlt.');
    if (a.resource.replace(/\/+$/, '') !== resourceUrl(c) && a.resource.replace(/\/+$/, '') !== iss) return fehler('invalid_target', 'resource gehört nicht zu dieser Instanz.');
    const angefragt = (a.scope || STANDARD_SCOPE).split(/\s+/).filter(Boolean);
    if (angefragt.some((s) => !(ALLE_SCOPES as readonly string[]).includes(s))) return fehler('invalid_scope', 'Unbekannter Scope.');
    if (angefragt.includes('kern:verwalten')) return fehler('invalid_scope', 'kern:verwalten gibt es nie über OAuth.');
    return { client, scopes: angefragt as Scope[] };
  };

  const anfrageAus = (q: (n: string) => string | undefined): AuthAnfrage =>
    Object.fromEntries(FELDER.map((f) => [f, (q(f) ?? '').slice(0, 2048)])) as unknown as AuthAnfrage;

  const versteckt = (a: AuthAnfrage) => FELDER.map((f) => `<input type="hidden" name="${f}" value="${esc(a[f])}">`).join('');

  const zustimmung = (c: Context, user: User, sitzung: string, a: AuthAnfrage, client: OAuthClient, scopes: Scope[]) => {
    const host = new URL(a.redirect_uri).hostname;
    const lokal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
    const erlaubt = scopes.filter((s) => scopeErlaubt(user, s));
    const verweigert = scopes.filter((s) => !scopeErlaubt(user, s));
    const anbieter = /^https:\/\//i.test(client.clientId) ? new URL(client.clientId).hostname : null;
    // form-action muss den Rücksprung nach dem Absenden erlauben (Browser prüfen Weiterleitungen nach Formularen).
    const ziel = new URL(a.redirect_uri);
    const rueck = ziel.protocol === 'https:' || ziel.protocol === 'http:' ? ziel.origin : ziel.protocol;
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' ${rueck}; frame-ancestors 'none'; base-uri 'none'`);
    return c.html(seite('Zugriff erlauben', `<h1>${esc(client.name)} möchte auf ${esc(config.kern.betrieb)} zugreifen</h1>
<p>Angemeldet als <strong>${esc(user.name)}</strong>. Rücksprung an <strong>${esc(host)}</strong>${anbieter ? `, Anbieter laut Metadaten: <strong>${esc(anbieter)}</strong>` : ', registriert ohne Metadaten-Dokument'}.</p>
${lokal ? '<p class="warnung">Die Rücksprungadresse liegt auf diesem Rechner (localhost). Erlaube das nur, wenn du das Programm gerade selbst gestartet hast.</p>' : ''}
<p>Das Programm darf:</p><ul>${erlaubt.map((s) => `<li>${esc(SCOPE_TEXT[s])} <code>${s}</code></li>`).join('')}</ul>
${verweigert.length ? `<p>Nicht möglich mit deiner Rolle: ${verweigert.map((s) => `<code>${s}</code>`).join(', ')}.</p>` : ''}
<p class="hinweis" id="f12">${esc(F12_HINWEIS)}</p>
<p>Freigeben, Einstellungen und Benutzerverwaltung sind über diese Verbindung nie möglich. Widerrufen kannst du jederzeit unter Einstellungen › Verbundene Apps.</p>
<form method="post" action="/oauth/authorize">${versteckt(a)}<input type="hidden" name="csrf" value="${formularToken(sitzung, a)}">
<button type="submit" name="entscheidung" value="ablehnen">Ablehnen</button><button class="ja" type="submit" name="entscheidung" value="erlauben">Erlauben</button></form>`, produkt));
  };

  const anmeldeSeite = (c: Context, a: AuthAnfrage, meldung?: string, status = 200) =>
    c.html(seite('Anmelden', `<h1>Anmelden bei ${esc(produkt)}</h1><p>Ein Programm möchte eine Verbindung zu ${esc(config.kern.betrieb)} herstellen. Melde dich zuerst an.</p>
${meldung ? `<p class="warnung">${esc(meldung)}</p>` : ''}
<form method="post" action="/oauth/anmelden">${versteckt(a)}<label for="n">Name</label><input id="n" type="text" name="name" autocomplete="username" required>
<label for="p">Passwort</label><input id="p" type="password" name="passwort" autocomplete="current-password" required><button class="ja" type="submit">Anmelden</button></form>`, produkt), status as 200);

  const gleicheHerkunft = (c: Context) => {
    const o = c.req.header('origin');
    return !o || o === issuer(c);
  };

  app.get('/oauth/authorize', async (c) => {
    const a = anfrageAus((n) => c.req.query(n));
    const p = await pruefeAnfrage(c, a);
    if (p instanceof Response) return p;
    const s = await k.sitzungsNutzer(c);
    if (!s) return anmeldeSeite(c, a);
    return zustimmung(c, s.user, s.sitzung, a, p.client, p.scopes);
  });

  app.post('/oauth/anmelden', async (c) => {
    if (!gleicheHerkunft(c)) return fehlerSeite(c, 'Ungültige Herkunft.', 403);
    const f = await c.req.parseBody();
    const a = anfrageAus((n) => (typeof f[n] === 'string' ? (f[n] as string) : undefined));
    const p = await pruefeAnfrage(c, a);
    if (p instanceof Response) return p;
    const r = await k.anmelden(c, String(f.name ?? '').slice(0, 100), String(f.passwort ?? '').slice(0, 500));
    if ('fehler' in r) return anmeldeSeite(c, a, r.fehler, r.status);
    const ziel = new URL('/oauth/authorize', issuer(c));
    for (const x of FELDER) if (a[x]) ziel.searchParams.set(x, a[x]);
    return c.redirect(`${ziel.pathname}${ziel.search}`, 303);
  });

  app.post('/oauth/authorize', async (c) => {
    if (!gleicheHerkunft(c)) return fehlerSeite(c, 'Ungültige Herkunft.', 403);
    const f = await c.req.parseBody();
    const a = anfrageAus((n) => (typeof f[n] === 'string' ? (f[n] as string) : undefined));
    const p = await pruefeAnfrage(c, a);
    if (p instanceof Response) return p;
    const s = await k.sitzungsNutzer(c);
    if (!s) return anmeldeSeite(c, a, 'Bitte erneut anmelden.');
    const soll = Buffer.from(formularToken(s.sitzung, a));
    const ist = Buffer.from(String(f.csrf ?? ''));
    if (soll.length !== ist.length || !crypto.timingSafeEqual(soll, ist)) return fehlerSeite(c, 'Formular abgelaufen. Bitte neu verbinden.', 403);
    const iss = issuer(c);
    if (f.entscheidung !== 'erlauben') {
      k.prot(c, 'oauth_zustimmung', s.user.id, 'abgelehnt', p.client.clientId.slice(0, 200));
      return c.redirect(zurueck(a.redirect_uri, { error: 'access_denied', state: a.state, iss }), 302);
    }
    const scopes = p.scopes.filter((x) => scopeErlaubt(s.user, x));
    if (!scopes.length) return c.redirect(zurueck(a.redirect_uri, { error: 'invalid_scope', error_description: 'Keiner der Scopes passt zu deiner Rolle.', state: a.state, iss }), 302);
    const code = speicher.erzeugeCode(s.user, { clientId: p.client.clientId, redirectUri: a.redirect_uri, codeChallenge: a.code_challenge, scopes, zielgruppe: resourceUrl(c) });
    k.prot(c, 'oauth_zustimmung', s.user.id, 'ok', p.client.clientId.slice(0, 200));
    return c.redirect(zurueck(a.redirect_uri, { code, state: a.state, iss }), 302);
  });

  const tokenFehler = (c: Context, error: string, beschreibung: string, status = 400) =>
    c.json({ error, error_description: beschreibung }, status as 400, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const tokenAntwort = (c: Context, p: TokenPaar) => {
    const sek = p.zugriff.eintrag.laeuftAb ? Math.max(0, Math.round((Date.parse(p.zugriff.eintrag.laeuftAb) - Date.now()) / 1000)) : 3600;
    return c.json({ access_token: p.zugriff.token, token_type: 'Bearer', expires_in: sek, refresh_token: p.erneuerung.token, scope: p.zugriff.eintrag.scopes.join(' ') }, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Access-Control-Allow-Origin': '*' });
  };
  const formular = async (c: Context): Promise<Record<string, string>> => {
    const typ = c.req.header('content-type') ?? '';
    if (typ.startsWith('application/json')) {
      const j = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    }
    const f = await c.req.parseBody();
    return Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  };

  app.post('/oauth/token', async (c) => {
    if (tokenLimit.nimm(k.ip(c))) return tokenFehler(c, 'slow_down', 'Zu viele Anfragen.', 429);
    const f = await formular(c);
    if (f.client_secret) return tokenFehler(c, 'invalid_client', 'Nur öffentliche Clients ohne Geheimnis.', 401);
    if (f.resource && f.resource.replace(/\/+$/, '') !== resourceUrl(c) && f.resource.replace(/\/+$/, '') !== issuer(c)) return tokenFehler(c, 'invalid_target', 'resource gehört nicht zu dieser Instanz.');
    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.client_id || !f.redirect_uri || !f.code_verifier) return tokenFehler(c, 'invalid_request', 'code, client_id, redirect_uri und code_verifier sind Pflicht.');
      if (!f.resource) return tokenFehler(c, 'invalid_target', 'resource (RFC 8707) fehlt.');
      const p = speicher.loeseCodeEin(f.code, { clientId: f.client_id, redirectUri: f.redirect_uri, codeVerifier: f.code_verifier });
      if (!p) return tokenFehler(c, 'invalid_grant', 'Code ungültig, abgelaufen, schon benutzt oder PKCE falsch.');
      k.prot(c, 'zugang_erzeugt', p.zugriff.eintrag.userId, 'ok', p.zugriff.eintrag.id);
      return tokenAntwort(c, p);
    }
    if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token) return tokenFehler(c, 'invalid_request', 'refresh_token fehlt.');
      const p = speicher.erneuere(f.refresh_token, { clientId: f.client_id || undefined });
      if (!p) return tokenFehler(c, 'invalid_grant', 'Erneuerung ungültig oder schon benutzt (dann ist die ganze Kette widerrufen).');
      return tokenAntwort(c, p);
    }
    return tokenFehler(c, 'unsupported_grant_type', 'Nur authorization_code und refresh_token.');
  });

  // DCR (RFC 7591): abgekündigt, aber angeboten, weil Clients ohne CIMD darauf zurückfallen.
  app.post('/oauth/register', async (c) => {
    if (registrierLimit.nimm(k.ip(c))) return c.json({ error: 'slow_down', error_description: 'Zu viele Registrierungen.' }, 429);
    const b = await c.req.json().catch(() => null) as { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown } | null;
    if (!b || !Array.isArray(b.redirect_uris) || !b.redirect_uris.every((u) => typeof u === 'string')) return c.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris fehlt.' }, 400);
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') return c.json({ error: 'invalid_client_metadata', error_description: 'Nur token_endpoint_auth_method none.' }, 400);
    const uris = b.redirect_uris as string[];
    if (nurBekannte() && !uris.every(hostBekannt)) return c.json({ error: 'invalid_redirect_uri', error_description: 'Nur bekannte Apps sind erlaubt.' }, 400);
    try {
      const cl = speicher.registriereClient({ name: typeof b.client_name === 'string' ? b.client_name : 'MCP-Client', redirectUris: uris });
      k.prot(c, 'oauth_client_registriert', null, 'ok', cl.clientId);
      return c.json({
        client_id: cl.clientId, client_name: cl.name, redirect_uris: cl.redirectUris, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Math.floor(Date.now() / 1000),
      }, 201, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return c.json({ error: 'invalid_redirect_uri', error_description: (e as Error).message }, 400);
    }
  });

  // Widerruf (RFC 7009): immer 200, auch für unbekannte Tokens.
  app.post('/oauth/revoke', async (c) => {
    const f = await formular(c);
    if (f.token) {
      const t = zugang.pruefe(f.token, { art: ['oauth_zugriff', 'oauth_erneuerung'] });
      if (t && (!f.client_id || f.client_id === t.eintrag.clientId)) {
        zugang.widerrufeAlle({ ...t.user, rollen: ['admin'] }, t.user.id, { art: ['oauth_zugriff', 'oauth_erneuerung'], ...(t.eintrag.clientId ? { clientId: t.eintrag.clientId } : {}) });
        k.prot(c, 'oauth_widerruf', t.user.id, 'ok', t.eintrag.clientId ?? t.eintrag.id);
      }
    }
    return c.body(null, 200);
  });

  return { verfuegbar: true };
}
