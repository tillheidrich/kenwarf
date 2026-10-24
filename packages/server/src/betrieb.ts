import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Hono, Context } from 'hono';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import type { KernLike, User } from './types.js';
import type { ZugangLike } from './zugang.js';
import type { Sicherheitsprotokoll } from './protokoll.js';
import type { Exporte } from './export.js';
import { leseVerbrauch } from './kontingent.js';
import { statusAusFehler } from './fehler.js';

/**
 * v1.4 3.2 und 3.4: Betriebs-Endpunkte der Instanz für den Leitstand.
 * Grundsatz 0.1: nur Zahlen, nie Titel, Dateinamen, Texte, Fragen oder Namen von Kundenbenutzern.
 * O-1: nur aus dem internen Netz (Socket-Adresse privat oder Loopback, kein X-Forwarded-For) und nur mit
 * KERN_BETRIEB_TOKEN. Das Betriebs-Token öffnet keine /api- oder /mcp-Route (dort zählt es nicht als Sitzung oder Zugang).
 */
export type Modus = 'normal' | 'nur_lesen' | 'pausiert';

export interface Grenzwerte {
  nutzer_max: number | null;
  speicher_max_bytes: number | null;
  upload_max_bytes: number | null;
  ki_kontingent_cent_monat: number | null;
  ki_tagesdeckel_cent: number | null;
}

interface Gespeichert { modus: Modus; grenzen: Grenzwerte; geaendert: string | null }

const LEER: Grenzwerte = { nutzer_max: null, speicher_max_bytes: null, upload_max_bytes: null, ki_kontingent_cent_monat: null, ki_tagesdeckel_cent: null };

