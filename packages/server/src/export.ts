import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExportArt, KernLike, User } from './types.js';
import { KernFehler, keineRechte, statusAusFehler } from './fehler.js';
import { sammleDateien, schreibeZip } from './zip.js';

/**
 * v1.4 7.1: Exportaufträge. `POST /api/export` legt einen Auftrag an (202), die Arbeit läuft im Hintergrund,
 * `GET /api/export/:id` liefert den Stand. Der Link ist signiert, 7 Tage gültig und nur für den Auslösenden
 * (bei Aufträgen des Leitstands: für Admins der Instanz). Aufträge liegen in `.kern/export/<id>/` (nicht git,
 * nicht im Export) und überleben Neustarts; abgelaufene werden beim nächsten Zugriff gelöscht.
 */
export interface ExportAuftrag {
  id: string;
  art: ExportArt;
  von: string;                      // Benutzer-ID oder 'betrieb'
  status: 'laeuft' | 'fertig' | 'fehler';
  erstellt: string;
  bereit_bis: string | null;
  bytes?: number;
  sha256?: string;
  ausgelassen?: number;
  datei?: string;                   // Dateiname im Auftragsordner
  fehler?: string;
}

const TAGE = 7;
const ID = /^x_[a-f0-9]{24}$/;

export class Exporte {
  private ordner: string;
  constructor(private dataDir: string, private secret: string, private produkt: string) {
    this.ordner = path.join(dataDir, '.kern', 'export');
  }

