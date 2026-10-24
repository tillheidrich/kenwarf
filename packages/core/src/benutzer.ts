import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Rolle, User } from './types.js';
import { KernFehler, ROLLEN } from './types.js';
import { Sperre, slugify } from './util.js';
import { scopeErlaubt, type Zugangsspeicher } from './zugang.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opt: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
/** D-L7: scrypt N = 2^17, r = 8, p = 1 (Parameter stehen im Hash; ältere Hashes werden beim Login erneuert). */
export const PARAM = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

interface GespeicherterBenutzer extends User {
  /** `scrypt$N$r$p$salzB64$hashB64` */
  passwort: string;
  /** SHA-256 der API-/MCP-Tokens. */
  tokens?: { hash: string; name: string; erstellt: string }[];
  erstellt: string;
  /** Zählt Passwortwechsel; ändert sich der Wert, sind alte Sitzungen ungültig (Server prüft je Anfrage). */
  zugangsStand?: number;
  /** Admin hat das Passwort zurückgesetzt: bei der nächsten Anmeldung neues Passwort verlangen. */
  mussPasswortAendern?: boolean;
}

/** Öffentliche Form mit Zugangsfeldern (für hole/pruefe). */
export type BenutzerMitZugang = User & { zugangsStand?: number; mussPasswortAendern?: boolean };

export async function hashPasswort(pw: string): Promise<string> {
  const salz = randomBytes(16);
  const h = await scrypt(pw.normalize('NFC'), salz, 32, PARAM);
  return `scrypt$${PARAM.N}$${PARAM.r}$${PARAM.p}$${salz.toString('base64')}$${h.toString('base64')}`;
}

export async function pruefePasswort(pw: string, gespeichert: string): Promise<boolean> {
  const [art, n, r, p, salz, hash] = gespeichert.split('$');
  if (art !== 'scrypt' || !salz || !hash) return false;
  const soll = Buffer.from(hash, 'base64');
  const ist = await scrypt(pw.normalize('NFC'), Buffer.from(salz, 'base64'), soll.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: PARAM.maxmem });
  return ist.length === soll.length && timingSafeEqual(ist, soll);
}

/** true, wenn der gespeicherte Hash schwächere Parameter als `PARAM` hat. */
export function brauchtRehash(gespeichert: string): boolean {
  const [art, n, r, p] = gespeichert.split('$');
  return art !== 'scrypt' || Number(n) < PARAM.N || Number(r) < PARAM.r || Number(p) < PARAM.p;
}

const oeffentlich = (b: GespeicherterBenutzer): User => ({ id: b.id, name: b.name, rollen: [...b.rollen], teams: [...b.teams] });
const mitZugang = (b: GespeicherterBenutzer): BenutzerMitZugang => ({ ...oeffentlich(b), zugangsStand: b.zugangsStand ?? 0, mussPasswortAendern: b.mussPasswortAendern ?? false });

/** Benutzerverwaltung in `.kern/users.json` (nicht in git). */
export class Benutzerverwaltung {
  private sperre = new Sperre();
  private cache: { mtime: number; liste: GespeicherterBenutzer[] } | null = null;
  /** Gemeinsamer Zugangsspeicher (wird von Kern gesetzt). */
  zugang: Zugangsspeicher | null = null;
  constructor(private datei: string) {}

  /** Synchron (für den Zugangsspeicher): Benutzer nach id, mit mtime-Cache. */
  holeSync = (id: string): User | null => {
    let mtime = 0;
    try { mtime = statSync(this.datei).mtimeMs; } catch { return null; }
    if (!this.cache || this.cache.mtime !== mtime) {
      try { this.cache = { mtime, liste: JSON.parse(readFileSync(this.datei, 'utf8')) as GespeicherterBenutzer[] }; } catch { return null; }
    }
    const b = this.cache.liste.find((x) => x.id === id);
    return b ? oeffentlich(b) : null;
  };

  /** Einmalig: alte `tokens[]` aus users.json in den Zugangsspeicher übernehmen und entfernen. */
  uebernimmAlteTokens = (): Promise<number> =>
    this.sperre.run(async () => {
      if (!this.zugang) return 0;
      const liste = await this.lese();
      let n = 0;
      for (const b of liste) {
        for (const t of b.tokens ?? []) if (this.zugang.uebernimmHash(b.id, t.hash, t.name, t.erstellt, null)) n++;
        if (b.tokens) delete b.tokens;
      }
      if (liste.some((b) => 'tokens' in b) || n) await this.schreibe(liste);
      return n;
    });

