import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { KernLike, Rolle, Sichtbarkeit, User } from './types.js';
import { REGEL_ORDNER, ROLLEN } from './types.js';
import type { ServerConfig } from './config.js';
import { leseKernYaml, schreibeKernYaml } from './config.js';
import { KernFehler, keineRechte, nichtGefunden, statusAusFehler, ungueltig } from './fehler.js';
import { artikelPfad, dekodiereUrlPfad, quellenPfad, sicherVerbinden } from './pfade.js';
import { darf, pruefeZiel, type Aktion } from './rechte.js';
import { bearbeiteMcp } from './mcp.js';
import { waehleZugang, ALLE_SCOPES, type Scope, type TokenEintrag, type ZugangLike } from './zugang.js';
import { Fenster, KontoSperre, herkunftsIp } from './grenzen.js';
import { ERLAUBTE_KEY_ENV } from './anbieter.js';
import type { BenutzerDetail } from './types.js';
import { Sicherheitsprotokoll, kuerzeIp, type SicherheitsEreignis } from './protokoll.js';
import { Betriebszustand, betriebsRouten } from './betrieb.js';
import { Geheimnisse } from './geheimnisse.js';
import { oauthRouten, oauthVon, OAUTH_SCOPES, STANDARD_SCOPE, scopeErlaubt } from './oauth.js';
import { TOOL_SCOPE, MCP_TOOLS } from './mcp.js';
import { bauDatenweg } from './datenweg.js';
import { leseQuelle } from './kern-laden.js';

type Env = { Variables: { user: User } };

export interface AppOptionen {
  kern: KernLike;
  config: ServerConfig;
  version?: string;
  /** Für Tests: eigener Abruf für Client ID Metadata Documents (sonst sichererAbruf aus core). */
  abruf?: (url: string) => Promise<{ status: number; text: () => string; typ: string }>;
}

export interface KernApp {
  app: Hono<Env>;
  /** Gemeinsamer Tokenspeicher (core oder Ersatz). */
  zugang: ZugangLike;
  zugangAusCore: boolean;
  /** Für Tests und CLI: Token für einen Benutzer selbst erzeugen (nie für andere). */
  erzeugeToken(u: User, o?: { bezeichnung?: string; scopes?: Scope[]; gueltigTage?: number }): { token: string; eintrag: TokenEintrag };
}

/** Ressourcen-Bezeichner und Metadaten-Pfad (RFC 9728) für MCP. */
export const MCP_PFAD = '/mcp';
export const PRM_PFAD = '/.well-known/oauth-protected-resource';

export const CSRF_HEADER = 'x-kern';
const STANDARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webmanifest': 'application/manifest+json',
};

const sichtbarkeitSchema = z.string().regex(/^(ich|betrieb|team:[\p{L}\p{N}_ -]{1,60})$/u, 'Sichtbarkeit: ich, betrieb oder team:<name>');
const reichweiteSchema = z.enum(['ich', 'team', 'betrieb']).optional();
const ID_MUSTER = /^[A-Za-z0-9_-]{1,100}$/;


function sicherDateiname(n: string): string {
  const basis = path.basename(n.replace(/\\/g, '/')).normalize('NFC');
  const sauber = basis.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(-120);
  return sauber || 'datei';
}

