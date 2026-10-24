/**
 * Anmeldung an der Konsole: Passwort (scrypt) plus TOTP (RFC 6238, 30 s, 6 Stellen, SHA-1 wie alle gängigen Apps).
 * Empfehlung und Begründung in README.md: TOTP jetzt, Passkey als zweiter Faktor später additiv.
 * Sitzungen im Speicher (Neustart = abgemeldet), Cookie signiert, CSRF-Token je Sitzung, Ratenlimit je Name und IP.
 */
import crypto from 'node:crypto';
import type { DB } from './db.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, wert = 0, out = '';
  for (const b of buf) {
    wert = (wert << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(wert >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(wert << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, wert = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('kein base32');
    wert = (wert << 5) | i; bits += 5;
    if (bits >= 8) { out.push((wert >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secretB32: string, zaehler: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(zaehler));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}
export const totpZaehler = (ms: number) => Math.floor(ms / 30_000);

/** Prüft Code mit ±1 Zeitschritt; liefert den genutzten Zähler oder null. Wiederverwendung verhindert der Aufrufer. */
export function pruefeTotp(secretB32: string, code: string, ms: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const z = totpZaehler(ms);
  for (const d of [0, -1, 1]) {
    const soll = Buffer.from(totp(secretB32, z + d));
    if (crypto.timingSafeEqual(soll, Buffer.from(code))) return z + d;
  }
  return null;
}

function scryptHash(pw: string): string {
  const salz = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salz, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$15$${salz.toString('base64')}$${h.toString('base64')}`;
}
function scryptPruefe(pw: string, gespeichert: string): boolean {
  const [art, n, salz, hash] = gespeichert.split('$');
  if (art !== 'scrypt' || !n || !salz || !hash) return false;
  const soll = Buffer.from(hash, 'base64');
  const ist = crypto.scryptSync(pw, Buffer.from(salz, 'base64'), soll.length, { N: 1 << Number(n), r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(soll, ist);
}

export class Admins {
  constructor(private db: DB, private jetzt: () => Date = () => new Date()) {}

  anzahl(): number { return (this.db.prepare('SELECT COUNT(*) AS n FROM admins').get() as { n: number }).n; }

  /** Legt einen Admin an und gibt das TOTP-Geheimnis einmalig zurück (für die Authenticator-App). */
  anlegen(name: string, passwort: string): { secret: string; uri: string } {
    if (!/^[a-z0-9._-]{2,40}$/.test(name)) throw new Error('Name: 2–40 Zeichen a–z, 0–9, . _ -');
    if (passwort.length < 14) throw new Error('Passwort: mindestens 14 Zeichen');
    const secret = base32(crypto.randomBytes(20));
    this.db.prepare('INSERT INTO admins (name, pw_hash, totp_secret, erstellt) VALUES (?, ?, ?, ?)').run(name, scryptHash(passwort), secret, this.jetzt().toISOString());
    const uri = `otpauth://totp/${encodeURIComponent('Kern Leitstand')}:${encodeURIComponent(name)}?secret=${secret}&issuer=${encodeURIComponent('Kern Leitstand')}&algorithm=SHA1&digits=6&period=30`;
    return { secret, uri };
  }

  /** Alle drei Teile müssen stimmen; derselbe TOTP-Code gilt nur einmal. Fehlermeldung verrät nicht, was falsch war. */
  pruefe(name: string, passwort: string, code: string): boolean {
    const r = this.db.prepare('SELECT * FROM admins WHERE name = ?').get(name) as { pw_hash: string; totp_secret: string; totp_letzter: number } | undefined;
    if (!r) { scryptHash(passwort); return false; } // gleiche Laufzeit wie bei vorhandenem Namen
    if (!scryptPruefe(passwort, r.pw_hash)) return false;
    const z = pruefeTotp(r.totp_secret, code, this.jetzt().getTime());
    if (z === null || z <= r.totp_letzter) return false;
    this.db.prepare('UPDATE admins SET totp_letzter = ? WHERE name = ?').run(z, name);
    return true;
  }

  // Bearer-Tokens für Automatisierung (/v1), nur als Hash gespeichert
  tokenErzeugen(name: string): string {
    const t = 'kbt_' + crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO tokens (hash, name, erstellt) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(t).digest('hex'), name, this.jetzt().toISOString());
    return t;
  }
  tokenPruefe(t: string | undefined): string | null {
    if (!t || !t.startsWith('kbt_')) return null;
    const r = this.db.prepare('SELECT name FROM tokens WHERE hash = ?').get(crypto.createHash('sha256').update(t).digest('hex')) as { name: string } | undefined;
    return r ? `token:${r.name}` : null;
  }
}

export class Sitzungen {
  private daten = new Map<string, { name: string; bis: number; csrf: string; letzte: number }>();
  constructor(private secret: string, private dauerMs = 8 * 3600_000, private leerlaufMs = 30 * 60_000) {}
  private sig(id: string) { return crypto.createHmac('sha256', this.secret).update(id).digest('base64url'); }
  erstelle(name: string): { cookie: string; csrf: string } {
    const id = crypto.randomBytes(24).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    this.daten.set(id, { name, bis: Date.now() + this.dauerMs, csrf, letzte: Date.now() });
    return { cookie: `${id}.${this.sig(id)}`, csrf };
  }
  pruefe(cookie: string | undefined): { name: string; csrf: string } | null {
    if (!cookie) return null;
    const [id, sig] = cookie.split('.');
    if (!id || !sig) return null;
    const a = Buffer.from(this.sig(id)), b = Buffer.from(sig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const s = this.daten.get(id);
    if (!s) return null;
    const jetzt = Date.now();
    if (s.bis < jetzt || s.letzte + this.leerlaufMs < jetzt) { this.daten.delete(id); return null; }
    s.letzte = jetzt;
    return { name: s.name, csrf: s.csrf };
  }
  beende(cookie: string | undefined) { const id = cookie?.split('.')[0]; if (id) this.daten.delete(id); }
}

export class Ratenlimit {
  private f = new Map<string, number[]>();
  constructor(private max: number, private fensterMs: number) {}
  gesperrt(k: string) { const j = Date.now(); const l = (this.f.get(k) ?? []).filter((t) => t > j - this.fensterMs); this.f.set(k, l); return l.length >= this.max; }
  fehlschlag(k: string) { const l = this.f.get(k) ?? []; l.push(Date.now()); this.f.set(k, l); }
  zuruecksetzen(k: string) { this.f.delete(k); }
}