  private async lese(): Promise<GespeicherterBenutzer[]> {
    try {
      return JSON.parse(await readFile(this.datei, 'utf8')) as GespeicherterBenutzer[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  private async schreibe(liste: GespeicherterBenutzer[]): Promise<void> {
    await mkdir(dirname(this.datei), { recursive: true });
    const tmp = `${this.datei}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(liste, null, 2), { mode: 0o600 });
    await rename(tmp, this.datei);
    this.cache = null;
  }

  anlegen = (name: string, passwort: string, rollen: Rolle[], teams: string[] = []): Promise<User> =>
    this.sperre.run(async () => {
      const n = name.trim();
      if (!n) throw new KernFehler('ungueltig', 'Name fehlt');
      if (passwort.length < 8) throw new KernFehler('ungueltig', 'Passwort braucht mindestens 8 Zeichen');
      if (!rollen.length || rollen.some((r) => !ROLLEN.includes(r))) throw new KernFehler('ungueltig', 'Ungültige Rollen');
      const liste = await this.lese();
      if (liste.some((b) => b.name.toLowerCase() === n.toLowerCase())) throw new KernFehler('konflikt', `Benutzer ${n} gibt es schon`);
      let id = slugify(n, 32);
      while (liste.some((b) => b.id === id)) id = `${slugify(n, 28)}-${randomBytes(2).toString('hex')}`;
      const b: GespeicherterBenutzer = { id, name: n, rollen: [...new Set(rollen)], teams: [...new Set(teams)], passwort: await hashPasswort(passwort), erstellt: new Date().toISOString() };
      liste.push(b);
      await this.schreibe(liste);
      return oeffentlich(b);
    });

  pruefe = async (name: string, passwort: string): Promise<BenutzerMitZugang | null> => {
    const b = (await this.lese()).find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!b) {
      // gleiche Laufzeit wie ein echter Vergleich
      await pruefePasswort(passwort, `scrypt$${PARAM.N}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`);
      return null;
    }
    if (!(await pruefePasswort(passwort, b.passwort))) return null;
    if (brauchtRehash(b.passwort)) {
      const neu = await hashPasswort(passwort);
      await this.sperre.run(async () => {
        const liste = await this.lese();
        const x = liste.find((y) => y.id === b.id);
        if (x && x.passwort === b.passwort) {
          x.passwort = neu;
          await this.schreibe(liste);
        }
      });
    }
    return mitZugang(b);
  };

  liste = async (): Promise<User[]> => (await this.lese()).map(oeffentlich);

  /** Erweiterung: Benutzer nach id. */
  hole = async (id: string): Promise<BenutzerMitZugang | null> => {
    const b = (await this.lese()).find((x) => x.id === id);
    return b ? mitZugang(b) : null;
  };

  /**
   * Erweiterung: Rollen/Teams/Passwort ändern. Ein neues Passwort beendet alle Sitzungen und Tokens des Benutzers
   * und erhöht `zugangsStand` (S1 M3). `mussPasswortAendern` setzt der Admin beim Zurücksetzen.
   */
  aendere = (id: string, a: { rollen?: Rolle[]; teams?: string[]; passwort?: string; mussPasswortAendern?: boolean }): Promise<BenutzerMitZugang> =>
    this.sperre.run(async () => {
      const liste = await this.lese();
      const b = liste.find((x) => x.id === id);
      if (!b) throw new KernFehler('nicht_gefunden', `Benutzer ${id} unbekannt`);
      if (a.rollen) {
        if (!a.rollen.length || a.rollen.some((r) => !ROLLEN.includes(r))) throw new KernFehler('ungueltig', 'Ungültige Rollen');
        b.rollen = [...new Set(a.rollen)];
      }
      if (a.teams) b.teams = [...new Set(a.teams)];
      if (a.passwort !== undefined) {
        if (a.passwort.length < 8) throw new KernFehler('ungueltig', 'Passwort braucht mindestens 8 Zeichen');
        b.passwort = await hashPasswort(a.passwort);
        b.zugangsStand = (b.zugangsStand ?? 0) + 1;
      }
      if (a.mussPasswortAendern !== undefined) b.mussPasswortAendern = a.mussPasswortAendern;
      await this.schreibe(liste);
      if (a.passwort !== undefined) this.zugang?.widerrufeIntern(id);
      return mitZugang(b);
    });

  /** Eigenes Passwort ändern (altes Passwort nötig); beendet alle Sitzungen und Tokens, setzt `mussPasswortAendern` zurück. */
  aenderePasswort = async (id: string, alt: string, neu: string): Promise<BenutzerMitZugang> => {
    const b = (await this.lese()).find((x) => x.id === id);
    if (!b || !(await pruefePasswort(alt, b.passwort))) throw new KernFehler('keine_rechte', 'Altes Passwort stimmt nicht');
    if (alt === neu) throw new KernFehler('ungueltig', 'Neues Passwort muss sich unterscheiden');
    return this.aendere(id, { passwort: neu, mussPasswortAendern: false });
  };

  /** Erweiterung: Benutzer löschen (beendet auch alle Sitzungen und Tokens). */
  loesche = (id: string): Promise<void> =>
    this.sperre.run(async () => {
      const liste = await this.lese();
      await this.schreibe(liste.filter((x) => x.id !== id));
      this.zugang?.widerrufeIntern(id);
    });

  /** Veraltet: nutze `kern.zugang.erzeuge`. Legt ein `mcp`-Token (lesen, fragen, vorschlagen) im Zugangsspeicher an. */
  erzeugeToken = async (id: string, name = 'mcp'): Promise<string> => {
    const u = this.holeSync(id);
    if (!u || !this.zugang) throw new KernFehler('nicht_gefunden', `Benutzer ${id} unbekannt`);
    return this.zugang.erzeuge(u, { art: 'mcp', bezeichnung: name, scopes: (['kern:lesen', 'kern:fragen', 'kern:vorschlagen'] as const).filter((x) => scopeErlaubt(u, x)) }).token;
  };

  /** Veraltet: nutze `kern.zugang.pruefe`. */
  pruefeToken = async (token: string): Promise<User | null> => this.zugang?.pruefe(token, { art: ['mcp', 'api', 'oauth_zugriff'] })?.user ?? null;

  /** Veraltet: nutze `kern.zugang.widerrufeAlle`. */
  widerrufeTokens = async (id: string): Promise<void> => {
    this.zugang?.widerrufeIntern(id, { art: ['mcp', 'api', 'oauth_zugriff', 'oauth_erneuerung'] });
  };
}
