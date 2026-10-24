/**
 * Ein gemeinsamer Zugangsspeicher für Sitzungen, API-/MCP-Tokens und OAuth 2.1 (S1 M2, M3, M5; abgestimmt mit F1).
 * Liegt in `.kern/zugang.sqlite` (nicht in git, nicht der wegwerfbare Index). Gespeichert wird nur der SHA-256 des Tokens;
 * das Token selbst gibt es genau einmal im Klartext. Alle Methoden sind synchron (better-sqlite3).
 */
import Database from 'better-sqlite3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { User } from './types.js';
import { KernFehler } from './types.js';

export type TokenArt = 'sitzung' | 'api' | 'mcp' | 'oauth_zugriff' | 'oauth_erneuerung';
export type Scope = 'kern:lesen' | 'kern:fragen' | 'kern:vorschlagen' | 'kern:bericht' | 'kern:verwalten' | 'kern:freigeben';
export const ALLE_SCOPES: readonly Scope[] = ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht', 'kern:verwalten', 'kern:freigeben'];
const istFreigeber = (u: User) => u.rollen.some((r) => r === 'freigeber' || r === 'admin');
export const TOKEN_ARTEN: readonly TokenArt[] = ['sitzung', 'api', 'mcp', 'oauth_zugriff', 'oauth_erneuerung'];

export interface TokenEintrag {
  id: string;
  userId: string;
  art: TokenArt;
  bezeichnung: string;
  geraet: string | null;
  scopes: Scope[];
  erstellt: string;
  laeuftAb: string | null;
  zuletzt: string | null;
  widerrufen: string | null;
  clientId: string | null;
  /** RFC 8707 resource, z. B. https://host/mcp */
  zielgruppe: string | null;
  /** Erneuerungs-Familie: Wiederverwendung eines alten Erneuerungs-Tokens widerruft die ganze Familie. */
  familie: string | null;
  /** v1.4 6.3: Name des Agenten (bei OAuth der client_name); null = Mensch. */
  agent: string | null;
  /** v1.4 6.3: Einschränkung der Reichweite, nie Erweiterung. */
  reichweite: 'ich' | 'team' | 'betrieb' | null;
}

export interface ErzeugeEingabe {
  art: TokenArt;
  bezeichnung?: string;
  geraet?: string;
  scopes?: Scope[];
  /** Gültigkeit in Sekunden (Pflicht, höchstens 365 Tage; v1.4 M3). Standard je Art aus STANDARD_SEK. */
  gueltigSek?: number;
  clientId?: string;
  zielgruppe?: string;
  familie?: string;
  agent?: string;
  reichweite?: 'ich' | 'team' | 'betrieb';
}
export interface Erwartung { art?: TokenArt | TokenArt[]; scope?: Scope; zielgruppe?: string }
export interface OAuthClient { clientId: string; name: string; redirectUris: string[]; erstellt: string; art: 'dcr' | 'cimd'; zuletzt: string | null }
export interface ZugangExport { format: 'kern-zugang/1'; erstellt: string; tokens: (TokenEintrag & { hash: string })[]; clients: OAuthClient[] }
export interface TokenPaar { zugriff: { token: string; eintrag: TokenEintrag }; erneuerung: { token: string; eintrag: TokenEintrag } }

export const STANDARD_SEK: Record<TokenArt, number> = {
  sitzung: 12 * 3600, api: 90 * 86400, mcp: 90 * 86400, oauth_zugriff: 3600, oauth_erneuerung: 30 * 86400,
};
/** Sitzungen verlängern sich bei Nutzung, aber nie über 7 Tage ab Anmeldung. */
export const SITZUNG_MAX_SEK = 7 * 86400;
/** v1.4 M3: kein Zugang ohne Ablauf, höchstens 365 Tage. */
export const ZUGANG_MAX_SEK = 365 * 86400;
const CODE_SEK = 60;

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const istAdmin = (u: User) => u.rollen.includes('admin');
const istAutor = (u: User) => u.rollen.some((r) => r === 'autor' || r === 'freigeber' || r === 'admin');
/** v1.4 6.3: Mindestrolle je Scope. */
export const scopeErlaubt = (u: User, s: Scope): boolean => s === 'kern:freigeben' ? false : s === 'kern:verwalten' ? istAdmin(u) : s === 'kern:vorschlagen' || s === 'kern:bericht' ? istAutor(u) : true;

