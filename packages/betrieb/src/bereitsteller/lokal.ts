/**
 * Lokaler Bereitsteller: jede Instanz ist ein echter Kern-Datenordner unter `basis/<id>/daten`, angelegt mit @kern/core.
 * Kein Container, kein Netz. Zweck: Pitch auf dem eigenen Rechner, Probelauf der Abläufe mit echter Engine.
 * Der Leitstand liest nur Größe, Benutzerzahl und Modus, nie Dateien oder Namen.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Auftrag, Bereitsteller, DemoZugang, Modus, SchrittErgebnis, Wechselauftrag } from './typ.js';
import { STANDARD_SCHRITTE, WECHSEL_SCHRITTE } from './typ.js';
import type { Beispiel } from '../typen.js';

const exec = promisify(execFile);

export function beispielOrdner(satz: Beispiel): string {
  return fileURLToPath(new URL(`../../beispiele/${satz}/`, import.meta.url));
}

async function ordnerGroesse(p: string): Promise<number> {
  let summe = 0;
  const stapel = [p];
  while (stapel.length) {
    const d = stapel.pop()!;
    let eintraege: fs.Dirent[];
    try { eintraege = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of eintraege) {
      const voll = path.join(d, e.name);
      if (e.isDirectory()) stapel.push(voll);
      else if (e.isFile()) summe += (await fsp.stat(voll)).size;
    }
  }
  return summe;
}

export class LokalBereitsteller implements Bereitsteller {
  readonly name = 'lokal';
  readonly schritte = STANDARD_SCHRITTE;
  readonly wechselSchritte = WECHSEL_SCHRITTE;
  constructor(private basis: string, private urlBasis = 'http://localhost') {}

  private ordner(id: string) {
    if (!/^i_[a-z0-9]{10}$/.test(id)) throw new Error('ungültige Instanz-ID');
    return path.join(this.basis, id);
  }

  async schritt(name: string, a: Auftrag): Promise<SchrittErgebnis> {
    const o = this.ordner(a.id);
    const daten = path.join(o, 'daten');
    switch (name) {
      case 'subdomain_pruefen':
        return {};
      case 'schluessel_erzeugen': {
        // Betriebs-Token je Instanz: in der Instanz nur als Hash (O1 1.7). Der Klartext liegt nur beim Leitstand.
        await fsp.mkdir(o, { recursive: true });
        const hashDatei = path.join(o, 'betrieb-token.sha256');
        // Konto-Token (v1.4 3.5) geht als Umgebungsvariable in die Instanz; lokal als Datei mit 0600.
        await fsp.writeFile(path.join(o, 'konto-token'), a.konto_token, { mode: 0o600 });
        if (!fs.existsSync(hashDatei)) {
          const token = crypto.randomBytes(32).toString('base64url');
          await fsp.writeFile(hashDatei, crypto.createHash('sha256').update(token).digest('hex'), { mode: 0o600 });
        }
        return { meldung: 'Betriebs-Token erzeugt (nur Hash in der Instanz)' };
      }
      case 'volume_anlegen':
        await fsp.mkdir(daten, { recursive: true });
        await fsp.mkdir(path.join(o, 'daten-export'), { recursive: true });
        return {};
      case 'container_starten': {
        const core = await import('@kern/core');
        const k = await core.Kern.open({ dataDir: daten, provider: { art: 'mock' }, betrieb: a.subdomain, sprache: 'de' });
        await k.schliesse();
        await fsp.writeFile(path.join(o, 'modus'), 'normal');
        return { url: `${this.urlBasis}/${a.subdomain}`, version: '0.1.0' };
      }
      case 'healthz_warten':
        if (!fs.existsSync(path.join(daten, '.git'))) throw new Error('Datenordner ohne git');
        return { meldung: 'Datenordner und git vorhanden' };
      case 'admin_einladen':
        return { meldung: a.admin_mail ? 'Einladung vorgemerkt (lokal kein Mailversand)' : 'keine Mail angegeben' };
      case 'beispiel_laden':
        if (!a.beispiel) return { meldung: 'übersprungen' };
        const z = await this.ladeBeispiel(a.id, a.beispiel);
        return { meldung: `Beispiel ${a.beispiel} geladen (${z.length} Demo-Zugänge, Passwörter zufällig)`, demo_zugaenge: z };
      default:
        return {};
    }
  }

  async status(id: string) {
    const o = this.ordner(id);
    const daten = path.join(o, 'daten');
    if (!fs.existsSync(daten)) return { version: '0.1.0', modus: 'pausiert' as const, ki_verbrauch_cent_monat: 0, ki_kontingent_cent_monat: null, zugaenge_oauth: 0, speicher_bytes: 0, benutzer: 0, letzte_anmeldung_tag: null, backup_letztes: null, backup_ok: false, health: 'aus' as const };
    let benutzer = 0;
    try {
      const u = JSON.parse(await fsp.readFile(path.join(daten, '.kern', 'users.json'), 'utf8')) as unknown;
      benutzer = Array.isArray(u) ? u.length : Array.isArray((u as { benutzer?: unknown[] }).benutzer) ? (u as { benutzer: unknown[] }).benutzer.length : 0;
    } catch { /* noch keine Benutzer */ }
    const modus = fs.existsSync(path.join(o, 'modus')) ? (await fsp.readFile(path.join(o, 'modus'), 'utf8')).trim() : 'normal';
    return {
      version: '0.1.0',
      speicher_bytes: await ordnerGroesse(daten),
      benutzer,
      letzte_anmeldung_tag: null,
      backup_letztes: null,
      backup_ok: true, // lokal kein Backup-Agent; ehrlich als „nicht zutreffend“ in der UI gekennzeichnet
      health: modus === 'pausiert' ? ('aus' as const) : ('ok' as const),
      modus: (modus === 'nur_lesen' || modus === 'pausiert' ? modus : 'normal') as 'normal',
      ki_verbrauch_cent_monat: 0,
      ki_kontingent_cent_monat: await fsp.readFile(path.join(o, 'grenzen.json'), 'utf8').then((x) => (JSON.parse(x) as { ki_kontingent_cent_monat: number | null }).ki_kontingent_cent_monat).catch(() => null),
      zugaenge_oauth: 0,
    };
  }

  async grenzen(id: string, g: import('./typ.js').Grenzen) { await fsp.writeFile(path.join(this.ordner(id), 'grenzen.json'), JSON.stringify(g)); }
  async egress(id: string, hosts: string[]) { await fsp.writeFile(path.join(this.ordner(id), 'egress.json'), JSON.stringify(hosts)); }
  async modus(id: string, m: Modus) { await fsp.writeFile(path.join(this.ordner(id), 'modus'), m); }

  async export(id: string, art: 'umzugspaket' | 'okf') {
    const o = this.ordner(id);
    const ziel = path.join(o, 'daten-export', `${art}.tar.gz`);
    await exec('tar', ['-czf', ziel, '-C', path.join(o, 'daten'), '.']);
    const buf = await fsp.readFile(ziel);
    return { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }

  async beispiel(id: string, aktion: 'laden' | 'entfernen', satz: Beispiel | null) {
    if (aktion === 'laden') { await this.ladeBeispiel(id, satz); return; }
    await this.entferneBeispiel(id);
  }

  private async entferneBeispiel(id: string) {
    const daten = path.join(this.ordner(id), 'daten');
    const core = await import('@kern/core');
    // Beispieldaten entfernen = Datenordner leeren und neu anlegen (Demo hat keine Kundendaten).
    await fsp.rm(daten, { recursive: true, force: true });
    await fsp.mkdir(daten, { recursive: true });
    const k = await core.Kern.open({ dataDir: daten, provider: { art: 'mock' }, betrieb: 'neu', sprache: 'de' });
    await k.schliesse();
  }

  /** Lädt die Beispielsammlung. Passwörter der Demo-Zugänge sind zufällig (S1 N2) und kommen nur hier zurück. */
  async ladeBeispiel(id: string, satz: Beispiel | null): Promise<DemoZugang[]> {
    const daten = path.join(this.ordner(id), 'daten');
    const core = await import('@kern/core');
    if (satz === 'tischlerei-wendt') {
      const r = (await core.seedDemo(daten, { provider: { art: 'mock' } })) as { benutzer?: { name: string; passwort: string; rollen: string[] }[] };
      return (r.benutzer ?? []).filter((b) => b.passwort).map((b) => ({ name: b.name, passwort: b.passwort, rollen: [...b.rollen] }));
    }
    const neu: DemoZugang[] = [];
    if (satz === 'kanzlei-behrens') {
      await fsp.cp(beispielOrdner(satz), daten, { recursive: true, force: false, errorOnExist: false });
      const k = await core.Kern.open({ dataDir: daten, provider: { art: 'mock' }, betrieb: 'Kanzlei Behrens (Beispiel)', sprache: 'de' });
      try {
        const vorhanden = await k.benutzer.liste();
        const plan: [string, ('admin' | 'freigeber' | 'autor')[], string[]][] = [['Dr. Wiebke Behrens', ['admin'], ['kanzlei']], ['Ole Thormählen', ['freigeber'], ['kanzlei']], ['Merle Paulsen', ['autor'], ['sekretariat']]];
        for (const [name, rollen, teams] of plan) {
          if (vorhanden.some((u) => u.name === name)) continue;
          const pw = crypto.randomBytes(12).toString('base64url'); // S1 N2: keine festen Demo-Passwörter
          await k.benutzer.anlegen(name, pw, rollen, teams);
          neu.push({ name, passwort: pw, rollen });
        }
        await k.uebernimmAenderungen('Dr. Wiebke Behrens', 'Beispielkanzlei Behrens angelegt');
      } finally {
        await k.schliesse();
      }
    }
    return neu;
  }

  /** Prüfsumme über alle Dateien (Pfad + Inhalt, sortiert), ohne den wegwerfbaren Index. */
  static async baumHash(ordner: string): Promise<string> {
    const h = crypto.createHash('sha256');
    const dateien: string[] = [];
    const stapel = [''];
    while (stapel.length) {
      const rel = stapel.pop()!;
      for (const e of await fsp.readdir(path.join(ordner, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (r === path.join('.kern', 'index.sqlite') || r.startsWith(path.join('.kern', 'index.sqlite'))) continue;
        if (e.isDirectory()) stapel.push(r); else if (e.isFile()) dateien.push(r);
      }
    }
    for (const d of dateien.sort()) { h.update(d); h.update('\0'); h.update(await fsp.readFile(path.join(ordner, d))); h.update('\0'); }
    return h.digest('hex');
  }

  async wechselSchritt(name: string, w: Wechselauftrag): Promise<{ meldung?: string; ergebnis?: Record<string, string | number> }> {
    const o = this.ordner(w.id);
    const ziel = `${o}.ziel`;
    const paket = path.join(o, 'daten-export', 'wechsel.tar.gz');
    switch (name) {
      case 'ziel_bereitstellen':
        await fsp.rm(ziel, { recursive: true, force: true });
        await fsp.mkdir(path.join(ziel, 'daten'), { recursive: true });
        await fsp.mkdir(path.join(ziel, 'daten-export'), { recursive: true });
        await fsp.writeFile(path.join(ziel, 'host'), w.nach.host);
        return { meldung: w.nach.stufe === 'eigen' ? `Ordner für eigene Maschine ${w.nach.host} (lokal simuliert)` : `Ordner auf ${w.nach.host}` };
      case 'alt_nur_lesen':
        await this.modus(w.id, 'nur_lesen');
        return {};
      case 'paket_bauen':
        await exec('tar', ['-czf', paket, '-C', path.join(o, 'daten'), '.']);
        return { ergebnis: { bytes: (await fsp.stat(paket)).size } };
      case 'uebertragen':
        await fsp.copyFile(paket, path.join(ziel, 'daten-export', 'wechsel.tar.gz'));
        return {};
      case 'einspielen':
        await exec('tar', ['-xzf', path.join(ziel, 'daten-export', 'wechsel.tar.gz'), '-C', path.join(ziel, 'daten')]);
        return { meldung: 'Paket eingespielt' };
      case 'pruefen':
        return { ergebnis: { alt: await LokalBereitsteller.baumHash(path.join(o, 'daten')), neu: await LokalBereitsteller.baumHash(path.join(ziel, 'daten')) } };
      case 'umschalten': {
        await fsp.rm(`${o}.alt`, { recursive: true, force: true });
        await fsp.rename(o, `${o}.alt`);
        await fsp.rename(ziel, o);
        for (const d of ['betrieb-token.sha256']) if (fs.existsSync(path.join(`${o}.alt`, d))) await fsp.copyFile(path.join(`${o}.alt`, d), path.join(o, d));
        await fsp.writeFile(path.join(o, 'modus'), 'normal');
        return { meldung: `Route ${w.subdomain} → ${w.nach.host}` };
      }
      case 'alt_anhalten':
        if (fs.existsSync(`${o}.alt`)) await fsp.writeFile(path.join(`${o}.alt`, 'modus'), 'pausiert');
        return {};
      default:
        return {};
    }
  }
  async wechselRueckbau(w: Wechselauftrag) {
    const o = this.ordner(w.id);
    await fsp.rm(`${o}.ziel`, { recursive: true, force: true });
    if (fs.existsSync(o)) await this.modus(w.id, 'normal');
  }
  async altLoeschen(id: string, _host: string) {
    const alt = `${this.ordner(id)}.alt`;
    const da = fs.existsSync(alt);
    await fsp.rm(alt, { recursive: true, force: true });
    return da ? ['alter Datenordner (Rückfallebene)'] : ['nichts mehr vorhanden'];
  }

  async einladung(_id: string, _mail: string) { /* lokal kein Mailversand */ }

  async loeschen(id: string) {
    const o = this.ordner(id);
    const da = fs.existsSync(o);
    await fsp.rm(o, { recursive: true, force: true });
    await fsp.rm(`${o}.alt`, { recursive: true, force: true });
    await fsp.rm(`${o}.ziel`, { recursive: true, force: true });
    return da ? ['Datenordner', 'Exportordner', 'Betriebs-Token-Hash'] : ['nichts mehr vorhanden'];
  }
}
