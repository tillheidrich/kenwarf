import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { User } from './types.js';
import { KernFehler } from './fehler.js';

/**
 * Gemeinsamer Tokenspeicher (abgestimmt mit core, Agent C1, 24.10.2026):
 * Sitzungen, API-/MCP-Tokens und später OAuth-Tokens liegen in einem Speicher von core (`kern.zugang`).
 * Diese Datei enthält nur die Typen und einen Ersatz mit derselben Form für die Attrappe und
 * ältere core-Stände. Der Server nutzt `kern.zugang`, sobald es vorhanden ist.
 */
export type TokenArt = 'sitzung' | 'api' | 'mcp' | 'oauth_zugriff' | 'oauth_erneuerung';
export type Scope = 'kern:lesen' | 'kern:fragen' | 'kern:vorschlagen' | 'kern:bericht' | 'kern:verwalten';
export const ALLE_SCOPES: readonly Scope[] = ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht', 'kern:verwalten'];

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
  familie: string | null;
  /** v1.4 6.3: Name des Agenten (OAuth: client_name), Einschränkung der Reichweite. */
  agent?: string | null;
  reichweite?: 'ich' | 'team' | 'betrieb' | null;
}

export interface ErzeugeEingabe {
  art: TokenArt;
  bezeichnung?: string;
  geraet?: string;
  scopes?: Scope[];
  gueltigSek?: number | null;
  clientId?: string;
  zielgruppe?: string;
  familie?: string;
  agent?: string;
  reichweite?: 'ich' | 'team' | 'betrieb';
}

export interface Erwartung { art?: TokenArt | TokenArt[]; scope?: Scope; zielgruppe?: string }

/** Teil der core-Schnittstelle, den der Server nutzt. */
export interface ZugangLike {
  erzeuge(fuer: User, e: ErzeugeEingabe): { token: string; eintrag: TokenEintrag };
  pruefe(token: string, erwartet?: Erwartung): { user: User; eintrag: TokenEintrag } | null;
  liste(wer: User, userId?: string, opt?: { art?: TokenArt[]; mitWiderrufenen?: boolean }): TokenEintrag[];
  widerrufe(wer: User, id: string): boolean;
  widerrufeAlle(wer: User, userId: string, filter?: { art?: TokenArt[]; geraet?: string; ausser?: string; clientId?: string }): number;
  aufraeumen?(): number;
}

const STANDARD_SEK: Record<TokenArt, number> = {
  sitzung: 12 * 3600, api: 90 * 86400, mcp: 90 * 86400, oauth_zugriff: 3600, oauth_erneuerung: 30 * 86400,
};
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const istAdmin = (u: User) => u.rollen.includes('admin');

interface Gespeichert extends TokenEintrag { hash: string; user: User }

/**
 * Ersatz-Speicher mit der Form von core. Sitzungen nur im Speicher, API/MCP-Tokens in
 * `.kern/zugang-ersatz.json` (0600, nur Hashes). Nicht für den Managed-Betrieb gedacht.
 */
export class ErsatzZugang implements ZugangLike {
  private sitzungen = new Map<string, Gespeichert>();
  private datei: string;
  constructor(dataDir: string) {
    this.datei = path.join(dataDir, '.kern', 'zugang-ersatz.json');
  }