/** Modus und Grenzen in `.kern/betrieb.json` (nicht git, überlebt Neustarts). */
export class Betriebszustand {
  private datei: string;
  private stand: Gespeichert;
  private speicherCache: { bytes: number; am: number } | null = null;
  constructor(private dataDir: string) {
    this.datei = path.join(dataDir, '.kern', 'betrieb.json');
    let s: Partial<Gespeichert> = {};
    try { s = JSON.parse(fs.readFileSync(this.datei, 'utf8')) as Partial<Gespeichert>; } catch { /* neu */ }
    this.stand = { modus: s.modus ?? 'normal', grenzen: { ...LEER, ...(s.grenzen ?? {}) }, geaendert: s.geaendert ?? null };
  }
  get modus(): Modus { return this.stand.modus; }
  get grenzen(): Grenzwerte { return this.stand.grenzen; }
  private speichere() {
    this.stand.geaendert = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.datei), { recursive: true });
    const tmp = `${this.datei}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.stand, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.datei);
  }
  setzeModus(m: Modus) { this.stand.modus = m; this.speichere(); }
  setzeGrenzen(g: Partial<Grenzwerte>) { this.stand.grenzen = { ...this.stand.grenzen, ...g }; this.speichere(); }

  /** Belegter Speicher des Datenordners (Bytes), 60 s zwischengespeichert. */
  speicherBytes(): number {
    if (this.speicherCache && Date.now() - this.speicherCache.am < 60_000) return this.speicherCache.bytes;
    let summe = 0;
    const lauf = (d: string) => {
      let e: fs.Dirent[] = [];
      try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of e) {
        const p = path.join(d, x.name);
        if (x.isDirectory()) lauf(p);
        else if (x.isFile()) { try { summe += fs.statSync(p).size; } catch { /* weg */ } }
      }
    };
    lauf(this.dataDir);
    this.speicherCache = { bytes: summe, am: Date.now() };
    return summe;
  }
  zaehleMd(ordner: string): number {
    let n = 0;
    const lauf = (d: string) => {
      let e: fs.Dirent[] = [];
      try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const x of e) {
        if (x.isDirectory()) lauf(path.join(d, x.name));
        else if (x.name.endsWith('.md') && !x.name.includes('.orig.') && x.name !== 'index.md' && x.name !== 'log.md') n++;
      }
    };
    lauf(path.join(this.dataDir, ordner));
    return n;
  }
}

/** Privat, Loopback oder Link-Local (Docker-Netze). */
export function istInternesNetz(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(v4)) return true;
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
}

export interface BetriebOptionen {
  kern: KernLike;
  config: ServerConfig;
  zustand: Betriebszustand;
  zugang: ZugangLike;
  socketIp: (c: Context) => string | undefined;
  protokoll: Sicherheitsprotokoll;
  version?: string;
  /** 7.1: Export über den Leitstand (Link geht nur an Admins der Instanz). */
  exporte?: Exporte;
}

const BETRIEBSKONTO: User = { id: 'betrieb', name: 'betrieb', rollen: ['admin'], teams: [] };

export function betriebsRouten(app: Hono, o: BetriebOptionen): void {
  const { kern, config, zustand, zugang } = o;
  app.use('/_betrieb/*', async (c, next) => {
    const nichtDa = () => c.json({ fehler: 'Nicht gefunden.' }, 404);
    if (!config.betriebTokenHash) return nichtDa();
    if (!istInternesNetz(o.socketIp(c)) || c.req.header('x-forwarded-for') || c.req.header('forwarded')) {
      o.protokoll.schreibe({ ereignis: 'betrieb_zugriff_abgelehnt', benutzer: null, ergebnis: 'abgelehnt' });
      return nichtDa();
    }
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const soll = Buffer.from(config.betriebTokenHash, 'hex');
    const ist = crypto.createHash('sha256').update(m?.[1] ?? '').digest();
    if (!m || !crypto.timingSafeEqual(soll, ist)) {
      o.protokoll.schreibe({ ereignis: 'betrieb_zugriff_abgelehnt', benutzer: null, ergebnis: 'abgelehnt' });
      return c.json({ fehler: 'Nicht berechtigt.' }, 401);
    }
    c.header('Cache-Control', 'no-store');
    return next();
  });

  const json = async <T>(c: Context, s: z.ZodType<T>): Promise<T> => {
    const r = s.safeParse(await c.req.json().catch(() => null));
    if (!r.success) throw Object.assign(new Error(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), { status: 400 });
    return r.data;
  };

  const zaehleOauth = async (): Promise<number> => {
    let n = 0;
    for (const u of await kern.benutzer.liste()) {
      const clients = new Set(zugang.liste(BETRIEBSKONTO, u.id, { art: ['oauth_erneuerung', 'oauth_zugriff'] }).map((e) => e.clientId ?? e.id));
      n += clients.size;
    }
    return n;
  };

  app.get('/_betrieb/status', async (c) => {
    const nutzer = (await kern.benutzer.liste()).length;
    const v = await leseVerbrauch(kern);
    return c.json({
      ok: true,
      version: o.version ?? '0.1.0',
      modus: zustand.modus,
      nutzer,
      artikel: zustand.zaehleMd('wissen'),
      quellen: zustand.zaehleMd('quellen'),
      speicher_bytes: zustand.speicherBytes(),
      zugaenge_oauth: await zaehleOauth(),
      ki_art: config.kern.provider.art,
      // 3.4: aus core `verbrauch()` (Tagessummen ohne Personen); null, solange core keinen Zähler hat.
      ki_verbrauch_cent_monat: v ? v.cent_monat : null,
      ki_verbrauch_cent_heute: v ? v.cent_heute : null,
      ki_kontingent_cent_monat: zustand.grenzen.ki_kontingent_cent_monat,
      grenzen: zustand.grenzen,
    });
  });

  app.post('/_betrieb/modus', async (c) => {
    const b = await json(c, z.object({ modus: z.enum(['normal', 'nur_lesen', 'pausiert']) }).strict());
    zustand.setzeModus(b.modus);
    o.protokoll.schreibe({ ereignis: 'modus', benutzer: 'betrieb', ergebnis: 'ok', ziel: b.modus });
    return c.json({ modus: zustand.modus });
  });

  const zahlOderNull = z.number().int().min(0).nullable();
  app.post('/_betrieb/grenzen', async (c) => {
    const b = await json(c, z.object({
      nutzer_max: zahlOderNull.optional(), speicher_max_bytes: zahlOderNull.optional(), upload_max_bytes: zahlOderNull.optional(),
      ki_kontingent_cent_monat: zahlOderNull.optional(), ki_tagesdeckel_cent: zahlOderNull.optional(),
    }).strict());
    zustand.setzeGrenzen(b);
    return c.json({ grenzen: zustand.grenzen });
  });

  // Erster Admin einer neuen Instanz: Einmalpasswort, Pflicht zum Wechsel. Antwort ohne Namen (nur ID).
  app.post('/_betrieb/einladung', async (c) => {
    const b = await json(c, z.object({ name: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N}._@ -]+$/u), rollen: z.array(z.enum(['leser', 'autor', 'freigeber', 'admin'])).min(1).default(['admin']) }).strict());
    const alle = await kern.benutzer.liste();
    if (alle.some((u) => u.name.toLowerCase() === b.name.toLowerCase())) return c.json({ fehler: 'Diesen Zugang gibt es schon.' }, 409);
    const max = zustand.grenzen.nutzer_max;
    if (max !== null && alle.length >= max) return c.json({ fehler: 'Nutzergrenze des Pakets erreicht. Stufe wechseln.', code: 'kontingent' }, 409);
    const einmal = crypto.randomBytes(12).toString('base64url');
    const u = await kern.benutzer.anlegen(b.name, einmal, b.rollen);
    if (typeof kern.benutzer.aendere === 'function') await kern.benutzer.aendere(u.id, { mussPasswortAendern: true });
    o.protokoll.schreibe({ ereignis: 'benutzer_angelegt', benutzer: 'betrieb', ergebnis: 'ok', ziel: u.id });
    return c.json({ benutzer_id: u.id, einmalPasswort: einmal, mussPasswortAendern: typeof kern.benutzer.aendere === 'function' }, 201);
  });

  app.post('/_betrieb/beispiel', async (c) => {
    const b = await json(c, z.object({ aktion: z.enum(['laden', 'entfernen']) }).strict());
    const admin = (await kern.benutzer.liste()).find((u) => u.rollen.includes('admin'));
    if (!admin) return c.json({ fehler: 'Kein Admin angelegt.' }, 409);
    const fn = b.aktion === 'laden' ? kern.beispielLaden : kern.beispielEntfernen;
    if (typeof fn !== 'function') return c.json({ fehler: 'Diese core-Version hat keine Beispielsammlung.' }, 501);
    await fn.call(kern, admin);
    return c.json({ ok: true, quellen: zustand.zaehleMd('quellen') });
  });

  // 7.1: Der Leitstand löst denselben Export aus wie POST /api/export. Antwort ohne Link und ohne Dateinamen;
  // den Link sehen nur Admins der Instanz (GET /api/export), Grundsatz 0.1.
  app.post('/_betrieb/export', async (c) => {
    if (!o.exporte) return c.json({ fehler: 'Export nicht verfügbar.' }, 501);
    const b = await json(c, z.object({ art: z.enum(['okf', 'zip', 'umzugspaket']), passphrase: z.string().min(12).max(500).optional(), warten: z.boolean().default(true) }).strict());
    const admin = (await kern.benutzer.liste()).find((u) => u.rollen.includes('admin'));
    if (!admin) return c.json({ fehler: 'Kein Admin angelegt.' }, 409);
    // Stufenwechsel (O1 1.8.4): Der Leitstand braucht für das Ziel eine Passphrase. Gibt er keine mit, erzeugt die
    // Instanz eine und gibt sie genau in dieser Antwort zurück (nirgends gespeichert). Der Leitstand hält ohnehin die
    // Sicherungsschlüssel der Instanz; ein neuer Zugriff auf Inhalte entsteht dadurch nicht.
    const erzeugt = b.art === 'umzugspaket' && !b.passphrase ? crypto.randomBytes(24).toString('base64url') : null;
    try {
      const a = o.exporte.starte(kern, { ...admin, rollen: ['admin'] }, b.art, { passphrase: b.passphrase ?? erzeugt ?? undefined, von: 'betrieb' });
      o.protokoll.schreibe({ ereignis: 'export', benutzer: 'betrieb', ergebnis: 'ok', ziel: `${b.art}:${a.id}` });
      if (!b.warten) return c.json({ id: a.id, art: a.art, status: a.status, ...(erzeugt ? { passphrase: erzeugt } : {}) }, 202);
      // P2-Client erwartet bytes und sha256 in der Antwort: bis zu 120 s warten, sonst 202 mit id.
      const f = (await o.exporte.warte(a.id, 120_000)) ?? a;
      if (f.status === 'fehler') return c.json({ id: f.id, art: f.art, status: f.status, fehler: f.fehler }, 500);
      return c.json({
        id: f.id, art: f.art, status: f.status, bytes: f.bytes ?? null, sha256: f.sha256 ?? null, bereit_bis: f.bereit_bis,
        datei: f.status === 'fertig' ? o.exporte.pfad(f) : null, ...(erzeugt ? { passphrase: erzeugt } : {}),
      }, f.status === 'fertig' ? 200 : 202);
    } catch (e) {
      const sf = statusAusFehler(e);
      return c.json({ fehler: sf.meldung }, sf.status as 400);
    }
  });
  app.get('/_betrieb/export/:id', (c) => {
    const a = o.exporte?.hole(c.req.param('id'));
    if (!a || a.von !== 'betrieb') return c.json({ fehler: 'Nicht gefunden.' }, 404);
    return c.json({ id: a.id, art: a.art, status: a.status, bytes: a.bytes ?? null, sha256: a.sha256 ?? null, bereit_bis: a.bereit_bis });
  });
  // Stufenwechsel am Ziel (O1 1.8.4): Prüfbericht nach dem Import beim Start (KERN_IMPORT_PAKET, siehe index.ts).
  // Nur Wahrheitswerte und Zahlen, keine Pfade oder Abweichungstexte (Grundsatz 0.1).
  const berichtDatei = path.join(config.dataDir, '.kern', 'pruefbericht.json');
  const berichtAnsicht = () => {
    let roh: Buffer;
    try { roh = fs.readFileSync(berichtDatei); } catch { return null; }
    const b = JSON.parse(roh.toString('utf8')) as Record<string, unknown>;
    const pb = b.pruefbank as { gleich?: boolean } | null | undefined;
    return {
      format: b.format, am: b.am, manifest_sha256: b.manifest_sha256, pruefsummen_ok: b.pruefsummen_ok, git_fsck_ok: b.git_fsck_ok,
      head_gleich: b.head_gleich, index_neu: b.index_neu, pruefen_befunde_neu: b.pruefen_befunde_neu,
      pruefbank_gleich: pb ? pb.gleich ?? null : null, bestanden: b.bestanden,
      // Bestätigung im Leitstand: POST /v1/instanzen/:id/umzug/bestaetigen { pruefbericht_sha256 } (7.3)
      pruefbericht_sha256: crypto.createHash('sha256').update(roh).digest('hex'),
    };
  };
  app.get('/_betrieb/pruefbericht', (c) => {
    const b = berichtAnsicht();
    return b ? c.json(b) : c.json({ fehler: 'Kein Prüfbericht (kein Umzug in diese Instanz).' }, 404);
  });
  app.post('/_betrieb/pruefbericht', async (c) => {
    const k = kern as KernLike & { umzugPruefen?: (u: User) => Promise<unknown> };
    if (typeof k.umzugPruefen !== 'function') return c.json({ fehler: 'Diese core-Version prüft keinen Umzug.' }, 501);
    if (!fs.existsSync(path.join(config.dataDir, '.kern', 'umzug-manifest.json'))) return c.json({ fehler: 'Kein Umzug in diese Instanz.' }, 404);
    const admin = (await kern.benutzer.liste()).find((u) => u.rollen.includes('admin'));
    if (!admin) return c.json({ fehler: 'Kein Admin angelegt.' }, 409);
    try { await k.umzugPruefen({ ...admin, rollen: ['admin'] }); } catch (e) { const sf = statusAusFehler(e); return c.json({ fehler: sf.meldung }, sf.status as 400); }
    return c.json(berichtAnsicht());
  });

  app.all('/_betrieb/*', (c) => c.json({ fehler: 'Nicht gefunden.' }, 404));
}