export function erstelleApp(opt: AppOptionen): KernApp {
  const { kern, config } = opt;
  const version = opt.version ?? '0.1.0';
  const app = new Hono<Env>();
  const { zugang, ausCore: zugangAusCore } = waehleZugang(kern, config.dataDir);
  const g = config.grenzen;
  // H3: Sperre je Konto (unabhängig von der IP, mit Verdopplung) und Bremse je Herkunfts-IP.
  const kontoSperre = new KontoSperre(5, 60, 3600);
  const loginLimitIp = new Fenster(30, 15 * 60_000);
  // M5: Raten- und Kostenlimits.
  const fragenMinute = new Fenster(g.fragenProMinute, 60_000);
  const fragenTag = new Fenster(g.fragenProTag, 24 * 3600_000);
  const kiTagInstanz = new Fenster(g.kiProTagInstanz, 24 * 3600_000);
  const mcpMinute = new Fenster(g.mcpProMinuteToken, 60_000);
  const apiMinute = new Fenster(g.apiProMinuteNutzer, 60_000);
  const fragenMinuteInstanz = new Fenster(g.fragenProMinuteInstanz, 60_000);
  const uploadsMinute = new Fenster(g.uploadsProMinute, 60_000);
  const protokoll = new Sicherheitsprotokoll(config.dataDir);
  const betrieb = new Betriebszustand(config.dataDir);
  /** D-L5: ein Eintrag je Ereignis, ohne Inhalte. */
  const prot = (c: Context, ereignis: SicherheitsEreignis, benutzer: string | null, ergebnis: 'ok' | 'abgelehnt' | 'fehler' = 'ok', ziel?: string) =>
    protokoll.schreibe({ ereignis, benutzer, ergebnis, ziel, ip_kurz: kuerzeIp(clientIp(c)) });
  /** Sitzungs-ID → zugangsStand beim Anmelden (falls core ihn liefert). */
  const stand = new Map<string, number>();

  const nutzerNachId = async (id: string): Promise<BenutzerDetail | null> => {
    if (typeof kern.benutzer.hole === 'function') return kern.benutzer.hole(id);
    return (await kern.benutzer.liste()).find((u) => u.id === id) ?? null;
  };
  const nurUser = (u: BenutzerDetail): User => ({ id: u.id, name: u.name, rollen: u.rollen, teams: u.teams });

  const socketIp = (c: Context): string | undefined =>
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  const clientIp = (c: Context): string => herkunftsIp(socketIp(c), c.req.header('x-forwarded-for'), config.proxyHops);
  /** Rechter Rand eines Proxy-Headers (vom eigenen Proxy gesetzt). */
  const proxyWert = (c: Context, h: string): string | undefined => {
    if (config.proxyHops <= 0) return undefined;
    const t = (c.req.header(h) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return t.length ? t[t.length - 1] : undefined;
  };
  const istHttps = (c: Context): boolean => new URL(c.req.url).protocol === 'https:' || proxyWert(c, 'x-forwarded-proto') === 'https';
  const sicher = (c: Context): boolean => config.secureCookie || istHttps(c);
  const basisUrl = (c: Context): string => {
    if (config.publicUrl) return config.publicUrl;
    const u = new URL(c.req.url);
    const host = proxyWert(c, 'x-forwarded-host') ?? c.req.header('host') ?? u.host;
    return `${istHttps(c) ? 'https' : u.protocol.replace(':', '')}://${host}`;
  };
  const COOKIE_SICHER = '__Host-kern_sitzung';
  const COOKIE_EINFACH = 'kern_sitzung';
  const signiere = (t: string) => crypto.createHmac('sha256', config.secret).update(t).digest('base64url');
  const cookieWert = (token: string) => `${token}.${signiere(token)}`;
  const tokenAusCookie = (c: Context): string | null => {
    const roh = getCookie(c, COOKIE_SICHER) ?? getCookie(c, COOKIE_EINFACH);
    if (!roh) return null;
    const i = roh.lastIndexOf('.');
    if (i <= 0) return null;
    const t = roh.slice(0, i);
    const soll = Buffer.from(signiere(t));
    const ist = Buffer.from(roh.slice(i + 1));
    return soll.length === ist.length && crypto.timingSafeEqual(soll, ist) ? t : null;
  };
  const geraetVon = (c: Context): string => {
    const ua = c.req.header('user-agent') ?? '';
    const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Programm' : 'unbekannt';
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser}${os ? ` (${os})` : ''}`;
  };
  const setzeSitzung = async (c: Context, u: User) => {
    // N7: höchstens N Sitzungen je Nutzer, die älteste endet.
    const offen = zugang.liste({ ...u, rollen: ['admin'] }, u.id, { art: ['sitzung'] }).sort((a, b) => a.erstellt.localeCompare(b.erstellt));
    for (const alt of offen.slice(0, Math.max(0, offen.length - g.sitzungenJeNutzer + 1))) zugang.widerrufe({ ...u, rollen: ['admin'] }, alt.id);
    const { token, eintrag } = zugang.erzeuge(u, { art: 'sitzung', bezeichnung: 'Anmeldung', geraet: geraetVon(c), gueltigSek: config.sitzungStunden * 3600 });
    const d = await nutzerNachId(u.id);
    if (typeof d?.zugangsStand === 'number') stand.set(eintrag.id, d.zugangsStand);
    const s = sicher(c);
    setCookie(c, s ? COOKIE_SICHER : COOKIE_EINFACH, cookieWert(token), {
      httpOnly: true, sameSite: 'Strict', secure: s, path: '/', maxAge: config.sitzungStunden * 3600,
    });
    return eintrag;
  };
  const loescheCookies = (c: Context) => {
    deleteCookie(c, COOKIE_SICHER, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
    deleteCookie(c, COOKIE_EINFACH, { path: '/', httpOnly: true, sameSite: 'Strict' });
  };
  const zuViele = (c: Context, sek: number, text: string) => {
    c.header('Retry-After', String(sek));
    return c.json({ fehler: text, code: 'zu_viele' }, 429);
  };
  /** M5: Ratenlimit je Benutzer plus Tagesbudget für KI-Aufrufe (Benutzer und Instanz). Wirft 429. */
  const kiBudget = (u: User, art: 'frage' | 'ki') => {
    if (art === 'frage') {
      const w1 = fragenMinute.wartezeit(u.id);
      if (w1) throw Object.assign(new KernFehler(429, `Zu viele Fragen in kurzer Zeit. Bitte in ${w1} Sekunden erneut versuchen.`, 'zu_viele'), { retryAfter: w1 });
      const w2 = fragenTag.wartezeit(u.id);
      if (w2) throw Object.assign(new KernFehler(429, 'Das Tagesbudget für Fragen ist aufgebraucht.', 'zu_viele'), { retryAfter: w2 });
    }
    if (art === 'frage') {
      const w4 = fragenMinuteInstanz.wartezeit('instanz');
      if (w4) throw Object.assign(new KernFehler(429, `Diese Instanz bekommt gerade sehr viele Fragen. Bitte in ${w4} Sekunden erneut versuchen.`, 'zu_viele'), { retryAfter: w4 });
    }
    const w3 = kiTagInstanz.wartezeit('instanz');
    if (w3) throw Object.assign(new KernFehler(429, 'Das Tagesbudget für KI-Aufrufe dieser Instanz ist aufgebraucht.', 'zu_viele'), { retryAfter: w3 });
    if (art === 'frage') { fragenMinute.zaehle(u.id); fragenTag.zaehle(u.id); fragenMinuteInstanz.zaehle('instanz'); }
    kiTagInstanz.zaehle('instanz');
  };

  /** D-L13: maschinenlesbare Kennzeichnung nach Art. 50 KI-VO, falls core sie (noch) nicht setzt. */
  const modellVon = (): { anbieter: string; name: string } => {
    const p = config.kern.provider as Record<string, unknown>;
    return { anbieter: String(p.art), name: String(p.chatModell ?? p.art) };
  };
  const mitKennzeichnung = <T extends object>(a: T): T & { ki_erzeugt: boolean; modell: { anbieter: string; name: string } | null } => {
    const x = a as T & { ki_erzeugt?: boolean; modell?: { anbieter: string; name: string } | null };
    return { ...x, ki_erzeugt: x.ki_erzeugt ?? true, modell: x.modell === undefined ? modellVon() : x.modell };
  };
  /** Weg „ohne KI“ (Modus nur_lesen): wörtliche Auszüge mit Fundstelle, ehrlich gekennzeichnet. */
  const ohneKi = async (u: User, frage: string, reichweite?: 'ich' | 'team' | 'betrieb', sammlung?: string) => {
    const t = await kern.suche(u, frage, { reichweite, sammlung, limit: 5 });
    return {
      status: t.length ? 'beantwortet' : 'steht_nicht_drin',
      punkte: t.map((x, i) => ({ text: x.ausschnitt, belege: [i] })),
      belege: t.map((x) => ({ quelle: x.pfad, abschnitt: x.abschnitt, zeilen: x.zeilen, zitat: x.ausschnitt })),
      hinweis: 'Ohne KI: wörtliche Auszüge aus euren Dokumenten mit Fundstelle.',
      ki_erzeugt: false,
      modell: null,
    };
  };

  const pruefeRecht = (c: Context<Env>, a: Aktion) => {
    if (!darf(c.get('user'), a)) throw keineRechte();
  };

  // Sicherheitsheader für jede Antwort
  app.use('*', async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has('content-security-policy')) h.set('Content-Security-Policy', process.env.KERN_CSP || STANDARD_CSP);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (!c.req.path.startsWith('/.well-known/')) h.set('Cross-Origin-Resource-Policy', 'same-origin');
    h.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()');
    if (config.noindex) h.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    // P2: HSTS, sobald HTTPS erkannt ist (Konfiguration, https-URL oder X-Forwarded-Proto vom eigenen Proxy).
    if (sicher(c)) h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (c.req.path.startsWith('/api/') && !h.has('cache-control')) h.set('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    const { status, meldung } = statusAusFehler(err);
    const retry = (err as { retryAfter?: number }).retryAfter;
    if (retry) c.header('Retry-After', String(retry));
    // P2: keine Titel, Pfade oder Inhalte im Log, außer KERN_LOG_INHALTE=1.
    if (status >= 500) console.error('[kern] Fehler:', config.logInhalte ? err : `${(err as Error)?.name ?? 'Error'} (Details mit KERN_LOG_INHALTE=1)`);
    return c.json({ fehler: meldung }, status as 400);
  });

  // M1: Body-Grenzen. Vor der Anmeldung klein, JSON allgemein 1 MB, Vorschläge und Uploads eigene Grenzen.
  const zuGross = (max: number) => (c: Context) => c.json({ fehler: `Anfrage zu groß (höchstens ${max >= 1048576 ? `${Math.round(max / 1048576)} MB` : `${Math.round(max / 1024)} KB`}).`, code: 'zu_gross' }, 413);
  const grenze = (max: number) => bodyLimit({ maxSize: max, onError: zuGross(max) });
  const grenzeLogin = grenze(g.jsonVorLoginBytes);
  const grenzeJson = grenze(g.jsonBytes);
  const grenzeVorschlag = grenze(g.vorschlagBytes);
  const grenzeMcp = grenze(g.mcpBytes);
  app.use('/api/*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const p = c.req.path;
    if (p === '/api/hinzufuegen') return next(); // eigene Upload-Grenze an der Route
    if (p === '/api/login') return grenzeLogin(c, next);
    if (p === '/api/vorschlag' || p.startsWith('/api/eingang/')) return grenzeVorschlag(c, next);
    return grenzeJson(c, next);
  });

  app.get('/healthz', (c) => c.json({ ok: true, version }));

  // ---------- Betrieb (/_betrieb/*, nur intern, eigenes Token) und Modus ----------
  betriebsRouten(app as unknown as Hono, { kern, config, zustand: betrieb, zugang, socketIp, protokoll, version });

  // v1.4 3.2: Modus pausiert → nur Hinweis; nur_lesen → schreibende Routen 423 (außer Anmelden, Abmelden, Passwort, Export, Konto).
  const IMMER_ERLAUBT = /^\/api\/(login|logout|ich\/passwort|ich\/abmelden-ueberall|export|konto|frage)(\/|$)/;
  app.use('*', async (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/_betrieb/') || p === '/healthz' || p.startsWith('/.well-known/')) return next();
    if (betrieb.modus === 'pausiert') {
      if (p.startsWith('/api/') || p === MCP_PFAD) return c.json({ fehler: 'Diese Instanz ist pausiert.', code: 'pausiert' }, 503);
      return c.html('<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Pausiert</title></head><body><main><h1>Diese Instanz ist pausiert.</h1><p>Bitte wende dich an deinen Ansprechpartner.</p></main></body></html>', 503);
    }
    if (betrieb.modus === 'nur_lesen' && p.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !IMMER_ERLAUBT.test(p)) {
      return c.json({ fehler: 'Diese Instanz ist gerade nur lesbar. Export und Anmeldung gehen weiter.', code: 'nur_lesen' }, 423);
    }
    return next();
  });


  // ---------- OAuth-Vorbereitung (RFC 9728, MCP-Autorisierung 2025-06-18) ----------
  // Nur Protected Resource Metadata. Den Autorisierungsserver (OAuth 2.1, PKCE, dynamische
  // Client-Registrierung) baut O1 mit v1.4. Bis dahin: statische Tokens aus den Einstellungen.
  const prm = (c: Context) => {
    const basis = basisUrl(c);
    return c.json({
      resource: `${basis}${MCP_PFAD}`,
      // v1.4 6.1: die Instanz ist ihr eigener Autorisierungsserver (externer AS über KERN_OAUTH_ISSUER ist Fahrplan).
      ...(oauthVon(zugang) ? { authorization_servers: [config.oauthIssuer ?? basis] } : {}),
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: `${config.produktName}, ${config.kern.betrieb}`,
      resource_documentation: `${basis}/`,
    }, 200, { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
  };
  app.get(PRM_PFAD, prm);
  app.get(`${PRM_PFAD}${MCP_PFAD}`, prm);

  // ---------- MCP ----------
  const originErlaubt = (c: Context, origin: string): boolean => {
    const o = origin.replace(/\/+$/, '');
    if (o === 'null') return false;
    return o === basisUrl(c) || o === config.publicUrl || config.mcpOrigins.includes(o);
  };
  app.all(MCP_PFAD, grenzeMcp, async (c) => {
    // M5: Origin-Prüfung (MCP Streamable HTTP, Schutz gegen DNS-Rebinding). Ohne Origin: kein Browser, erlaubt.
    const origin = c.req.header('origin');
    if (origin && !originErlaubt(c, origin)) {
      return c.json({ jsonrpc: '2.0', error: { code: -32003, message: 'Herkunft (Origin) nicht erlaubt.' }, id: null }, 403);
    }
    const auth = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    const resource = `${basisUrl(c)}${MCP_PFAD}`;
    const treffer = m ? zugang.pruefe(m[1]!, { art: ['mcp', 'api', 'oauth_zugriff'], zielgruppe: resource }) : null;
    // Zielgruppe: Tokens mit eingetragener Zielgruppe gelten nur für genau diese Ressource.
    const passt = treffer && (!treffer.eintrag.zielgruppe || treffer.eintrag.zielgruppe === resource);
    const user = passt ? await nutzerNachId(treffer.eintrag.userId) : null;
    if (!user || !treffer) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${basisUrl(c)}${PRM_PFAD}${MCP_PFAD}", scope="${STANDARD_SCOPE}"${m ? ', error="invalid_token"' : ''}`);
      return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Token fehlt, ist abgelaufen oder ungültig.' }, id: null }, 401);
    }
    const w = Math.max(mcpMinute.nimm(treffer.eintrag.id), apiMinute.nimm(user.id));
    if (w) return zuViele(c, w, 'Zu viele Anfragen über dieses Token.');
    // 6.1: fehlender Scope für ein Werkzeug → 403 insufficient_scope (schrittweise Rechte), auf HTTP-Ebene.
    if (c.req.method === 'POST') {
      const roh = await c.req.raw.clone().json().catch(() => null) as { method?: string; params?: { name?: string } } | { method?: string; params?: { name?: string } }[] | null;
      for (const r of Array.isArray(roh) ? roh : roh ? [roh] : []) {
        const name = r?.method === 'tools/call' ? r.params?.name : undefined;
        if (!name || !(MCP_TOOLS as readonly string[]).includes(name)) continue;
        const noetig = TOOL_SCOPE[name as (typeof MCP_TOOLS)[number]];
        if (treffer.eintrag.scopes.includes(noetig)) continue;
        const kannErweitern = scopeErlaubt(nurUser(user), noetig);
        const gewuenscht = [...new Set([...treffer.eintrag.scopes, noetig])].join(' ');
        c.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${kannErweitern ? gewuenscht : treffer.eintrag.scopes.join(' ')}", resource_metadata="${basisUrl(c)}${PRM_PFAD}${MCP_PFAD}", error_description="${kannErweitern ? `Dafür braucht der Zugang ${noetig}.` : `Deine Rolle erlaubt ${noetig} nicht; das lässt sich über diese Verbindung nicht erweitern.`}"`);
        return c.json({ jsonrpc: '2.0', error: { code: -32003, message: kannErweitern ? `Dem Zugang fehlt der Scope ${noetig}.` : `Deine Rolle erlaubt ${noetig} nicht.` }, id: (r as { id?: unknown }).id ?? null }, 403);
      }
    }
    return bearbeiteMcp(kern, nurUser(user), c.req.raw, version, {
      scopes: treffer.eintrag.scopes,
      vorFrage: () => kiBudget(nurUser(user), 'frage'),
      nurLesen: betrieb.modus === 'nur_lesen',
      kennzeichne: mitKennzeichnung,
      ohneKi: (frage, r, s) => ohneKi(nurUser(user), frage, r, s),
      produktName: config.produktName,
      agent: treffer.eintrag.agent ?? (treffer.eintrag.art === 'oauth_zugriff' ? treffer.eintrag.clientId : null),
    });
  });

  // ---------- API: CSRF und Sitzung ----------
  const FREI_BEI_PASSWORTPFLICHT = new Set(['/api/ich', '/api/ich/passwort', '/api/logout']);
  /** Sitzung aus dem Cookie prüfen (auch für die OAuth-Seiten). */
  const sitzungPruefen = async (c: Context): Promise<{ user: BenutzerDetail; sitzung: string } | null> => {
    const t = tokenAusCookie(c);
    const treffer = t ? zugang.pruefe(t, { art: 'sitzung' }) : null;
    const user = treffer ? await nutzerNachId(treffer.eintrag.userId) : null;
    if (!treffer || !user) return null;
    // M3: zugangsStand hat sich seit der Anmeldung geändert (Passwortwechsel, auch direkt in core) → Sitzung ungültig.
    const alt = stand.get(treffer.eintrag.id);
    if (alt !== undefined && typeof user.zugangsStand === 'number' && user.zugangsStand !== alt) {
      zugang.widerrufe({ ...nurUser(user), rollen: ['admin'] }, treffer.eintrag.id);
      stand.delete(treffer.eintrag.id);
      return null;
    }
    return { user, sitzung: treffer.eintrag.id };
  };
  /** Anmeldung mit Konto-Sperre und IP-Bremse; setzt bei Erfolg das Cookie. */
  const anmelden = async (c: Context, name: string, passwort: string): Promise<{ user: User; d: BenutzerDetail | null } | { fehler: string; status: number; warten?: number }> => {
    const ip = clientIp(c);
    const warten = Math.max(kontoSperre.gesperrt(name), loginLimitIp.wartezeit(ip));
    if (warten > 0) {
      prot(c, 'sperre', null, 'abgelehnt');
      return { fehler: `Zu viele Fehlversuche. Bitte in ${Math.max(1, Math.ceil(warten / 60))} Minuten erneut versuchen.`, status: 429, warten };
    }
    const user = await kern.benutzer.pruefe(name, passwort);
    if (!user) {
      kontoSperre.fehlschlag(name);
      loginLimitIp.zaehle(ip);
      prot(c, 'fehlversuch', null, 'abgelehnt');
      return { fehler: 'Name oder Passwort falsch.', status: 401 };
    }
    kontoSperre.zuruecksetzen(name);
    const u = nurUser(user);
    await setzeSitzung(c, u);
    prot(c, 'anmeldung', u.id);
    return { user: u, d: await nutzerNachId(u.id) };
  };

  // ---------- OAuth 2.1 (v1.4 6.2) ----------
  const coreAbruf = config.fake ? undefined : async (url: string) => {
    const modName = '@kern/core';
    const core = (await import(modName)) as { sichererAbruf?: (u: string, o: object) => Promise<{ status: number; text: () => string; typ: string }> };
    if (typeof core.sichererAbruf !== 'function') throw new Error('sichererAbruf fehlt');
    return core.sichererAbruf(url, { maxBytes: 10 * 1024, timeoutMs: 5000, maxWeiterleitungen: 0, headers: { accept: 'application/json' } });
  };
  const grenzeOauth = grenze(64 * 1024);
  app.use('/oauth/*', grenzeOauth);
  const oauth = oauthRouten({
    app: app as unknown as Hono, kern, config, zugang, basisUrl,
    sitzungsNutzer: async (c) => { const s = await sitzungPruefen(c); return s ? { user: nurUser(s.user), sitzung: s.sitzung } : null; },
    anmelden: async (c, n, p) => { const r = await anmelden(c, n, p); return 'fehler' in r ? r : { user: r.user }; },
    prot: (c, e, b, er, z) => prot(c, e, b, er, z),
    ip: clientIp,
    abruf: opt.abruf ?? coreAbruf,
  });
  void oauth;

  app.use('/api/*', async (c, next) => {
    const methode = c.req.method;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(methode)) {
      if (!c.req.header(CSRF_HEADER)) return c.json({ fehler: `Header "${CSRF_HEADER}" fehlt (CSRF-Schutz).` }, 403);
    }
    if (c.req.path === '/api/login') return next();
    const s = await sitzungPruefen(c);
    if (!s) return c.json({ fehler: 'Nicht angemeldet.' }, 401);
    const user = s.user;
    const treffer = { eintrag: { id: s.sitzung } };
    if (user.mussPasswortAendern && !FREI_BEI_PASSWORTPFLICHT.has(c.req.path)) {
      return c.json({ fehler: 'Bitte zuerst ein neues Passwort setzen.', code: 'passwort_aendern' }, 403);
    }
    const w = apiMinute.nimm(user.id);
    if (w) return zuViele(c, w, 'Zu viele Anfragen. Bitte kurz warten.');
    c.set('user', nurUser(user));
    c.set('sitzung' as never, treffer.eintrag.id as never);
    return next();
  });

  const json = async <T>(c: Context, schema: z.ZodType<T>): Promise<T> => {
    let roh: unknown;
    try {
      roh = await c.req.json();
    } catch {
      throw ungueltig('Anfrage muss JSON sein.');
    }
    const r = schema.safeParse(roh);
    if (!r.success) throw ungueltig(r.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; '));
    return r.data;
  };

  app.post('/api/login', async (c) => {
    const { name, passwort } = await json(c, z.object({ name: z.string().min(1).max(100), passwort: z.string().min(1).max(500) }));
    const r = await anmelden(c, name, passwort);
    if ('fehler' in r) return r.warten ? zuViele(c, r.warten, r.fehler) : c.json({ fehler: r.fehler }, r.status as 401);
    return c.json({ benutzer: r.user, mussPasswortAendern: !!r.d?.mussPasswortAendern });
  });

  app.post('/api/logout', (c) => {
    const id = c.get('sitzung' as never) as unknown as string | undefined;
    if (id) zugang.widerrufe(c.get('user'), id);
    prot(c, 'abmeldung', c.get('user').id);
    loescheCookies(c);
    return c.json({ ok: true });
  });

  app.get('/api/ich', async (c) => {
    const u = c.get('user');
    const d = await nutzerNachId(u.id);
    return c.json({
      benutzer: u,
      betrieb: config.kern.betrieb,
      sprache: config.kern.sprache,
      provider: config.kern.provider.art,
      hinweis: config.kern.provider.art === 'mock' ? 'Es ist keine KI angebunden (Testmodus). Antworten kommen aus einer einfachen Vorlage.' : null,
      mussPasswortAendern: !!d?.mussPasswortAendern,
      darf: { hinzufuegen: darf(u, 'hinzufuegen'), vorschlagen: darf(u, 'vorschlagen'), entscheiden: darf(u, 'entscheiden'), verwalten: darf(u, 'verwalten') },
    });
  });

  // ---------- M3: eigenes Konto (Passwort, Geräte, Tokens) ----------
  app.post('/api/ich/passwort', async (c) => {
    const u = c.get('user');
    const b = await json(c, z.object({ alt: z.string().min(1).max(500), neu: z.string().min(10, 'Neues Passwort: mindestens 10 Zeichen').max(500) }));
    if (b.alt === b.neu) throw ungueltig('Das neue Passwort muss sich vom bisherigen unterscheiden.');
    const w = kontoSperre.gesperrt(u.name);
    if (w) return zuViele(c, w, 'Zu viele Fehlversuche. Bitte später erneut versuchen.');
    if (!(await kern.benutzer.pruefe(u.name, b.alt))) {
      kontoSperre.fehlschlag(u.name);
      prot(c, 'passwort_geaendert', u.id, 'abgelehnt');
      throw keineRechte('Das bisherige Passwort stimmt nicht.');
    }
    if (typeof kern.benutzer.aendere === 'function') await kern.benutzer.aendere(u.id, { passwort: b.neu, mussPasswortAendern: false });
    else if (typeof kern.benutzer.aenderePasswort === 'function') await kern.benutzer.aenderePasswort(u.id, b.alt, b.neu);
    else throw new KernFehler(501, 'Diese core-Version kann Passwörter noch nicht ändern.');
    // Alle Sitzungen und Tokens enden (core tut das auch; doppelt schadet nicht), dann neue Sitzung für dieses Gerät.
    zugang.widerrufeAlle(u, u.id);
    await setzeSitzung(c, u);
    prot(c, 'passwort_geaendert', u.id);
    return c.json({ ok: true });
  });

  app.post('/api/ich/abmelden-ueberall', async (c) => {
    const u = c.get('user');
    const n = zugang.widerrufeAlle(u, u.id);
    prot(c, 'abmeldung_ueberall', u.id);
    loescheCookies(c);
    return c.json({ ok: true, beendet: n });
  });

  const tokenAnsicht = (e: TokenEintrag) => ({ id: e.id, art: e.art, bezeichnung: e.bezeichnung, geraet: e.geraet, scopes: e.scopes, erstellt: e.erstellt, laeuftAb: e.laeuftAb, zuletzt: e.zuletzt });
  const TOKEN_ARTEN = ['mcp', 'api', 'oauth_zugriff', 'oauth_erneuerung'] as const;

  app.get('/api/ich/geraete', (c) => {
    const u = c.get('user');
    const aktuell = c.get('sitzung' as never) as unknown as string;
    return c.json(zugang.liste(u, u.id, { art: ['sitzung'] }).map((e) => ({ id: e.id, geraet: e.geraet, erstellt: e.erstellt, zuletzt: e.zuletzt, aktuell: e.id === aktuell })));
  });
  app.delete('/api/ich/geraete/:id', (c) => {
    const u = c.get('user');
    const id = c.req.param('id');
    const e = zugang.liste(u, u.id, { art: ['sitzung'] }).find((x) => x.id === id);
    if (!e || !zugang.widerrufe(u, id)) throw nichtGefunden('Gerät nicht gefunden.');
    prot(c, 'geraet_abgemeldet', u.id, 'ok', id);
    if (id === (c.get('sitzung' as never) as unknown as string)) loescheCookies(c);
    return c.json({ ok: true });
  });

  // v1.4 6.3: Verbundene Apps (OAuth-Clients mit Zugängen des Nutzers).
  app.get('/api/ich/apps', (c) => {
    const u = c.get('user');
    const je = new Map<string, { clientId: string; name: string; scopes: Set<string>; erstellt: string; zuletzt: string | null; anbieter: string | null }>();
    for (const e of zugang.liste(u, u.id, { art: ['oauth_zugriff', 'oauth_erneuerung'] })) {
      const id = e.clientId ?? e.id;
      const x = je.get(id) ?? { clientId: id, name: e.agent ?? e.bezeichnung.replace(/^OAuth /, ''), scopes: new Set<string>(), erstellt: e.erstellt, zuletzt: null, anbieter: /^https:\/\//.test(id) ? new URL(id).hostname : null };
      e.scopes.forEach((s) => x.scopes.add(s));
      if (e.erstellt < x.erstellt) x.erstellt = e.erstellt;
      if (e.zuletzt && (!x.zuletzt || e.zuletzt > x.zuletzt)) x.zuletzt = e.zuletzt;
      je.set(id, x);
    }
    return c.json([...je.values()].map((x) => ({ ...x, scopes: [...x.scopes], zuletzt: x.zuletzt?.slice(0, 10) ?? null })));
  });
  app.delete('/api/ich/apps/:clientId', (c) => {
    const u = c.get('user');
    const id = c.req.param('clientId');
    const n = zugang.widerrufeAlle(u, u.id, { art: ['oauth_zugriff', 'oauth_erneuerung'], clientId: id });
    if (!n) throw nichtGefunden('App nicht gefunden.');
    prot(c, 'oauth_widerruf', u.id, 'ok', id.slice(0, 200));
    return c.json({ ok: true, widerrufen: n });
  });

  const tokenSchema = z.object({
    bezeichnung: z.string().trim().max(80).default('MCP'),
    scopes: z.array(z.enum(ALLE_SCOPES as unknown as [Scope, ...Scope[]])).min(1).max(5).default(['kern:lesen', 'kern:fragen']),
    gueltigTage: z.number().int().min(1).max(365).default(90),
    geraet: z.string().trim().max(120).optional(),
  });
  const erzeugeToken: KernApp['erzeugeToken'] = (u, o = {}) => {
    const scopes = o.scopes ?? ['kern:lesen', 'kern:fragen'];
    if (scopes.includes('kern:verwalten') && !u.rollen.includes('admin')) throw keineRechte('Scope kern:verwalten nur für Admins.');
    const tage = o.gueltigTage ?? 90;
    if (!Number.isInteger(tage) || tage < 1 || tage > 365) throw ungueltig('Gültigkeit: 1 bis 365 Tage.');
    return zugang.erzeuge(u, { art: 'mcp', bezeichnung: o.bezeichnung ?? 'MCP', scopes, gueltigSek: tage * 86400 });
  };
  app.get('/api/ich/tokens', (c) => {
    const u = c.get('user');
    return c.json(zugang.liste(u, u.id, { art: [...TOKEN_ARTEN] }).map(tokenAnsicht));
  });
  app.post('/api/ich/tokens', async (c) => {
    const u = c.get('user');
    const b = await json(c, tokenSchema);
    const { token, eintrag } = zugang.erzeuge(u, { art: 'mcp', bezeichnung: b.bezeichnung, geraet: b.geraet, scopes: b.scopes, gueltigSek: b.gueltigTage * 86400 });
    if (b.scopes.includes('kern:verwalten') && !u.rollen.includes('admin')) { zugang.widerrufe(u, eintrag.id); throw keineRechte('Scope kern:verwalten nur für Admins.'); }
    prot(c, 'zugang_erzeugt', u.id, 'ok', eintrag.id);
    return c.json({ token, eintrag: tokenAnsicht(eintrag), hinweis: 'Das Token wird nur jetzt angezeigt. Sicher aufbewahren.' }, 201);
  });
  app.delete('/api/ich/tokens/:tid', (c) => {
    const u = c.get('user');
    const id = c.req.param('tid');
    if (!zugang.liste(u, u.id, { art: [...TOKEN_ARTEN] }).some((e) => e.id === id) || !zugang.widerrufe(u, id)) throw nichtGefunden('Token nicht gefunden.');
    prot(c, 'zugang_widerrufen', u.id, 'ok', id);
    return c.json({ ok: true });
  });

  // ---------- Wissen ----------
  const restPfad = (c: Context, praefix: string): string => {
    const roh = new URL(c.req.url).pathname.slice(praefix.length);
    const p = dekodiereUrlPfad(roh);
    if (p === null) throw nichtGefunden();
    return p;
  };

  app.get('/api/wissen', async (c) => {
    const gruppe = c.req.query('gruppe') || undefined;
    return c.json(await kern.listeWissen(c.get('user'), gruppe ? { gruppe } : undefined));
  });

  app.get('/api/wissen/*', async (c) => {
    let rest = restPfad(c, '/api/wissen/');
    const istVerlauf = rest.endsWith('/verlauf');
    if (istVerlauf) rest = rest.slice(0, -'/verlauf'.length);
    const p = artikelPfad(rest);
    if (!p) throw nichtGefunden();
    const artikel = await kern.leseArtikel(c.get('user'), p); // Rechteprüfung auch für den Verlauf
    if (istVerlauf) return c.json(await kern.verlauf(artikel.pfad));
    return c.json(artikel);
  });

  // ---------- Quellen ----------
  app.get('/api/quellen', async (c) => {
    const sammlung = c.req.query('sammlung') || undefined;
    return c.json(await kern.listeQuellen(c.get('user'), sammlung ? { sammlung } : undefined));
  });

  app.get('/api/quellen/*', async (c) => {
    let rest = restPfad(c, '/api/quellen/');
    const istOriginal = rest.endsWith('/original');
    if (istOriginal) rest = rest.slice(0, -'/original'.length);
    const p = quellenPfad(rest);
    if (!p) throw nichtGefunden();
    const quelle = await leseQuelle(kern, c.get('user'), p);
    if (!istOriginal) return c.json(quelle);
    let datei: string | null = null;
    let anzeigeName: string | null = null;
    if (typeof kern.original === 'function') {
      const o = await kern.original(c.get('user'), quelle.pfad);
      // Auch der Pfad aus core muss im Datenordner liegen.
      const rel = o ? path.relative(config.dataDir, o.datei).split(path.sep).join('/') : null;
      datei = rel ? sicherVerbinden(config.dataDir, rel) : null;
      anzeigeName = o?.name ?? null;
    } else {
      datei = await findeOriginal(config.dataDir, quelle.pfad, quelle.kopf as Record<string, unknown>);
    }
    if (!datei || !fs.existsSync(datei)) throw nichtGefunden('Zu dieser Quelle gibt es keine Originaldatei.');
    const ext = path.extname(datei).toLowerCase();
    const name = sicherDateiname(anzeigeName ?? String(quelle.kopf.herkunft || path.basename(datei)));
    const inhalt = await fsp.readFile(datei);
    return new Response(inhalt, {
      headers: {
        'Content-Type': ext === '.html' || ext === '.svg' || ext === '.htm' ? 'application/octet-stream' : (MIME[ext] ?? 'application/octet-stream'),
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    });
  });

  // ---------- Suche und Frage ----------
  app.get('/api/suche', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) throw ungueltig('Suchbegriff fehlt (q).');
    if (q.length > 500) throw ungueltig('Suchbegriff zu lang.');
    const r = reichweiteSchema.safeParse(c.req.query('reichweite') || undefined);
    if (!r.success) throw ungueltig('reichweite: ich, team oder betrieb');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    return c.json(await kern.suche(c.get('user'), q, { reichweite: r.data, sammlung: c.req.query('sammlung') || undefined, limit }));
  });

  app.post('/api/frage', async (c) => {
    const b = await json(c, z.object({ frage: z.string().trim().min(1).max(2000), reichweite: reichweiteSchema, sammlung: z.string().max(120).optional() }));
    if (betrieb.modus === 'nur_lesen') return c.json(await ohneKi(c.get('user'), b.frage, b.reichweite, b.sammlung));
    kiBudget(c.get('user'), 'frage');
    return c.json(mitKennzeichnung(await kern.frage(c.get('user'), b.frage, { reichweite: b.reichweite, sammlung: b.sammlung })));
  });

  // ---------- Hinzufügen ----------
  const hinzuSchema = z.object({
    art: z.enum(['datei', 'text', 'web', 'audio', 'notiz']).optional(),
    titel: z.string().max(300).optional(),
    inhalt: z.string().max(5_000_000).optional(),
    url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), 'Nur http(s)-Adressen.').optional(),
    sammlung: z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N}_ -]+$/u, 'Sammlung: nur Buchstaben, Ziffern, Leerzeichen, - und _').default('allgemein'),
    sichtbarkeit: sichtbarkeitSchema.default('betrieb'),
    beobachten: z.union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', ''])]).optional(),
  });

  app.post(
    '/api/hinzufuegen',
    bodyLimit({ maxSize: config.maxUploadBytes, onError: (c) => c.json({ fehler: `Datei zu groß (höchstens ${Math.round(config.maxUploadBytes / 1048576)} MB).` }, 413) }),
    async (c) => {
      pruefeRecht(c, 'hinzufuegen');
      const user = c.get('user');
      const typ = c.req.header('content-type') ?? '';
      let felder: Record<string, unknown> = {};
      let datei: File | null = null;
      if (typ.startsWith('multipart/form-data')) {
        const body = await c.req.parseBody();
        for (const [k, v] of Object.entries(body)) {
          if (k === 'datei') {
            if (v instanceof File) datei = v;
          } else if (typeof v === 'string') felder[k] = v;
        }
      } else if (typ.startsWith('application/json')) {
        felder = (await c.req.json().catch(() => null)) ?? {};
      } else throw new KernFehler(415, 'Erwartet multipart/form-data oder JSON.');
      const r = hinzuSchema.safeParse(felder);
      if (!r.success) throw ungueltig(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const f = r.data;
      const beobachten = f.beobachten === true || f.beobachten === 'true' || f.beobachten === '1' || f.beobachten === 'on';
      const art = datei ? (f.art === 'audio' ? 'audio' : 'datei') : (f.art ?? (f.url ? 'web' : 'text'));
      if ((art === 'datei' || art === 'audio') && !datei) throw ungueltig('Datei fehlt (Feld "datei").');
      if (art === 'web' && !f.url) throw ungueltig('URL fehlt.');
      if ((art === 'text' || art === 'notiz') && !f.inhalt?.trim()) throw ungueltig('Inhalt fehlt.');
      if (f.sichtbarkeit.startsWith('team:') && !user.rollen.includes('admin') && !user.teams.includes(f.sichtbarkeit.slice(5))) {
        throw keineRechte('Du bist nicht in diesem Team.');
      }
      const sp = betrieb.grenzen.speicher_max_bytes;
      if (sp !== null && betrieb.speicherBytes() >= sp) throw Object.assign(new KernFehler(429, 'Der Speicher eures Pakets ist voll. Suche und Wissen laufen weiter.', 'kontingent'), { grund: 'speicher' });
      const wu = uploadsMinute.nimm(user.id);
      if (wu) throw Object.assign(new KernFehler(429, 'Zu viele Uploads in kurzer Zeit.', 'zu_viele'), { retryAfter: wu });
      if (config.kern.provider.art !== 'mock') kiBudget(user, 'ki'); // Hinzufügen kompiliert mit der KI
      let tmpOrdner: string | null = null;
      try {
        let dateiPfad: string | undefined;
        if (datei) {
          if (datei.size > Math.min(config.maxUploadBytes, betrieb.grenzen.upload_max_bytes ?? Infinity)) throw new KernFehler(413, 'Datei zu groß.');
          tmpOrdner = path.join(config.dataDir, '.kern', 'upload', crypto.randomBytes(8).toString('hex'));
          await fsp.mkdir(tmpOrdner, { recursive: true });
          dateiPfad = path.join(tmpOrdner, sicherDateiname(datei.name));
          await fsp.writeFile(dateiPfad, Buffer.from(await datei.arrayBuffer()));
        }
        const ergebnis = await kern.fuegeHinzu(user, {
          art, titel: f.titel || undefined, inhalt: f.inhalt, url: f.url, dateiPfad,
          sammlung: f.sammlung, sichtbarkeit: f.sichtbarkeit as Sichtbarkeit, beobachten,
        });
        return c.json(ergebnis, 201);
      } finally {
        if (tmpOrdner) await fsp.rm(tmpOrdner, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  // ---------- Eingang und Vorschläge ----------
  app.get('/api/eingang', async (c) => c.json(await kern.eingang(c.get('user'))));

  app.post('/api/eingang/:id', async (c) => {
    pruefeRecht(c, 'entscheiden');
    const id = c.req.param('id');
    if (!ID_MUSTER.test(id)) throw nichtGefunden('Vorschlag nicht gefunden.');
    const b = await json(c, z.object({
      aktion: z.enum(['freigeben', 'ablehnen', 'aendern']),
      begruendung: z.string().max(2000).optional(),
      neuerText: z.string().max(5_000_000).optional(),
    }).refine((x) => x.aktion !== 'aendern' || typeof x.neuerText === 'string', { message: 'Bei "aendern" ist neuerText Pflicht.' }));
    const user = c.get('user');
    // v1.2: Regeln (wissen/_regeln/) darf nur admin freigeben.
    if (!user.rollen.includes('admin') && b.aktion !== 'ablehnen') {
      const v = typeof kern.leseVorschlag === 'function'
        ? await kern.leseVorschlag(user, id)
        : (await kern.eingang(user)).find((x) => x.id === id);
      if (v && v.ziel.startsWith(REGEL_ORDNER)) throw keineRechte('Regeln (wissen/_regeln/) darf nur ein Admin freigeben.');
    }
    const ergebnis = await kern.entscheide(user, id, b);
    if (ergebnis.status === 'konflikt') {
      return c.json({ fehler: 'Die Datei wurde seit dem Vorschlag geändert. Bitte den neuen Vergleich prüfen.', vorschlag: ergebnis }, 409);
    }
    return c.json(ergebnis);
  });

  app.post('/api/vorschlag', async (c) => {
    pruefeRecht(c, 'vorschlagen');
    const b = await json(c, z.object({
      art: z.enum(['neu', 'aenderung', 'loeschung']),
      ziel: z.string().min(1).max(1024),
      alt: z.string().max(5_000_000).nullable().optional(),
      neu: z.string().max(5_000_000),
      grund: z.string().trim().min(3).max(2000),
    }));
    const ziel = artikelPfad(b.ziel);
    if (!ziel) throw ungueltig('Ziel muss ein Pfad unter wissen/ sein.');
    pruefeZiel(ziel, c.get('user'));
    return c.json(await kern.schlageVor(c.get('user'), { art: b.art, ziel, alt: b.alt ?? null, neu: b.neu, grund: b.grund }), 201);
  });

  // ---------- Briefing und Pflege ----------
  app.get('/api/briefing', async (c) => {
    const seit = c.req.query('seit') || undefined;
    if (seit && !/^\d{4}-\d{2}-\d{2}/.test(seit)) throw ungueltig('seit: Datum JJJJ-MM-TT');
    return c.json(await kern.briefing(c.get('user'), seit));
  });
  app.get('/api/faellig', async (c) => c.json(await kern.faellig(c.get('user'))));

  // ---------- Nachtrag v1.1: Fakten und Prüfung ----------
  app.get('/api/fakten', async (c) => {
    if (typeof kern.fakten !== 'function') throw new KernFehler(501, 'Diese core-Version kennt noch keine Faktenschicht.');
    const gueltigAm = c.req.query('gueltig_am') || undefined;
    if (gueltigAm && !/^\d{4}-\d{2}-\d{2}$/.test(gueltigAm)) throw ungueltig('gueltig_am: Datum JJJJ-MM-TT');
    const filter = { art: c.req.query('art') || undefined, gegenstand: c.req.query('gegenstand') || undefined, gueltigAm };
    return c.json(await kern.fakten(c.get('user'), filter));
  });

  app.post('/api/pruefen', async (c) => {
    pruefeRecht(c, 'entscheiden');
    if (typeof kern.pruefe !== 'function') throw new KernFehler(501, 'Diese core-Version kennt noch keine Prüfung.');
    return c.json(await kern.pruefe(c.get('user')));
  });

  // ---------- Einstellungen ----------
  const einstellungenAnsicht = (u: User) => {
    const y = leseKernYaml(config.dataDir);
    const p = config.kern.provider as Record<string, unknown>;
    const admin = u.rollen.includes('admin');
    const yp = ((y.provider ?? y.ki) ?? {}) as Record<string, unknown>;
    return {
      betrieb: config.kern.betrieb,
      sprache: config.kern.sprache,
      teams: Array.isArray(y.teams) ? y.teams : [],
      // P2 (N6): KI-Endpunkt und Modelle nur für Admins.
      provider: {
        art: p.art,
        url: admin ? (p.url ?? null) : null,
        endpunkt: admin ? (p.url ?? null) : null,
        chatModell: admin ? (p.chatModell ?? null) : null,
        embedModell: admin ? (p.embedModell ?? null) : null,
        anbieter: config.modus === 'managed' && typeof yp.anbieter === 'string' ? yp.anbieter : null,
        apiKeyGesetzt: typeof p.apiKey === 'string' && p.apiKey.length > 0,
      },
      managed: config.modus === 'managed',
      anbieterListe: config.modus === 'managed' ? config.anbieter.map((a) => ({ id: a.id, name: a.name, art: a.art, region: a.region ?? null })) : [],
      ki_schluessel_gespeichert: admin ? new Geheimnisse(config.dataDir, config.geheimnisSchluessel).namen() : [],
      ki_schluessel_moeglich: !!config.geheimnisSchluessel && config.geheimnisSchluessel.length >= 32,
      upload_max_mb: Math.round(config.maxUploadBytes / 1048576),
      fake: config.fake,
      version,
    };
  };

  app.get('/api/einstellungen', (c) => c.json(einstellungenAnsicht(c.get('user'))));

  /** Entfernt Endpunkte aus einer Datenweg-Antwort für Nicht-Admins (Region und Ort bleiben sichtbar). */
  const ohneEndpunkte = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(ohneEndpunkte);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, /^(endpunkt|url|basisUrl|host)$/i.test(k) ? (v ? '(nur für Admins sichtbar)' : v) : ohneEndpunkte(v)]));
    }
    return x;
  };

  // v1.2 (F13): Datenweg der KI
  app.get('/api/datenweg', async (c) => {
    const d = typeof kern.datenweg === 'function' ? await kern.datenweg(c.get('user')) : bauDatenweg(config.kern.provider);
    return c.json(c.get('user').rollen.includes('admin') ? d : ohneEndpunkte(d));
  });

  // H2: Selbstbetrieb: freie Adresse erlaubt (mit Warnung), apiKeyEnv nur aus der Erlaubnisliste.
  // Managed: nur `mock` oder ein Anbieter aus der HD-Liste, keine Adresse, kein apiKeyEnv.
  const providerSelbst = z.object({
    art: z.enum(['mock', 'ollama', 'openai', 'anthropic']),
    url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Nur http(s)-Adressen.').optional(),
    chatModell: z.string().max(200).optional(),
    embedModell: z.string().max(200).optional(),
    apiKeyEnv: z.string().regex(ERLAUBTE_KEY_ENV, 'apiKeyEnv: nur KERN_PROVIDER_KEY oder KERN_PROVIDER_KEY_<NAME>').optional(),
  }).strict();
  const providerManaged = z.object({
    art: z.enum(['mock', 'ollama', 'openai', 'anthropic']).optional(),
    anbieter: z.string().max(40).optional(),
    chatModell: z.string().max(200).optional(),
    embedModell: z.string().max(200).optional(),
  }).strict().refine((p) => p.art === 'mock' || (p.anbieter && config.anbieter.some((a) => a.id === p.anbieter)), 'Managed-Betrieb: nur ein Anbieter aus der Liste (anbieter: <id>) oder art "mock".');

  app.put('/api/einstellungen', async (c) => {
    pruefeRecht(c, 'verwalten');
    const b = await json(c, z.object({
      betrieb: z.string().trim().min(1).max(120).optional(),
      sprache: z.enum(['de', 'en']).optional(),
      teams: z.array(z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N}_ -]+$/u)).max(100).optional(),
      provider: (config.modus === 'managed' ? providerManaged : providerSelbst).optional(),
    }).strict());
    let provider: Record<string, unknown> | undefined = b.provider as Record<string, unknown> | undefined;
    if (provider && config.modus === 'managed') {
      const e = config.anbieter.find((a) => a.id === provider!.anbieter);
      provider = provider.art === 'mock' && !e ? { art: 'mock' } : { art: e!.art, anbieter: e!.id, ...(provider.chatModell ? { chatModell: provider.chatModell } : {}), ...(provider.embedModell ? { embedModell: provider.embedModell } : {}) };
    }
    const warnungen: string[] = [];
    if (provider && config.modus === 'selbst' && provider.url) {
      let host = '';
      try { host = new URL(String(provider.url)).host; } catch { /* oben geprüft */ }
      warnungen.push(`Freier KI-Endpunkt ${host}: Fragen und Abschnitte${provider.apiKeyEnv ? ' sowie der Schlüssel aus ' + String(provider.apiKeyEnv) : ''} gehen dorthin. Nur im Selbstbetrieb erlaubt.`);
    }
    if (typeof kern.speichereEinstellungen === 'function') {
      // core schreibt kern.yaml und committet; der KI-Anbieter heißt dort "ki".
      const aenderung: Record<string, unknown> = {};
      if (b.betrieb) aenderung.betrieb = b.betrieb;
      if (b.sprache) aenderung.sprache = b.sprache;
      if (b.teams) aenderung.teams = b.teams;
      if (provider) aenderung.ki = provider;
      await kern.speichereEinstellungen(c.get('user'), aenderung);
    } else {
      const y = leseKernYaml(config.dataDir);
      if (b.betrieb) y.betrieb = b.betrieb;
      if (b.sprache) y.sprache = b.sprache;
      if (b.teams) y.teams = b.teams;
      if (provider) { y.provider = provider; delete y.ki; }
      schreibeKernYaml(config.dataDir, y);
    }
    if (b.betrieb) config.kern.betrieb = b.betrieb;
    if (b.sprache) config.kern.sprache = b.sprache;
    prot(c, 'einstellungen', c.get('user').id);
    return c.json({ ...einstellungenAnsicht(c.get('user')), warnungen, hinweis: provider ? 'Der KI-Anbieter wird nach einem Neustart des Servers aktiv. API-Schlüssel nur per Umgebungsvariable.' : null });
  });

  // D-L5: Sicherheitsprotokoll, nur admin.
  app.get('/api/sicherheitsprotokoll', (c) => {
    pruefeRecht(c, 'verwalten');
    const seit = c.req.query('seit') || undefined;
    if (seit && !/^\d{4}-\d{2}-\d{2}/.test(seit)) throw ungueltig('seit: Datum JJJJ-MM-TT');
    return c.json(protokoll.lies(seit));
  });

  // M6: endgültiges Löschen (Art. 17 DSGVO), nur admin, mit Bestätigung (Pfad noch einmal).
  app.post('/api/loeschen-endgueltig', async (c) => {
    pruefeRecht(c, 'verwalten');
    const b = await json(c, z.object({ pfad: z.string().min(1).max(1024), bestaetigung: z.string().min(1).max(1024), grund: z.string().trim().min(3).max(500).default('Löschung auf Anfrage') }));
    if (b.bestaetigung !== b.pfad) throw ungueltig('Bestätigung: bitte den Pfad noch einmal genau eingeben.');
    if (typeof kern.loescheEndgueltig !== 'function') throw new KernFehler(501, 'Diese core-Version kann noch nicht endgültig löschen.');
    const r = await kern.loescheEndgueltig(c.get('user'), b.pfad, b.grund);
    prot(c, 'loeschen_endgueltig', c.get('user').id);
    return c.json({ ...r, hinweis: 'Aus Arbeitsstand und Verlauf entfernt. Backups laufen nach höchstens 12 Monaten aus; Einbettungen beim KI-Anbieter sind nicht mehr verknüpft.' });
  });

  // v1.4 5.2: KI-Schlüssel nur schreiben, nie zurückgeben; Managed nur für Anbieter der Liste (H2).
  const geheimnisse = new Geheimnisse(config.dataDir, config.geheimnisSchluessel);
  app.put('/api/einstellungen/ki-schluessel', async (c) => {
    pruefeRecht(c, 'verwalten');
    const b = await json(c, z.object({ anbieter: z.string().regex(/^[a-z0-9_-]{1,40}$/), schluessel: z.string().min(8).max(500) }).strict());
    if (!geheimnisse.verfuegbar) throw new KernFehler(409, 'Schlüssel können hier nur per Umgebungsvariable gesetzt werden (KERN_PROVIDER_KEY…), weil KERN_GEHEIMNIS_SCHLUESSEL fehlt.', 'nicht_eingerichtet');
    if (config.modus === 'managed' && !config.anbieter.some((a) => a.id === b.anbieter)) throw ungueltig('Managed-Betrieb: Schlüssel nur für einen Anbieter aus der Liste.');
    if (config.modus === 'selbst' && b.anbieter !== 'eigen' && !config.anbieter.some((a) => a.id === b.anbieter)) throw ungueltig('anbieter: "eigen" für den eigenen Endpunkt.');
    geheimnisse.setze(b.anbieter, b.schluessel);
    prot(c, 'ki_schluessel', c.get('user').id, 'ok', b.anbieter);
    return c.json({ ok: true, anbieter: b.anbieter, hatSchluessel: true, hinweis: 'Gespeichert (verschlüsselt). Wirksam nach einem Neustart. Nach einem Umzug neu eingeben.' });
  });
  app.delete('/api/einstellungen/ki-schluessel/:anbieter', (c) => {
    pruefeRecht(c, 'verwalten');
    if (!geheimnisse.loesche(c.req.param('anbieter'))) throw nichtGefunden('Kein Schlüssel gespeichert.');
    prot(c, 'ki_schluessel', c.get('user').id, 'ok', c.req.param('anbieter'));
    return c.json({ ok: true });
  });

  // v1.4 3.5: Konto-Brücke zum Leitstand (nur admin). Selbstbetrieb ohne KERN_LEITSTAND_URL: 404, die UI blendet aus.
  const KONTO_AKTIONEN = new Set(['kaufen', 'stufe', 'kuendigen', 'kuendigung-zuruecknehmen', 'test-verlaengern', 'loeschen', 'umzug', 'egress-anfrage']);
  const leitstand = async (methode: 'GET' | 'POST', pfad: string, body?: unknown, idem?: string) => {
    const r = await fetch(`${config.leitstandUrl}/v1/konto${pfad}`, {
      method: methode,
      headers: { authorization: `Bearer ${config.kontoToken}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    const text = (await r.text()).slice(0, 64 * 1024);
    let daten: unknown = null;
    try { daten = text ? JSON.parse(text) : null; } catch { daten = { fehler: 'Antwort des Leitstands ist kein JSON.' }; }
    return { status: r.status, daten };
  };
  app.get('/api/konto', async (c) => {
    pruefeRecht(c, 'verwalten');
    if (!config.leitstandUrl || !config.kontoToken) throw nichtGefunden('Kein Konto: Selbstbetrieb.');
    try {
      const r = await leitstand('GET', '');
      return c.json(r.daten as object, (r.status >= 200 && r.status < 600 ? r.status : 502) as 200);
    } catch { throw new KernFehler(502, 'Der Leitstand ist gerade nicht erreichbar. Export und Wissen laufen weiter.'); }
  });
  app.post('/api/konto/:aktion', async (c) => {
    pruefeRecht(c, 'verwalten');
    if (!config.leitstandUrl || !config.kontoToken) throw nichtGefunden('Kein Konto: Selbstbetrieb.');
    const aktion = c.req.param('aktion');
    if (!KONTO_AKTIONEN.has(aktion)) throw nichtGefunden('Unbekannte Aktion.');
    const body = await c.req.json().catch(() => ({}));
    const idem = /^[A-Za-z0-9_-]{8,80}$/.test(c.req.header('idempotency-key') ?? '') ? c.req.header('idempotency-key')! : crypto.randomUUID();
    try {
      const r = await leitstand('POST', `/${aktion}`, body, idem);
      prot(c, 'einstellungen', c.get('user').id, r.status < 400 ? 'ok' : 'abgelehnt', `konto:${aktion}`);
      return c.json(r.daten as object, (r.status >= 200 && r.status < 600 ? r.status : 502) as 200);
    } catch { throw new KernFehler(502, 'Der Leitstand ist gerade nicht erreichbar.'); }
  });

  // ---------- Benutzer und Tokens ----------
  app.get('/api/benutzer', async (c) => {
    pruefeRecht(c, 'verwalten');
    const ich = c.get('user');
    const liste = await kern.benutzer.liste();
    return c.json(liste.map((u) => ({ ...u, tokens: zugang.liste(ich, u.id, { art: [...TOKEN_ARTEN] }).length })));
  });

  app.post('/api/benutzer', async (c) => {
    pruefeRecht(c, 'verwalten');
    const b = await json(c, z.object({
      name: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}._@-]+$/u, 'Name: Buchstaben, Ziffern, . _ @ -'),
      passwort: z.string().min(10, 'Passwort: mindestens 10 Zeichen').max(500),
      rollen: z.array(z.enum(ROLLEN as [Rolle, ...Rolle[]])).min(1).default(['leser']),
      teams: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    }));
    if ((await kern.benutzer.liste()).some((u) => u.name.toLowerCase() === b.name.toLowerCase())) throw new KernFehler(409, 'Diesen Namen gibt es schon.');
    const max = betrieb.grenzen.nutzer_max;
    if (max !== null && (await kern.benutzer.liste()).length >= max) throw new KernFehler(409, 'Die Nutzergrenze eures Pakets ist erreicht. Stufe wechseln unter Einstellungen › Konto.', 'kontingent');
    const neu = await kern.benutzer.anlegen(b.name, b.passwort, b.rollen, b.teams);
    prot(c, 'benutzer_angelegt', c.get('user').id, 'ok', neu.id);
    return c.json(neu, 201);
  });

  /** Zielbenutzer: man selbst oder (nur Admin) ein anderer. */
  const benutzerZiel = async (c: Context<Env>): Promise<User> => {
    const id = c.req.param('id') ?? '';
    const ich = c.get('user');
    if (id === ich.id) return ich;
    if (!darf(ich, 'verwalten')) throw keineRechte();
    const ziel = await nutzerNachId(id);
    if (!ziel) throw nichtGefunden('Benutzer nicht gefunden.');
    return nurUser(ziel);
  };

  app.get('/api/benutzer/:id/tokens', async (c) => c.json(zugang.liste(c.get('user'), (await benutzerZiel(c)).id, { art: [...TOKEN_ARTEN] }).map(tokenAnsicht)));
  // M2: Tokens nur für sich selbst. Für andere: 404, auch für Admins (Admins dürfen nur widerrufen).
  app.post('/api/benutzer/:id/tokens', async (c) => {
    const ich = c.get('user');
    if (c.req.param('id') !== ich.id) throw nichtGefunden('Tokens kann nur jeder für sich selbst anlegen.');
    const b = await json(c, tokenSchema);
    const { token, eintrag } = erzeugeToken(ich, { bezeichnung: b.bezeichnung, scopes: b.scopes, gueltigTage: b.gueltigTage });
    prot(c, 'zugang_erzeugt', ich.id, 'ok', eintrag.id);
    return c.json({ token, eintrag: tokenAnsicht(eintrag), hinweis: 'Das Token wird nur jetzt angezeigt. Sicher aufbewahren.' }, 201);
  });
  app.delete('/api/benutzer/:id/tokens/:tid', async (c) => {
    const ziel = await benutzerZiel(c);
    const id = c.req.param('tid');
    if (!zugang.liste(c.get('user'), ziel.id, { art: [...TOKEN_ARTEN] }).some((e) => e.id === id) || !zugang.widerrufe(c.get('user'), id)) throw nichtGefunden('Token nicht gefunden.');
    prot(c, 'zugang_widerrufen', c.get('user').id, 'ok', id);
    return c.json({ ok: true });
  });
  app.delete('/api/benutzer/:id/tokens', async (c) => {
    const ziel = await benutzerZiel(c);
    const n = zugang.widerrufeAlle(c.get('user'), ziel.id, { art: [...TOKEN_ARTEN] });
    prot(c, 'zugang_widerrufen', c.get('user').id, 'ok', ziel.id);
    return c.json({ ok: true, widerrufen: n });
  });

  // M3: Zurücksetzen durch den Admin: Einmalpasswort, Pflicht zum Wechsel, alle Sitzungen und Tokens enden.
  app.post('/api/benutzer/:id/passwort-zuruecksetzen', async (c) => {
    pruefeRecht(c, 'verwalten');
    const ziel = await benutzerZiel(c);
    if (ziel.id === c.get('user').id) throw ungueltig('Das eigene Passwort bitte unter „Passwort ändern“ setzen.');
    if (typeof kern.benutzer.aendere !== 'function') throw new KernFehler(501, 'Diese core-Version kann Passwörter noch nicht zurücksetzen.');
    const einmal = crypto.randomBytes(12).toString('base64url');
    await kern.benutzer.aendere(ziel.id, { passwort: einmal, mussPasswortAendern: true });
    zugang.widerrufeAlle(c.get('user'), ziel.id);
    kontoSperre.zuruecksetzen(ziel.name);
    prot(c, 'passwort_zurueckgesetzt', c.get('user').id, 'ok', ziel.id);
    return c.json({ einmalPasswort: einmal, hinweis: 'Nur jetzt sichtbar. Beim nächsten Anmelden muss ein neues Passwort gesetzt werden.' });
  });
  // H3: Konto-Sperre aufheben (Admin).
  app.post('/api/benutzer/:id/entsperren', async (c) => {
    pruefeRecht(c, 'verwalten');
    const ziel = await benutzerZiel(c);
    kontoSperre.zuruecksetzen(ziel.name);
    prot(c, 'entsperrt', c.get('user').id, 'ok', ziel.id);
    return c.json({ ok: true });
  });

  app.all('/api/*', (c) => c.json({ fehler: 'Unbekannter Endpunkt.' }, 404));

  // ---------- Weboberfläche ----------
  // Discovery- und Betriebspfade nie an die HTML-Oberfläche weiterreichen.
  app.all('/.well-known/*', (c) => c.json({ fehler: 'Nicht gefunden.' }, 404));
  app.all('/_betrieb/*', (c) => c.json({ fehler: 'Nicht gefunden.' }, 404));
  app.get('*', async (c) => {
    const index = path.join(config.webDist, 'index.html');
    if (!fs.existsSync(index)) return c.html(hinweisSeite(config), 200);
    const roh = dekodiereUrlPfad(new URL(c.req.url).pathname.replace(/^\/+/, ''));
    if (roh) {
      const datei = sicherVerbinden(config.webDist, roh);
      if (datei && fs.existsSync(datei) && fs.statSync(datei).isFile()) {
        const ext = path.extname(datei).toLowerCase();
        return new Response(await fsp.readFile(datei), {
          headers: {
            'Content-Type': MIME[ext] ?? 'application/octet-stream',
            'Cache-Control': /\/assets\//.test(datei) ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        });
      }
      // Dateien mit Endung, die es nicht gibt: 404 statt App
      if (/\.[a-z0-9]{1,8}$/i.test(roh)) return c.text('Nicht gefunden.', 404);
    }
    return new Response(await fsp.readFile(index), { headers: { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-cache' } });
  });

  return { app, zugang, zugangAusCore, erzeugeToken };
}

async function findeOriginal(dataDir: string, quellPfad: string, kopf: Record<string, unknown>): Promise<string | null> {
  const ausKopf = typeof kopf.original === 'string' ? kopf.original : null;
  if (ausKopf) {
    const p = sicherVerbinden(dataDir, ausKopf.startsWith('quellen/') ? ausKopf : path.posix.join(path.posix.dirname(quellPfad), ausKopf));
    if (p && fs.existsSync(p)) return p;
  }
  const ordnerRel = path.posix.dirname(quellPfad);
  const slug = path.posix.basename(quellPfad, '.md');
  const ordner = sicherVerbinden(dataDir, ordnerRel);
  if (!ordner || !fs.existsSync(ordner)) return null;
  const name = (await fsp.readdir(ordner)).find((f) => f.startsWith(`${slug}.orig.`));
  return name ? sicherVerbinden(dataDir, `${ordnerRel}/${name}`) : null;
}

function hinweisSeite(config: ServerConfig): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kern</title></head>
<body><main><h1>Kern läuft</h1><p>Die Weboberfläche ist noch nicht gebaut. Erwartet unter: <code>${esc(config.webDist)}</code></p>
<p>Bauen mit <code>npm run build -w packages/web</code>. Die REST-API liegt unter <code>/api</code>, MCP unter <code>/mcp</code>, Zustand unter <code>/healthz</code>.</p></main></body></html>`;
}