interface Zeile {
  id: string; hash: string; user_id: string; art: TokenArt; bezeichnung: string; geraet: string | null; scopes: string;
  erstellt: string; laeuft_ab: string | null; zuletzt: string | null; widerrufen: string | null; client_id: string | null; zielgruppe: string | null; familie: string | null;
  agent: string | null; reichweite: 'ich' | 'team' | 'betrieb' | null;
}
const alsEintrag = (z: Zeile): TokenEintrag => ({
  id: z.id, userId: z.user_id, art: z.art, bezeichnung: z.bezeichnung, geraet: z.geraet, scopes: JSON.parse(z.scopes) as Scope[], erstellt: z.erstellt,
  laeuftAb: z.laeuft_ab, zuletzt: z.zuletzt, widerrufen: z.widerrufen, clientId: z.client_id, zielgruppe: z.zielgruppe, familie: z.familie,
  agent: z.agent ?? null, reichweite: z.reichweite ?? null,
});

export class Zugangsspeicher {
  private db: Database.Database;
  constructor(
    private pfad: string,
    /** Liefert den aktuellen Benutzer (Rollen frisch, damit Rollenwechsel sofort gelten); null = gelöscht. */
    private holeUser: (id: string) => User | null,
    private jetzt: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(pfad), { recursive: true });
    this.db = new Database(pfad);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, art TEXT NOT NULL, bezeichnung TEXT NOT NULL, geraet TEXT,
        scopes TEXT NOT NULL, erstellt TEXT NOT NULL, laeuft_ab TEXT, zuletzt TEXT, widerrufen TEXT, client_id TEXT, zielgruppe TEXT, familie TEXT
      );
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
      CREATE INDEX IF NOT EXISTS tokens_familie ON tokens(familie);
      CREATE TABLE IF NOT EXISTS clients (client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, erstellt TEXT NOT NULL, art TEXT NOT NULL DEFAULT 'dcr', zuletzt TEXT);
      CREATE TABLE IF NOT EXISTS codes (
        hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
        scopes TEXT NOT NULL, zielgruppe TEXT NOT NULL, laeuft_ab TEXT NOT NULL
      );`);
    const spalten = new Set((this.db.prepare('PRAGMA table_info(tokens)').all() as { name: string }[]).map((c) => c.name));
    const cs = new Set((this.db.prepare('PRAGMA table_info(clients)').all() as { name: string }[]).map((c) => c.name));
    if (!cs.has('art')) this.db.exec("ALTER TABLE clients ADD COLUMN art TEXT NOT NULL DEFAULT 'dcr'");
    if (!cs.has('zuletzt')) this.db.exec('ALTER TABLE clients ADD COLUMN zuletzt TEXT');
    if (!spalten.has('agent')) this.db.exec('ALTER TABLE tokens ADD COLUMN agent TEXT');
    if (!spalten.has('reichweite')) this.db.exec('ALTER TABLE tokens ADD COLUMN reichweite TEXT');
    try { this.db.pragma('secure_delete = ON'); } catch { /* optional */ }
  }

  private iso(plusSek = 0): string {
    return new Date(this.jetzt().getTime() + plusSek * 1000).toISOString();
  }

  private pruefeScopes(fuer: User, scopes: Scope[]): Scope[] {
    if (!Array.isArray(scopes) || scopes.some((s) => !ALLE_SCOPES.includes(s))) throw new KernFehler('ungueltig', `Unbekannter Scope (erlaubt: ${ALLE_SCOPES.join(', ')})`);
    if (scopes.includes('kern:verwalten') && !istAdmin(fuer)) throw new KernFehler('keine_rechte', 'Scope kern:verwalten nur für Admins');
    if (scopes.includes('kern:freigeben') && !istFreigeber(fuer)) throw new KernFehler('keine_rechte', 'Scope kern:freigeben nur für Freigeber und Admins (v1.4.2)');
    if ((scopes.includes('kern:vorschlagen') || scopes.includes('kern:bericht')) && !istAutor(fuer)) throw new KernFehler('keine_rechte', 'Vorschlagen und Berichten brauchen mindestens die Rolle autor');
    return [...new Set(scopes)];
  }

  /** Token für den handelnden Benutzer selbst (nie für andere, S1 M2). */
  erzeuge(fuer: User, e: ErzeugeEingabe, wer: User = fuer): { token: string; eintrag: TokenEintrag } {
    if (wer.id !== fuer.id) throw new KernFehler('keine_rechte', 'Tokens nur für dich selbst');
    if (!TOKEN_ARTEN.includes(e.art)) throw new KernFehler('ungueltig', `Unbekannte Token-Art (erlaubt: ${TOKEN_ARTEN.join(', ')})`);
    const aktuell = this.holeUser(fuer.id);
    if (!aktuell) throw new KernFehler('nicht_gefunden', 'Benutzer unbekannt');
    const std: Scope[] = e.art === 'sitzung' ? ALLE_SCOPES.filter((s) => scopeErlaubt(aktuell, s)) : ['kern:lesen', 'kern:fragen'];
    const scopes = this.pruefeScopes(aktuell, e.scopes ?? std);
    if (scopes.includes('kern:freigeben') && (e.agent || e.art === 'oauth_zugriff' || e.art === 'oauth_erneuerung')) throw new KernFehler('keine_rechte', 'kern:freigeben nie für Agenten oder OAuth (v1.4.2)');
    let sek = e.gueltigSek === undefined ? STANDARD_SEK[e.art] : e.gueltigSek;
    if (sek === null || typeof sek !== 'number' || !Number.isFinite(sek) || sek <= 0) throw new KernFehler('ungueltig', 'Jeder Zugang braucht einen Ablauf (gueltigSek > 0)');
    if (sek > ZUGANG_MAX_SEK) throw new KernFehler('ungueltig', 'Zugänge gelten höchstens 365 Tage');
    if (e.art === 'sitzung') sek = Math.min(sek, SITZUNG_MAX_SEK);
    if (e.reichweite !== undefined && !['ich', 'team', 'betrieb'].includes(e.reichweite)) throw new KernFehler('ungueltig', 'reichweite: ich | team | betrieb');
    if (e.agent !== undefined && (typeof e.agent !== 'string' || !e.agent.trim())) throw new KernFehler('ungueltig', 'agent: Name fehlt');
    const token = `kern_${randomBytes(32).toString('base64url')}`;
    const z: Zeile = {
      id: `t_${randomBytes(8).toString('hex')}`, hash: sha(token), user_id: fuer.id, art: e.art,
      bezeichnung: (e.bezeichnung ?? e.art).slice(0, 80), geraet: e.geraet?.slice(0, 120) ?? null, scopes: JSON.stringify(scopes),
      erstellt: this.iso(), laeuft_ab: this.iso(sek), zuletzt: null, widerrufen: null,
      client_id: e.clientId ?? null, zielgruppe: e.zielgruppe ?? null, familie: e.familie ?? null,
      agent: e.agent?.trim().slice(0, 80) ?? null, reichweite: e.reichweite ?? null,
    };
    this.db.prepare(`INSERT INTO tokens (id, hash, user_id, art, bezeichnung, geraet, scopes, erstellt, laeuft_ab, zuletzt, widerrufen, client_id, zielgruppe, familie, agent, reichweite)
      VALUES (@id, @hash, @user_id, @art, @bezeichnung, @geraet, @scopes, @erstellt, @laeuft_ab, @zuletzt, @widerrufen, @client_id, @zielgruppe, @familie, @agent, @reichweite)`).run(z);
    return { token, eintrag: alsEintrag(z) };
  }

  private zeileZu(token: string): Zeile | null {
    if (typeof token !== 'string' || !token.startsWith('kern_') || token.length > 200) return null;
    const h = sha(token);
    const z = this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(h) as Zeile | undefined;
    if (!z) return null;
    // zeitkonstanter Vergleich als zweite Absicherung
    const a = Buffer.from(z.hash, 'hex');
    const b = Buffer.from(h, 'hex');
    return a.length === b.length && timingSafeEqual(a, b) ? z : null;
  }

  /** null bei unbekannt, abgelaufen, widerrufen, falscher Art, fehlendem Scope, falscher Zielgruppe oder gelöschtem Benutzer. */
  pruefe(token: string, erwartet: Erwartung = {}): { user: User; eintrag: TokenEintrag } | null {
    const z = this.zeileZu(token);
    if (!z || z.widerrufen) return null;
    const jetzt = this.iso();
    if (z.laeuft_ab && z.laeuft_ab < jetzt) return null;
    const arten = erwartet.art === undefined ? null : Array.isArray(erwartet.art) ? erwartet.art : [erwartet.art];
    if (arten && !arten.includes(z.art)) return null;
    if (z.art === 'oauth_erneuerung' && !arten?.includes('oauth_erneuerung')) return null; // Erneuerungs-Tokens nie als Zugriff
    const scopes = JSON.parse(z.scopes) as Scope[];
    if (erwartet.scope && !scopes.includes(erwartet.scope)) return null;
    if (erwartet.zielgruppe && z.zielgruppe && z.zielgruppe !== erwartet.zielgruppe) return null;
    const user = this.holeUser(z.user_id);
    if (!user) return null;
    if (scopes.some((x) => !scopeErlaubt(user, x))) return null; // Rolle seither verloren
    const neu: Partial<Zeile> = {};
    if (!z.zuletzt || Date.parse(jetzt) - Date.parse(z.zuletzt) > (z.art === 'sitzung' ? 60_000 : 3600_000)) neu.zuletzt = jetzt;
    if (z.art === 'sitzung' && neu.zuletzt) {
      const max = new Date(Date.parse(z.erstellt) + SITZUNG_MAX_SEK * 1000).toISOString();
      const verl = this.iso(STANDARD_SEK.sitzung);
      neu.laeuft_ab = verl < max ? verl : max;
    }
    if (neu.zuletzt) {
      this.db.prepare('UPDATE tokens SET zuletzt = ?, laeuft_ab = ? WHERE id = ?').run(neu.zuletzt, neu.laeuft_ab ?? z.laeuft_ab, z.id);
      Object.assign(z, neu);
    }
    return { user, eintrag: alsEintrag(z) };
  }

  liste(wer: User, userId?: string, opt: { art?: TokenArt[]; mitWiderrufenen?: boolean; clientId?: string } = {}): TokenEintrag[] {
    const ziel = userId ?? wer.id;
    if (ziel !== wer.id && !istAdmin(wer)) throw new KernFehler('keine_rechte', 'Dafür fehlen dir die Rechte');
    const jetzt = this.iso();
    return (this.db.prepare('SELECT * FROM tokens WHERE user_id = ? ORDER BY erstellt').all(ziel) as Zeile[])
      .filter((z) => (!opt.art || opt.art.includes(z.art)) && (opt.clientId === undefined || z.client_id === opt.clientId))
      .filter((z) => opt.mitWiderrufenen || (!z.widerrufen && (!z.laeuft_ab || z.laeuft_ab >= jetzt)))
      .map(alsEintrag);
  }

  /** Eigenes Token oder (admin) fremdes widerrufen. */
  widerrufe(wer: User, id: string): boolean {
    const z = this.db.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Zeile | undefined;
    if (!z || z.widerrufen) return false;
    if (z.user_id !== wer.id && !istAdmin(wer)) return false; // fremde Tokens: wie unbekannt
    this.db.prepare('UPDATE tokens SET widerrufen = ? WHERE id = ?').run(this.iso(), id);
    return true;
  }

  /** „Überall abmelden“: alle (passenden) Tokens eines Benutzers; eigene oder (admin) fremde. */
  widerrufeAlle(wer: User, userId: string, filter: { art?: TokenArt[]; geraet?: string; ausser?: string; clientId?: string } = {}): number {
    if (userId !== wer.id && !istAdmin(wer)) throw new KernFehler('keine_rechte', 'Dafür fehlen dir die Rechte');
    return this.widerrufeIntern(userId, filter);
  }

  /** Für core selbst (Passwortwechsel, Löschung). */
  widerrufeIntern(userId: string, filter: { art?: TokenArt[]; geraet?: string; ausser?: string; clientId?: string } = {}): number {
    const zeilen = (this.db.prepare('SELECT * FROM tokens WHERE user_id = ? AND widerrufen IS NULL').all(userId) as Zeile[])
      .filter((z) => (!filter.art || filter.art.includes(z.art)) && (filter.geraet === undefined || z.geraet === filter.geraet) && z.id !== filter.ausser && (filter.clientId === undefined || z.client_id === filter.clientId));
    const st = this.db.prepare('UPDATE tokens SET widerrufen = ? WHERE id = ?');
    const am = this.iso();
    this.db.transaction(() => { for (const z of zeilen) st.run(am, z.id); })();
    return zeilen.length;
  }

  /** Abgelaufene und seit 30 Tagen widerrufene Einträge und Codes löschen. */
  aufraeumen(): number {
    const jetzt = this.iso();
    const grenze = this.iso(-30 * 86400);
    const a = this.db.prepare('DELETE FROM tokens WHERE (laeuft_ab IS NOT NULL AND laeuft_ab < ?) OR (widerrufen IS NOT NULL AND widerrufen < ?)').run(grenze, grenze).changes;
    const b = this.db.prepare('DELETE FROM codes WHERE laeuft_ab < ?').run(jetzt).changes;
    // DCR-Clients ohne Nutzung seit 30 Tagen (ohne gültige Zugänge) löschen; CIMD-Clients werden ohnehin neu abgerufen
    const c = this.db.prepare(`DELETE FROM clients WHERE art = 'dcr' AND COALESCE(zuletzt, erstellt) < ?
      AND client_id NOT IN (SELECT client_id FROM tokens WHERE client_id IS NOT NULL AND widerrufen IS NULL AND (laeuft_ab IS NULL OR laeuft_ab >= ?))`).run(this.iso(-30 * 86400), jetzt).changes;
    return a + b + c;
  }

  /* ---------------- OAuth 2.1 (Endpunkte baut der Server) ---------------- */

  private pruefeRedirects(redirectUris: string[]): string[] {
    const uris = [...new Set(redirectUris ?? [])];
    if (!uris.length || uris.length > 10) throw new KernFehler('ungueltig', 'redirect_uris: 1 bis 10 Adressen');
    for (const u of uris) {
      let url: URL;
      try { url = new URL(u); } catch { throw new KernFehler('ungueltig', `redirect_uri ungültig: ${u}`); }
      const lokal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
      if (url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && lokal) && !/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol))) {
        throw new KernFehler('ungueltig', `redirect_uri nur https, http://localhost oder eigenes App-Schema: ${u}`);
      }
    }
    return uris;
  }

  /** Dynamische Client-Registrierung (RFC 7591, Rückfall), nur öffentliche Clients mit PKCE. */
  registriereClient(c: { name: string; redirectUris: string[] }): OAuthClient {
    const uris = this.pruefeRedirects(c.redirectUris);
    const cl: OAuthClient = { clientId: `c_${randomBytes(12).toString('base64url')}`, name: (c.name || 'Client').slice(0, 80), redirectUris: uris, erstellt: this.iso(), art: 'dcr', zuletzt: null };
    this.db.prepare('INSERT INTO clients (client_id, name, redirect_uris, erstellt, art, zuletzt) VALUES (?, ?, ?, ?, ?, NULL)').run(cl.clientId, cl.name, JSON.stringify(uris), cl.erstellt, 'dcr');
    return cl;
  }

  /** Client ID Metadata Document (vorrangiger Weg): clientId ist die https-Adresse des Dokuments; Abruf und Prüfung macht der Server. */
  merkeCimdClient(c: { clientId: string; name: string; redirectUris: string[] }): OAuthClient {
    let url: URL;
    try { url = new URL(c.clientId); } catch { throw new KernFehler('ungueltig', 'client_id muss eine https-Adresse sein'); }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || c.clientId.length > 500) throw new KernFehler('ungueltig', 'client_id muss eine https-Adresse ohne Fragment und Zugangsdaten sein');
    const uris = this.pruefeRedirects(c.redirectUris);
    const alt = this.holeClient(c.clientId);
    const cl: OAuthClient = { clientId: c.clientId, name: (c.name || url.hostname).slice(0, 80), redirectUris: uris, erstellt: alt?.erstellt ?? this.iso(), art: 'cimd', zuletzt: alt?.zuletzt ?? null };
    this.db.prepare(`INSERT INTO clients (client_id, name, redirect_uris, erstellt, art, zuletzt) VALUES (?, ?, ?, ?, 'cimd', ?)
      ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, art = 'cimd'`).run(cl.clientId, cl.name, JSON.stringify(uris), cl.erstellt, cl.zuletzt);
    return cl;
  }

  holeClient(clientId: string): OAuthClient | null {
    const z = this.db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as { client_id: string; name: string; redirect_uris: string; erstellt: string; art: 'dcr' | 'cimd'; zuletzt: string | null } | undefined;
    return z ? { clientId: z.client_id, name: z.name, redirectUris: JSON.parse(z.redirect_uris) as string[], erstellt: z.erstellt, art: z.art ?? 'dcr', zuletzt: z.zuletzt ?? null } : null;
  }

  private clientBenutzt(clientId: string): void {
    this.db.prepare('UPDATE clients SET zuletzt = ? WHERE client_id = ?').run(this.iso(), clientId);
  }

  /** Autorisierungscode (60 s, einmalig) nach Zustimmung des angemeldeten Benutzers; PKCE S256 Pflicht. */
  erzeugeCode(fuer: User, c: { clientId: string; redirectUri: string; codeChallenge: string; scopes: Scope[]; zielgruppe: string }): string {
    const cl = this.holeClient(c.clientId);
    if (!cl || !cl.redirectUris.includes(c.redirectUri)) throw new KernFehler('ungueltig', 'Client oder redirect_uri unbekannt');
    if (!/^[A-Za-z0-9_-]{43}$/.test(c.codeChallenge)) throw new KernFehler('ungueltig', 'code_challenge (S256, base64url) fehlt');
    if (c.scopes.includes('kern:verwalten')) throw new KernFehler('ungueltig', 'kern:verwalten gibt es nie über OAuth');
    if (c.scopes.includes('kern:freigeben')) throw new KernFehler('ungueltig', 'kern:freigeben gibt es nie über OAuth');
    const scopes = this.pruefeScopes(this.holeUser(fuer.id) ?? fuer, c.scopes);
    this.clientBenutzt(c.clientId);
    const code = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO codes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sha(code), c.clientId, fuer.id, c.redirectUri, c.codeChallenge, JSON.stringify(scopes), c.zielgruppe, this.iso(CODE_SEK));
    return code;
  }

  private paar(user: User, scopes: Scope[], clientId: string, zielgruppe: string, familie: string): TokenPaar {
    const name = this.holeClient(clientId)?.name ?? clientId;
    const zugriff = this.erzeuge(user, { art: 'oauth_zugriff', bezeichnung: `OAuth ${name}`, scopes, clientId, zielgruppe, familie, agent: name || 'oauth' });
    const erneuerung = this.erzeuge(user, { art: 'oauth_erneuerung', bezeichnung: `OAuth ${name}`, scopes, clientId, zielgruppe, familie, agent: name || 'oauth' });
    return { zugriff, erneuerung };
  }

  loeseCodeEin(code: string, c: { clientId: string; redirectUri: string; codeVerifier: string }): TokenPaar | null {
    const h = sha(code);
    const z = this.db.prepare('SELECT * FROM codes WHERE hash = ?').get(h) as { client_id: string; user_id: string; redirect_uri: string; challenge: string; scopes: string; zielgruppe: string; laeuft_ab: string } | undefined;
    this.db.prepare('DELETE FROM codes WHERE hash = ?').run(h); // einmalig, auch bei Fehlschlag
    if (!z || z.laeuft_ab < this.iso() || z.client_id !== c.clientId || z.redirect_uri !== c.redirectUri) return null;
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(c.codeVerifier ?? '')) return null;
    const ist = createHash('sha256').update(c.codeVerifier).digest('base64url');
    if (ist.length !== z.challenge.length || !timingSafeEqual(Buffer.from(ist), Buffer.from(z.challenge))) return null;
    const user = this.holeUser(z.user_id);
    if (!user) return null;
    return this.paar(user, JSON.parse(z.scopes) as Scope[], z.client_id, z.zielgruppe, `f_${randomBytes(8).toString('hex')}`);
  }

  /** Erneuerung mit Rotation; ein zweites Mal benutztes Erneuerungs-Token widerruft die ganze Familie. */
  erneuere(refreshToken: string, e: { clientId?: string } = {}): TokenPaar | null {
    const z = this.zeileZu(refreshToken);
    if (!z || z.art !== 'oauth_erneuerung') return null;
    if (z.widerrufen) {
      if (z.familie) this.db.prepare('UPDATE tokens SET widerrufen = ? WHERE familie = ? AND widerrufen IS NULL').run(this.iso(), z.familie);
      return null;
    }
    if ((z.laeuft_ab && z.laeuft_ab < this.iso()) || (e.clientId && e.clientId !== z.client_id)) return null;
    const user = this.holeUser(z.user_id);
    if (!user) return null;
    this.db.prepare('UPDATE tokens SET widerrufen = ? WHERE id = ?').run(this.iso(), z.id);
    if (z.client_id) this.clientBenutzt(z.client_id);
    // alte Zugriffs-Tokens der Familie beenden
    if (z.familie) this.db.prepare("UPDATE tokens SET widerrufen = ? WHERE familie = ? AND art = 'oauth_zugriff' AND widerrufen IS NULL").run(this.iso(), z.familie);
    return this.paar(user, JSON.parse(z.scopes) as Scope[], z.client_id ?? '', z.zielgruppe ?? '', z.familie ?? `f_${randomBytes(8).toString('hex')}`);
  }

  /* ---------------- Übernahme alter Speicher ---------------- */

  /** Einmalig: `.kern/tokens.json` des Servers übernehmen und in `tokens.json.migriert` umbenennen. */
  uebernimmServerTokens(kernDir: string): number {
    const datei = join(kernDir, 'tokens.json');
    if (!existsSync(datei)) return 0;
    let n = 0;
    try {
      const alt = JSON.parse(readFileSync(datei, 'utf8')) as { id?: string; userId: string; bezeichnung?: string; erstellt?: string; zuletzt?: string | null; hash: string }[];
      for (const t of alt) if (this.uebernimmHash(t.userId, t.hash, t.bezeichnung ?? 'MCP', t.erstellt ?? this.iso(), t.zuletzt ?? null)) n++;
    } catch {
      return 0;
    }
    renameSync(datei, `${datei}.migriert`);
    return n;
  }

  /** Einen alten Token-Hash als `mcp` (lesen, fragen, vorschlagen; Ablauf erstellt + 90 Tage) übernehmen. */
  uebernimmHash(userId: string, hash: string, bezeichnung: string, erstellt: string, zuletzt: string | null): boolean {
    if (!/^[0-9a-f]{64}$/.test(hash) || this.db.prepare('SELECT 1 FROM tokens WHERE hash = ?').get(hash)) return false;
    const ab = new Date(Date.parse(erstellt) + 90 * 86400_000);
    const u = this.holeUser(userId);
    const scopes = (['kern:lesen', 'kern:fragen', 'kern:vorschlagen'] as Scope[]).filter((x) => !u || scopeErlaubt(u, x));
    this.db.prepare(`INSERT INTO tokens (id, hash, user_id, art, bezeichnung, geraet, scopes, erstellt, laeuft_ab, zuletzt) VALUES (?, ?, ?, 'mcp', ?, NULL, ?, ?, ?, ?)`).run(
      `t_${randomBytes(8).toString('hex')}`, hash, userId, bezeichnung.slice(0, 80), JSON.stringify(scopes),
      erstellt, Number.isNaN(ab.getTime()) ? this.iso(90 * 86400) : ab.toISOString(), zuletzt,
    );
    return true;
  }

  /**
   * v1.4 7.2: Zugänge für das Umzugspaket: nur `api` und `mcp` (gültig, nicht widerrufen, mit Hash) und OAuth-Clients.
   * Keine Sitzungen, keine OAuth-Zugriffs- oder Erneuerungs-Tokens, keine Codes.
   */
  exportiere(): ZugangExport {
    const jetzt = this.iso();
    const tokens = (this.db.prepare("SELECT * FROM tokens WHERE art IN ('api', 'mcp') AND widerrufen IS NULL AND (laeuft_ab IS NULL OR laeuft_ab >= ?) ORDER BY erstellt").all(jetzt) as Zeile[])
      .map((z) => ({ ...alsEintrag(z), hash: z.hash }));
    const clients = (this.db.prepare('SELECT client_id FROM clients ORDER BY erstellt').all() as { client_id: string }[]).map((c) => this.holeClient(c.client_id)!);
    return { format: 'kern-zugang/1', erstellt: jetzt, tokens, clients };
  }

  /** Gegenstück zu `exportiere()`; vorhandene Hashes und Clients bleiben unverändert. Gibt die Zahl übernommener Einträge zurück. */
  importiere(e: ZugangExport): { tokens: number; clients: number } {
    if (!e || e.format !== 'kern-zugang/1' || !Array.isArray(e.tokens) || !Array.isArray(e.clients)) throw new KernFehler('ungueltig', 'Kein Zugangs-Export (kern-zugang/1)');
    let t = 0;
    let c = 0;
    const tx = this.db.transaction(() => {
      for (const x of e.tokens) {
        if (!/^[0-9a-f]{64}$/.test(x.hash) || (x.art !== 'api' && x.art !== 'mcp')) continue;
        if (this.db.prepare('SELECT 1 FROM tokens WHERE hash = ? OR id = ?').get(x.hash, x.id)) continue;
        const scopes = (x.scopes ?? []).filter((s) => ALLE_SCOPES.includes(s));
        this.db.prepare(`INSERT INTO tokens (id, hash, user_id, art, bezeichnung, geraet, scopes, erstellt, laeuft_ab, zuletzt, widerrufen, client_id, zielgruppe, familie, agent, reichweite)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`).run(
          x.id, x.hash, x.userId, x.art, String(x.bezeichnung ?? x.art).slice(0, 80), x.geraet ?? null, JSON.stringify(scopes), x.erstellt,
          x.laeuftAb ?? this.iso(STANDARD_SEK.mcp), x.zuletzt ?? null, x.clientId ?? null, x.zielgruppe ?? null, x.agent ?? null, x.reichweite ?? null,
        );
        t++;
      }
      for (const k of e.clients) {
        if (!k?.clientId || this.holeClient(k.clientId)) continue;
        this.db.prepare('INSERT INTO clients (client_id, name, redirect_uris, erstellt, art, zuletzt) VALUES (?, ?, ?, ?, ?, ?)').run(k.clientId, k.name, JSON.stringify(k.redirectUris ?? []), k.erstellt, k.art ?? 'dcr', k.zuletzt ?? null);
        c++;
      }
    });
    tx();
    return { tokens: t, clients: c };
  }

  schliessen(): void {
    if (this.db.open) this.db.close();
  }
}

