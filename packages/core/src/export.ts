/**
 * v1.4 Abschnitt 7: drei Exportarten (okf, zip, umzugspaket), Auspacken und Prüfen eines Umzugs, Ausstiegsprobe.
 * Logik des Umzugs nach `deploy/scripts/umzug.sh` (O1): ganzer Datenordner mit .git/, aus .kern/ nur users.json und
 * die Zugänge (zugang-export.json); ohne Index, Sitzungen, OAuth-Tokens, KI-Schlüssel, Lesestand, Uploads.
 * Das Umzugspaket ist ein tar, mit age (Passphrase des Kunden) verschlüsselt: `umzug-<instanz>-<datum>.tar.age`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as age from 'age-encryption';
import JSZip from 'jszip';
import type { Kern } from './kern.js';
import { hatRolle, brauchtRolle } from './rechte.js';
import { lieseTar, packeTar } from './tar.js';
import { KernFehler, type User } from './types.js';
import { parseMarkdown, slugify } from './util.js';
import { pruefeZip } from './parser.js';
import type { ZugangExport } from './zugang.js';

const execFileP = promisify(execFile);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export type ExportArt = 'okf' | 'zip' | 'umzugspaket';

export interface UmzugManifest {
  format: 'kern-umzug/1';
  erstellt: string;
  quelle: { instanz?: string; version: string; schema: number };
  head: string;
  dateien: { pfad: string; sha256: string; bytes: number }[];
  ausgelassen: ('index' | 'sitzungen' | 'oauth_tokens' | 'ki_schluessel' | 'lesestand' | 'uploads')[];
  /** additiv: Zahl der Befunde aus `pruefe()` in der Quelle (für „neue Befunde“ im Prüfbericht). */
  befunde?: number;
  /** additiv (E1): Prüfbank-Kennzahlen der Quelle, Satz `betrieb` mit mock (für den Vergleich im Prüfbericht). */
  pruefbank?: PruefbankKennzahlen;
}

export interface PruefbankKennzahlen { trefferAt5: number; belegtreue: number; enthaltung: number; lecks: number; zeitTreue: number; injektionsfest: number; falscherNachbar: number; thema: number }

export interface Pruefbericht {
  format: 'kern-pruefbericht/1';
  am: string;
  manifest_sha256: string;
  pruefsummen_ok: boolean;
  git_fsck_ok: boolean;
  head_gleich: boolean;
  index_neu: boolean;
  pruefen_befunde_neu: number;
  /** Satz `betrieb` mit mock vor und nach dem Umzug; `null` nur bei Paketen ohne Kennzahlen (vor E1). */
  pruefbank: { vorher: PruefbankKennzahlen; nachher: PruefbankKennzahlen; gleich: boolean } | null;
  hinweise: string[];
  bestanden: boolean;
}

export interface Ausstiegsprobe {
  am: string;
  kernZuKern: Pruefbericht;
  offen: { bestanden: boolean; dateien: number; ohneGueltigenKopf: string[]; fundstellenKaputt: number };
  bestanden: boolean;
}

const VERSION = '0.1.0';
export const UMZUG_SCHEMA = 1;

/** Alle Dateien unter `wurzel` (relativ, mit `/`), optional mit Filter auf den relativen Pfad. */
async function dateienUnter(wurzel: string, filter: (rel: string, ordner: boolean) => boolean = () => true): Promise<string[]> {
  const out: string[] = [];
  const lauf = async (abs: string) => {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      const rel = relative(wurzel, p).split(sep).join('/');
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (filter(rel + '/', true)) await lauf(p);
      } else if (e.isFile() && filter(rel, false)) out.push(rel);
    }
  };
  await lauf(wurzel);
  return out.sort();
}

async function zipOrdner(eintraege: { pfad: string; daten: Buffer }[], ziel: string): Promise<void> {
  const z = new JSZip();
  for (const e of eintraege) z.file(e.pfad, e.daten, { binary: true, createFolders: false, date: new Date('2026-01-01T00:00:00Z') });
  await mkdir(dirname(ziel), { recursive: true });
  await writeFile(ziel, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }), { mode: 0o600 });
}