  private meta(id: string) { return path.join(this.ordner, id, 'auftrag.json'); }
  private schreibe(a: ExportAuftrag) {
    fs.mkdirSync(path.dirname(this.meta(a.id)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.meta(a.id), JSON.stringify(a, null, 2), { mode: 0o600 });
  }
  hole(id: string): ExportAuftrag | null {
    if (!ID.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(this.meta(id), 'utf8')) as ExportAuftrag; } catch { return null; }
  }
  /** Aufträge, die `u` sehen darf: eigene; Admins zusätzlich die des Leitstands. */
  liste(u: User): ExportAuftrag[] {
    this.raeumeAuf();
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.ordner); } catch { return []; }
    return ids.map((i) => this.hole(i)).filter((a): a is ExportAuftrag => !!a && this.darfSehen(u, a)).sort((a, b) => b.erstellt.localeCompare(a.erstellt));
  }
  darfSehen(u: User | null, a: ExportAuftrag): boolean {
    if (!u) return false;
    return a.von === u.id || (a.von === 'betrieb' && u.rollen.includes('admin'));
  }
  datei(a: ExportAuftrag): string | null {
    if (!a.datei || a.status !== 'fertig') return null;
    const p = path.join(this.ordner, a.id, a.datei);
    return fs.existsSync(p) ? p : null;
  }
  raeumeAuf(jetzt = Date.now()) {
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.ordner); } catch { return; }
    for (const id of ids) {
      const a = this.hole(id);
      const alt = a ? (a.bereit_bis ? Date.parse(a.bereit_bis) < jetzt : Date.parse(a.erstellt) + TAGE * 86400_000 < jetzt) : true;
      if (alt) fs.rmSync(path.join(this.ordner, id), { recursive: true, force: true });
    }
  }

  signatur(a: ExportAuftrag): string {
    return crypto.createHmac('sha256', this.secret).update(`export|${a.id}|${a.von}|${a.bereit_bis}`).digest('base64url');
  }
  link(a: ExportAuftrag): string | undefined {
    return a.status === 'fertig' ? `api/export/${a.id}/datei?sig=${this.signatur(a)}` : undefined;
  }
  pruefeSignatur(a: ExportAuftrag, sig: string): boolean {
    const soll = Buffer.from(this.signatur(a));
    const ist = Buffer.from(sig);
    return soll.length === ist.length && crypto.timingSafeEqual(soll, ist);
  }

  /** Öffentliche Sicht ohne Dateinamen und Pfade. */
  ansicht(a: ExportAuftrag) {
    return { id: a.id, art: a.art, status: a.status, erstellt: a.erstellt, bytes: a.bytes, sha256: a.sha256, ausgelassen: a.ausgelassen, link: this.link(a), bereit_bis: a.bereit_bis ?? undefined, fehler: a.fehler, ausgeloest_von: a.von === 'betrieb' ? 'betrieb' : 'du' };
  }

  /**
   * Startet einen Auftrag. `u` ist der handelnde Mensch (beim Leitstand: ein Admin der Instanz), `von` die Zuordnung.
   * Rechte nach 7.1: Umzugspaket nur admin; OKF und ZIP prüft core nach Rechten (N1).
   */
  starte(kern: KernLike, u: User, art: ExportArt, o: { passphrase?: string; von?: string } = {}): ExportAuftrag {
    if (art === 'umzugspaket') {
      if (!u.rollen.includes('admin')) throw keineRechte('Das Umzugspaket kann nur ein Admin erstellen.');
      if (!o.passphrase || o.passphrase.length < 12) throw new KernFehler(400, 'Das Umzugspaket braucht eine Passphrase mit mindestens 12 Zeichen. Ohne sie lässt es sich nicht öffnen; wir können sie nicht wiederherstellen.', 'ungueltig');
    }
    if (typeof kern.exportiere !== 'function' && !(art === 'okf' && typeof kern.exportiereOkf === 'function')) {
      throw new KernFehler(501, art === 'okf' ? 'Diese core-Version kann noch nicht exportieren.' : `Export „${art}“ kommt mit dem core-Export (v1.4 7.1). Bis dahin: OKF-Export oder „kern export“ auf dem Server.`);
    }
    this.raeumeAuf();
    const a: ExportAuftrag = { id: `x_${crypto.randomBytes(12).toString('hex')}`, art, von: o.von ?? u.id, status: 'laeuft', erstellt: new Date().toISOString(), bereit_bis: null };
    this.schreibe(a);
    const p = this.lauf(kern, u, a, o.passphrase).catch(() => a).finally(() => this.laufend.delete(a.id));
    this.laufend.set(a.id, p);
    return a;
  }
  private laufend = new Map<string, Promise<ExportAuftrag>>();
  /** Wartet höchstens `ms` auf das Ende eines Auftrags (für den Leitstand, der Bytes und Prüfsumme sofort braucht). */
  async warte(id: string, ms: number): Promise<ExportAuftrag | null> {
    const p = this.laufend.get(id);
    if (p) await Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    return this.hole(id);
  }
  /** Absoluter Pfad der fertigen Datei (nur für den Leitstand im internen Netz, z. B. für `docker cp`). */
  pfad(a: ExportAuftrag): string | null { return this.datei(a); }

  /** Läuft im Hintergrund; Fehler landen im Auftrag ohne Pfade. */
  async lauf(kern: KernLike, u: User, a: ExportAuftrag, passphrase?: string): Promise<ExportAuftrag> {
    const dir = path.join(this.ordner, a.id);
    const datum = new Date().toISOString().slice(0, 10);
    const slug = this.produkt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kern';
    const name = a.art === 'umzugspaket' ? `umzug-${slug}-${datum}.tar.age` : a.art === 'okf' ? `${slug}-okf-${datum}.zip` : `${slug}-export-${datum}.zip`;
    const ziel = path.join(dir, name);
    try {
      let ausgelassen: number | undefined;
      if (typeof kern.exportiere === 'function') {
        const r = await kern.exportiere(u, { art: a.art, ziel, ...(passphrase ? { passphrase } : {}) });
        ausgelassen = r.ausgelassen;
        if (r.datei && path.resolve(r.datei) !== ziel) await fsp.rename(r.datei, ziel);
      } else {
        // Rückfall nur für OKF: core exportiert nach Rechten in einen Ordner, der Server packt ihn.
        const tmp = path.join(dir, 'okf');
        await fsp.mkdir(tmp, { recursive: true });
        const r = (await kern.exportiereOkf!(tmp, { fuer: u })) as { ausgelassen?: number };
        ausgelassen = r?.ausgelassen;
        schreibeZip(tmp, sammleDateien(tmp, () => false), ziel);
        await fsp.rm(tmp, { recursive: true, force: true });
      }
      const inhalt = await fsp.readFile(ziel);
      const fertig: ExportAuftrag = { ...a, status: 'fertig', datei: name, bytes: inhalt.length, sha256: crypto.createHash('sha256').update(inhalt).digest('hex'), ausgelassen, bereit_bis: new Date(Date.now() + TAGE * 86400_000).toISOString() };
      this.schreibe(fertig);
      return fertig;
    } catch (e) {
      const sf = statusAusFehler(e);
      const meldung = sf.status < 500 ? sf.meldung : 'Der Export ist fehlgeschlagen. Bitte erneut versuchen; Wissen und Quellen sind unverändert.';
      const f: ExportAuftrag = { ...a, status: 'fehler', fehler: meldung, bereit_bis: new Date(Date.now() + 86400_000).toISOString() };
      this.schreibe(f);
      return f;
    }
  }
}