/* ---------------- Einfache Form (Vorschlag F1), auf demselben Speicher ---------------- */

export type EinfacherScope = 'lesen' | 'schreiben' | 'admin';
export interface ZugangEintrag { id: string; userId: string; bezeichnung: string; geraet: string | null; scope: EinfacherScope[]; art: 'mcp' | 'oauth'; resource: string | null; erstellt: string; laeuftAb: string | null; zuletzt: string | null }

const NACH_SCOPE: Record<EinfacherScope, Scope[]> = { lesen: ['kern:lesen', 'kern:fragen'], schreiben: ['kern:vorschlagen', 'kern:bericht'], admin: ['kern:verwalten'] };
function einfach(e: TokenEintrag): ZugangEintrag {
  const scope: EinfacherScope[] = [];
  if (e.scopes.includes('kern:lesen')) scope.push('lesen');
  if (e.scopes.includes('kern:vorschlagen')) scope.push('schreiben');
  if (e.scopes.includes('kern:verwalten')) scope.push('admin');
  return { id: e.id, userId: e.userId, bezeichnung: e.bezeichnung, geraet: e.geraet, scope, art: e.art.startsWith('oauth') ? 'oauth' : 'mcp', resource: e.zielgruppe, erstellt: e.erstellt, laeuftAb: e.laeuftAb, zuletzt: e.zuletzt };
}