async function ergebnis(datei: string, ausgelassen?: number) {
  const daten = await readFile(datei);
  return { datei, bytes: daten.length, sha256: sha(daten), ...(ausgelassen !== undefined ? { ausgelassen } : {}) };
}

/** Arbeitsstand sauber machen (umzug.sh verlangt das ebenfalls): offene Änderungen committen. */
async function sauber(k: Kern): Promise<void> {
  await k.uebernimmAenderungen();
  const offen = await k.git.offeneAenderungen(['.']);
  if (offen.length) await k.git.commit(offen, k.cfg.externerAutor ?? 'extern', 'Stand vor dem Export');
}

/**
 * Export nach v1.4 7.1. `okf`: jeder, nach Rechten. `zip`: admin den ganzen Ordner (ohne .kern/, mit nutzer.json ohne Hashes,
 * ohne fremde ich-Dateien; dann ohne .git/, weil der Verlauf sie enthält), andere nur ihre ich-Dateien. `umzugspaket`: admin, vollständig, verschlüsselt.
 */
export async function exportiere(k: Kern, u: User, e: { art: ExportArt; ziel: string; passphrase?: string; instanz?: string }): Promise<{ datei: string; bytes: number; sha256: string; ausgelassen?: number; hinweise?: string[] }> {
  const ziel = resolve(e.ziel);
  if (e.art === 'okf') {
    const tmp = await mkdtemp(join(tmpdir(), 'kern-okf-'));
    try {
      const r = await k.exportiereOkf(tmp, { fuer: u });
      const dateien = await dateienUnter(tmp);
      await zipOrdner(await Promise.all(dateien.map(async (p) => ({ pfad: p, daten: await readFile(join(tmp, p)) }))), ziel);
      return ergebnis(ziel, r.ausgelassen);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  if (e.art === 'zip') {
    await sauber(k);
    const fremdPrivat = new Set(k.ix.dateien().filter((d) => d.sichtbarkeit === 'ich' && d.besitzer !== u.id).map((d) => d.pfad.replace(/\.md$/, '')));
    const eigenerOrdner = `nutzer/${slugify(u.id, 64)}/`;
    const fremdeNotiz = (rel: string) => /^nutzer\/[^/]+\/notizen\//.test(rel) && !rel.startsWith(eigenerOrdner);
    const istFremd = (rel: string) => fremdeNotiz(rel) || [...fremdPrivat].some((b) => rel === `${b}.md` || rel.startsWith(`${b}.orig.`));
    const fremdeNotizen = (await dateienUnter(k.dir, (rel, ordner) => (ordner ? rel === 'nutzer/' || /^nutzer\/[^/]+\/(notizen\/.*)?$/.test(rel) : fremdeNotiz(rel)))).length;
    const hinweise: string[] = [];
    let eintraege: string[];
    if (hatRolle(u, 'admin')) {
      const mitGit = fremdPrivat.size === 0 && fremdeNotizen === 0;
      if (!mitGit) hinweise.push(`Ohne .git/: Der Verlauf enthält ${fremdPrivat.size + fremdeNotizen} private Dateien anderer Personen. Vollständig und verlustfrei ist das Umzugspaket.`);
      eintraege = await dateienUnter(k.dir, (rel, ordner) => {
        if (rel === '.kern/' || rel.startsWith('.kern/')) return false;
        if (!mitGit && (rel === '.git/' || rel.startsWith('.git/'))) return false;
        return ordner || !istFremd(rel);
      });
    } else {
      const eigene = new Set(k.ix.dateien().filter((d) => d.sichtbarkeit === 'ich' && d.besitzer === u.id).map((d) => d.pfad.replace(/\.md$/, '')));
      eintraege = await dateienUnter(k.dir, (rel, ordner) => (ordner ? /^(wissen|quellen)(\/|$)/.test(rel) || rel === 'nutzer/' || rel.startsWith(eigenerOrdner) : rel.startsWith(`${eigenerOrdner}notizen/`) || [...eigene].some((b) => rel === `${b}.md` || rel.startsWith(`${b}.orig.`))));
      hinweise.push('Nur deine privaten Dateien. Das gemeinsame Wissen exportiert ein Admin oder der OKF-Export.');
    }
    const daten = await Promise.all(eintraege.map(async (p) => ({ pfad: p, daten: await readFile(join(k.dir, p)) })));
    if (hatRolle(u, 'admin')) daten.push({ pfad: 'nutzer.json', daten: Buffer.from(JSON.stringify((await k.benutzer.liste()).map((b) => ({ id: b.id, name: b.name, rollen: b.rollen, teams: b.teams })), null, 2)) });
    await zipOrdner(daten, ziel);
    return { ...(await ergebnis(ziel, fremdPrivat.size + fremdeNotizen)), hinweise };
  }
  if (e.art === 'umzugspaket') {
    brauchtRolle(u, 'admin', 'ein Umzugspaket erstellen');
    if (!e.passphrase || e.passphrase.length < 12) throw new KernFehler('ungueltig', 'Passphrase mit mindestens 12 Zeichen nötig');
    await sauber(k);
    const befunde = (await k.pruefe(u, { vorschlaegeAnlegen: false })).length;
    const { mockKennzahlen } = await import('./pruefbank.js');
    const pruefbank = await mockKennzahlen(k, u);
    const rel = await dateienUnter(k.dir, (r) => !(r === '.kern/' || r.startsWith('.kern/')));
    const eintraege: { pfad: string; daten: Buffer }[] = [];
    const liste: UmzugManifest['dateien'] = [];
    for (const p of rel) {
      const d = await readFile(join(k.dir, p));
      eintraege.push({ pfad: `daten/${p}`, daten: d });
      if (!p.startsWith('.git/')) liste.push({ pfad: p, sha256: sha(d), bytes: d.length });
    }
    const users = await readFile(join(k.dir, '.kern', 'users.json')).catch(() => Buffer.from('[]'));
    eintraege.push({ pfad: 'daten/.kern/users.json', daten: users });
    liste.push({ pfad: '.kern/users.json', sha256: sha(users), bytes: users.length });
    const zug = Buffer.from(JSON.stringify(k.zugang.exportiere(), null, 2));
    eintraege.push({ pfad: 'daten/.kern/zugang-export.json', daten: zug });
    liste.push({ pfad: '.kern/zugang-export.json', sha256: sha(zug), bytes: zug.length });
    const manifest: UmzugManifest = {
      format: 'kern-umzug/1', erstellt: new Date().toISOString(), quelle: { ...(e.instanz ? { instanz: e.instanz } : {}), version: VERSION, schema: UMZUG_SCHEMA },
      head: (await k.git.head()) ?? '', dateien: liste, ausgelassen: ['index', 'sitzungen', 'oauth_tokens', 'ki_schluessel', 'lesestand', 'uploads'], befunde, pruefbank,
    };
    const tar = packeTar([{ pfad: 'manifest.json', daten: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...eintraege]);
    const enc = new age.Encrypter();
    enc.setPassphrase(e.passphrase);
    await mkdir(dirname(ziel), { recursive: true });
    await writeFile(ziel, await enc.encrypt(new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength)), { mode: 0o600 });
    return ergebnis(ziel);
  }
  throw new KernFehler('ungueltig', 'art: okf | zip | umzugspaket');
}

/** Umzugspaket in einen leeren Ordner auspacken (vor `Kern.open`). Prüft Pfade, legt Manifest unter .kern/ ab. */
export async function umzugAuspacken(paket: string, ordner: string, passphrase: string): Promise<UmzugManifest> {
  const ziel = resolve(ordner);
  if (existsSync(join(ziel, 'kern.yaml'))) throw new KernFehler('konflikt', 'Ziel enthält schon einen Datenordner');
  let tar: Buffer;
  try {
    const d = new age.Decrypter();
    d.addPassphrase(passphrase);
    tar = Buffer.from(await d.decrypt(new Uint8Array(await readFile(paket))));
  } catch {
    throw new KernFehler('ungueltig', 'Paket lässt sich nicht entschlüsseln (Passphrase falsch oder Datei beschädigt)');
  }
  const eintraege = lieseTar(tar);
  const m = eintraege.find((x) => x.pfad === 'manifest.json');
  if (!m) throw new KernFehler('ungueltig', 'Kein Manifest im Paket');
  const manifest = JSON.parse(m.daten.toString('utf8')) as UmzugManifest;
  if (manifest.format !== 'kern-umzug/1') throw new KernFehler('ungueltig', `Unbekanntes Paketformat ${String(manifest.format)}`);
  for (const x of eintraege) {
    if (!x.pfad.startsWith('daten/')) continue;
    const rel = x.pfad.slice(6);
    const abs = resolve(ziel, rel);
    if (!abs.startsWith(ziel + sep)) throw new KernFehler('ungueltig', `Unzulässiger Pfad im Paket: ${rel}`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, x.daten, { mode: rel.startsWith('.kern/') ? 0o600 : 0o644 });
  }
  await writeFile(join(ziel, '.kern', 'umzug-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

/**
 * Nach dem Auspacken mit geöffnetem Kern: Zugänge übernehmen, Prüfsummen, git fsck, HEAD, Index neu, neue Befunde.
 * Schreibt `.kern/pruefbericht.json` und gibt den Bericht zurück.
 */
export async function umzugPruefen(k: Kern, u: User): Promise<Pruefbericht> {
  brauchtRolle(u, 'admin', 'einen Umzug prüfen');
  const mRoh = await readFile(join(k.dir, '.kern', 'umzug-manifest.json'));
  const manifest = JSON.parse(mRoh.toString('utf8')) as UmzugManifest;
  const hinweise: string[] = [];
  // Zugänge übernehmen (einmalig, idempotent)
  const zp = join(k.dir, '.kern', 'zugang-export.json');
  if (existsSync(zp)) {
    const r = k.zugang.importiere(JSON.parse(await readFile(zp, 'utf8')) as ZugangExport);
    hinweise.push(`${r.tokens} Zugänge und ${r.clients} OAuth-Clients übernommen; Sitzungen und OAuth-Anmeldungen beginnen neu; KI-Schlüssel neu eingeben.`);
  }
  let pruefsummen_ok = true;
  for (const f of manifest.dateien) {
    const d = await readFile(join(k.dir, f.pfad)).catch(() => null);
    if (!d || d.length !== f.bytes || sha(d) !== f.sha256) {
      pruefsummen_ok = false;
      hinweise.push(`Prüfsumme weicht ab: ${f.pfad}`);
      if (hinweise.length > 20) break;
    }
  }
  let git_fsck_ok = true;
  try {
    await execFileP('git', ['-C', k.dir, 'fsck', '--no-progress', '--no-dangling'], { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    git_fsck_ok = false;
  }
  const head = (await k.git.head()) ?? '';
  const head_gleich = head === manifest.head;
  let index_neu = true;
  try {
    await k.reindex();
  } catch {
    index_neu = false;
  }
  const befunde = (await k.pruefe(u, { vorschlaegeAnlegen: false })).length;
  const pruefen_befunde_neu = Math.max(0, befunde - (manifest.befunde ?? befunde));
  let pruefbank: Pruefbericht['pruefbank'] = null;
  if (manifest.pruefbank) {
    const { mockKennzahlen, kennzahlenGleich } = await import('./pruefbank.js');
    const nachher = await mockKennzahlen(k, u);
    const ab = kennzahlenGleich(manifest.pruefbank, nachher);
    pruefbank = { vorher: manifest.pruefbank, nachher, gleich: ab.length === 0 };
    if (ab.length) hinweise.push(`Prüfbank weicht ab: ${ab.join('; ')}`);
  } else hinweise.push('Paket ohne Prüfbank-Kennzahlen (älter als E1): es zählen Prüfsummen, Verlauf, Index und Befunde.');
  const bericht: Pruefbericht = {
    format: 'kern-pruefbericht/1', am: new Date().toISOString(), manifest_sha256: sha(mRoh),
    pruefsummen_ok, git_fsck_ok, head_gleich, index_neu, pruefen_befunde_neu, pruefbank, hinweise,
    bestanden: pruefsummen_ok && git_fsck_ok && head_gleich && index_neu && pruefen_befunde_neu === 0 && (pruefbank?.gleich ?? true),
  };
  await writeFile(join(k.dir, '.kern', 'pruefbericht.json'), JSON.stringify(bericht, null, 2), { mode: 0o600 });
  return bericht;
}

/** OKF-Ordner auf Lesbarkeit ohne Kern prüfen: jeder Markdown-Kopf gültig mit `type`, Fundstellen zeigen auf vorhandene Dateien. */
export async function pruefeOkfOrdner(ordner: string): Promise<Ausstiegsprobe['offen']> {
  const md = (await dateienUnter(ordner)).filter((p) => p.endsWith('.md'));
  const vorhanden = new Set(await dateienUnter(ordner));
  const ohne: string[] = [];
  let kaputt = 0;
  for (const p of md) {
    const r = parseMarkdown(await readFile(join(ordner, p), 'utf8'));
    if (posix.basename(p) === 'index.md' || posix.basename(p) === 'log.md') continue;
    if (r.fehler || typeof r.kopf['type'] !== 'string') { ohne.push(p); continue; }
    const fs = Array.isArray(r.kopf['fundstellen']) ? (r.kopf['fundstellen'] as { quelle?: string }[]) : [];
    for (const f of fs) if (f?.quelle && !vorhanden.has(String(f.quelle).replace(/^\//, ''))) kaputt++;
  }
  return { bestanden: ohne.length === 0 && kaputt === 0, dateien: md.length, ohneGueltigenKopf: ohne, fundstellenKaputt: kaputt };
}

/** v1.4 7.3: Ausstiegsprobe (admin). Ergebnis unter pruefung/ausstieg/<datum>.json (zieht mit um). */
export async function ausstiegsprobe(k: Kern, u: User, oeffne: (dir: string) => Promise<Kern>): Promise<Ausstiegsprobe> {
  brauchtRolle(u, 'admin', 'die Ausstiegsprobe starten');
  const tmp = await mkdtemp(join(tmpdir(), 'kern-ausstieg-'));
  try {
    const pass = randomBytes(18).toString('base64url');
    const paket = join(tmp, 'umzug.tar.age');
    await exportiere(k, u, { art: 'umzugspaket', ziel: paket, passphrase: pass });
    const ziel = join(tmp, 'ziel');
    await umzugAuspacken(paket, ziel, pass);
    const k2 = await oeffne(ziel);
    let kernZuKern: Pruefbericht;
    try {
      kernZuKern = await umzugPruefen(k2, u);
    } finally {
      await k2.schliesse();
    }
    const okf = join(tmp, 'okf');
    await k.exportiereOkf(okf);
    const offen = await pruefeOkfOrdner(okf);
    const am = new Date().toISOString();
    const probe: Ausstiegsprobe = { am, kernZuKern, offen, bestanden: kernZuKern.bestanden && offen.bestanden };
    await k.speichereAusstiegsprobe(u, probe);
    return probe;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Eigenen ZIP-Export (art zip) prüfen und entpacken, für `importiere(u, { art: 'kern-zip' })`. */
export async function entpackeKernZip(datei: string, ordner: string): Promise<string[]> {
  const daten = await readFile(datei);
  pruefeZip(daten, { maxEntpackt: 2 * 1024 * 1024 * 1024, maxVerhaeltnis: 200 });
  const z = await JSZip.loadAsync(daten);
  const out: string[] = [];
  const wurzel = resolve(ordner);
  for (const e of Object.values(z.files)) {
    if (e.dir) continue;
    const abs = resolve(wurzel, e.name);
    if (!abs.startsWith(wurzel + sep) || e.name.startsWith('.git/') || e.name.startsWith('.kern/')) continue;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, await e.async('nodebuffer'));
    out.push(e.name);
  }
  void stat;
  return out;
}