  private lade(): Gespeichert[] {
    try { return JSON.parse(fs.readFileSync(this.datei, 'utf8')) as Gespeichert[]; } catch { return []; }
  }
  private speichere(l: Gespeichert[]) {
    fs.mkdirSync(path.dirname(this.datei), { recursive: true });
    const tmp = `${this.datei}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.datei);
  }
  private alle(): Gespeichert[] { return [...this.sitzungen.values(), ...this.lade()]; }
  private schreibeZurueck(e: Gespeichert) {
    if (e.art === 'sitzung') { this.sitzungen.set(e.id, e); return; }
    const l = this.lade();
    const i = l.findIndex((x) => x.id === e.id);
    if (i >= 0) { l[i] = e; this.speichere(l); }
  }
  private static oeffentlich({ hash: _h, user: _u, ...rest }: Gespeichert): TokenEintrag { return rest; }

  erzeuge(fuer: User, e: ErzeugeEingabe): { token: string; eintrag: TokenEintrag } {
    const scopes = e.scopes ?? ['kern:lesen', 'kern:fragen'];
    if (scopes.some((s) => !ALLE_SCOPES.includes(s))) throw new KernFehler(400, 'Unbekannter Scope.', 'ungueltig');
    if (scopes.includes('kern:verwalten') && !istAdmin(fuer)) throw new KernFehler(403, 'Scope kern:verwalten nur für Admins.', 'keine_rechte');
    const token = `kern_${crypto.randomBytes(32).toString('base64url')}`;
    // v1.4 M3: Ablauf für jeden Zugang Pflicht, höchstens 365 Tage.
    if (e.gueltigSek === null) throw new KernFehler(400, 'Jeder Zugang braucht ein Ablaufdatum.', 'ungueltig');
    const sek = e.gueltigSek === undefined ? STANDARD_SEK[e.art] : Math.min(e.gueltigSek, 365 * 86400);
    const jetzt = Date.now();
    const g: Gespeichert = {
      id: `t_${crypto.randomBytes(6).toString('hex')}`, userId: fuer.id, art: e.art,
      bezeichnung: (e.bezeichnung ?? e.art).slice(0, 80), geraet: e.geraet?.slice(0, 120) ?? null, scopes: [...new Set(scopes)],
      erstellt: new Date(jetzt).toISOString(), laeuftAb: sek === null ? null : new Date(jetzt + sek * 1000).toISOString(),
      zuletzt: null, widerrufen: null, clientId: e.clientId ?? null, zielgruppe: e.zielgruppe ?? null, familie: e.familie ?? null,
      agent: e.agent ?? null, reichweite: e.reichweite ?? null,
      hash: sha(token), user: fuer,
    };
    if (g.art === 'sitzung') this.sitzungen.set(g.id, g);
    else this.speichere([...this.lade(), g]);
    return { token, eintrag: ErsatzZugang.oeffentlich(g) };
  }

  pruefe(token: string, erwartet: Erwartung = {}): { user: User; eintrag: TokenEintrag } | null {
    if (!token.startsWith('kern_') || token.length > 200) return null;
    const h = Buffer.from(sha(token), 'hex');
    const e = this.alle().find((x) => { const b = Buffer.from(x.hash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(b, h); });
    if (!e || e.widerrufen) return null;
    if (e.laeuftAb && Date.parse(e.laeuftAb) < Date.now()) return null;
    const arten = erwartet.art === undefined ? null : Array.isArray(erwartet.art) ? erwartet.art : [erwartet.art];
    if (arten && !arten.includes(e.art)) return null;
    if (erwartet.scope && !e.scopes.includes(erwartet.scope)) return null;
    if (erwartet.zielgruppe && e.zielgruppe && e.zielgruppe !== erwartet.zielgruppe) return null;
    const jetzt = new Date().toISOString();
    if (!e.zuletzt || e.zuletzt.slice(0, 13) !== jetzt.slice(0, 13) || e.art === 'sitzung') {
      e.zuletzt = jetzt;
      if (e.art === 'sitzung') e.laeuftAb = new Date(Date.now() + STANDARD_SEK.sitzung * 1000).toISOString();
      try { this.schreibeZurueck(e); } catch { /* nur Statistik */ }
    }
    return { user: e.user, eintrag: ErsatzZugang.oeffentlich(e) };
  }

  liste(wer: User, userId?: string, opt: { art?: TokenArt[]; mitWiderrufenen?: boolean } = {}): TokenEintrag[] {
    const ziel = userId ?? wer.id;
    if (ziel !== wer.id && !istAdmin(wer)) throw new KernFehler(403, 'Dafür fehlen dir die Rechte.', 'keine_rechte');
    const jetzt = Date.now();
    return this.alle()
      .filter((e) => e.userId === ziel && (!opt.art || opt.art.includes(e.art)))
      .filter((e) => opt.mitWiderrufenen || (!e.widerrufen && (!e.laeuftAb || Date.parse(e.laeuftAb) >= jetzt)))
      .map(ErsatzZugang.oeffentlich);
  }

  widerrufe(wer: User, id: string): boolean {
    const e = this.alle().find((x) => x.id === id && !x.widerrufen);
    if (!e || (e.userId !== wer.id && !istAdmin(wer))) return false;
    e.widerrufen = new Date().toISOString();
    this.schreibeZurueck(e);
    return true;
  }

  widerrufeAlle(wer: User, userId: string, filter: { art?: TokenArt[]; geraet?: string; ausser?: string; clientId?: string } = {}): number {
    if (userId !== wer.id && !istAdmin(wer)) throw new KernFehler(403, 'Dafür fehlen dir die Rechte.', 'keine_rechte');
    let n = 0;
    const jetzt = new Date().toISOString();
    for (const e of this.sitzungen.values()) {
      if (e.userId === userId && !e.widerrufen && (!filter.art || filter.art.includes(e.art)) && (!filter.geraet || e.geraet === filter.geraet) && e.id !== filter.ausser && (!filter.clientId || e.clientId === filter.clientId)) { e.widerrufen = jetzt; n++; }
    }
    const l = this.lade();
    let geaendert = false;
    for (const e of l) {
      if (e.userId === userId && !e.widerrufen && (!filter.art || filter.art.includes(e.art)) && (!filter.geraet || e.geraet === filter.geraet) && e.id !== filter.ausser && (!filter.clientId || e.clientId === filter.clientId)) { e.widerrufen = jetzt; n++; geaendert = true; }
    }
    if (geaendert) this.speichere(l);
    return n;
  }

  aufraeumen(): number {
    const jetzt = Date.now();
    let n = 0;
    for (const [id, e] of this.sitzungen) if (e.widerrufen || (e.laeuftAb && Date.parse(e.laeuftAb) < jetzt)) { this.sitzungen.delete(id); n++; }
    return n;
  }
}

/** Liefert den Speicher von core, sonst den Ersatz. */
export function waehleZugang(kern: unknown, dataDir: string): { zugang: ZugangLike; ausCore: boolean } {
  const z = (kern as { zugang?: Partial<ZugangLike> }).zugang;
  if (z && typeof z.erzeuge === 'function' && typeof z.pruefe === 'function' && typeof z.widerrufeAlle === 'function') {
    return { zugang: z as ZugangLike, ausCore: true };
  }
  return { zugang: new ErsatzZugang(dataDir), ausCore: false };
}