/** Asynchrone Kurzform; Rechte (nur für sich selbst) prüft hier der Aufrufer. */
export class ZugangEinfach {
  constructor(private z: Zugangsspeicher, private holeUser: (id: string) => User | null) {}
  private user(id: string): User {
    const u = this.holeUser(id);
    if (!u) throw new KernFehler('nicht_gefunden', 'Benutzer unbekannt');
    return u;
  }
  async erstelle(userId: string, o: { bezeichnung: string; scope: EinfacherScope[]; gueltigTage: number | null; geraet?: string; resource?: string; art?: 'mcp' | 'oauth' }): Promise<{ token: string; eintrag: ZugangEintrag }> {
    if (!Array.isArray(o.scope) || !o.scope.length || o.scope.some((s) => !(s in NACH_SCOPE))) throw new KernFehler('ungueltig', 'scope: lesen | schreiben | admin');
    const u = this.user(userId);
    const r = this.z.erzeuge(u, {
      art: o.art === 'oauth' ? 'oauth_zugriff' : 'mcp', bezeichnung: o.bezeichnung, scopes: o.scope.flatMap((s) => NACH_SCOPE[s]),
      gueltigSek: o.gueltigTage === null ? (o.art === 'oauth' ? STANDARD_SEK.oauth_zugriff : STANDARD_SEK.mcp) : o.gueltigTage * 86400,
      ...(o.geraet ? { geraet: o.geraet } : {}), ...(o.resource ? { zielgruppe: o.resource } : {}),
    });
    return { token: r.token, eintrag: einfach(r.eintrag) };
  }
  async pruefe(token: string): Promise<ZugangEintrag | null> {
    const r = this.z.pruefe(token, { art: ['mcp', 'api', 'oauth_zugriff'] });
    return r ? einfach(r.eintrag) : null;
  }
  async liste(userId?: string): Promise<ZugangEintrag[]> {
    if (!userId) throw new KernFehler('ungueltig', 'userId fehlt');
    return this.z.liste(this.user(userId), userId, { art: ['mcp', 'api', 'oauth_zugriff'] }).map(einfach);
  }
  async widerrufe(id: string, userId?: string): Promise<boolean> {
    const admin: User = { id: '_system', name: 'system', rollen: ['admin'], teams: [] };
    return this.z.widerrufe(userId ? this.user(userId) : admin, id);
  }
  async widerrufeAlle(userId: string, o: { geraet?: string } = {}): Promise<number> {
    return this.z.widerrufeIntern(userId, o.geraet !== undefined ? { geraet: o.geraet } : {});
  }
}
