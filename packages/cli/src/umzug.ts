import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * v1.4 7.2 Umzugspaket (Kern zu Kern ohne Verlust), Logik aus deploy/scripts/umzug.sh (O1), in Node.
 * Paket: tar mit `manifest.json` und `daten/` (Datenordner mit .git/, ohne Index, Sitzungen, Uploads, Lesestand,
 * KI-Schlüssel). Aus `.kern/` nur `users.json` und, wenn core es kann, `zugang-export.json` (nur api/mcp-Zugänge
 * und OAuth-Clients). Verschlüsselt mit age (Empfänger-Schlüssel oder Passphrase am Terminal).
 */
export interface UmzugManifest {
  format: 'kern-umzug/1';
  erstellt: string;
  quelle: { instanz?: string; version: string; schema: number };
  head: string;
  dateien: { pfad: string; sha256: string; bytes: number }[];
  ausgelassen: string[];
  /** Fehler aus `kern pruefen` in der Quelle (für pruefen_befunde_neu). */
  befunde_fehler_quelle: number | null;
}

export interface Pruefbericht {
  format: 'kern-pruefbericht/1';
  am: string;
  manifest_sha256: string;
  pruefsummen_ok: boolean;
  git_fsck_ok: boolean;
  head_gleich: boolean;
  index_neu: boolean;
  pruefen_befunde_neu: number;
  /** Prüfbank vorher/nachher kommt mit core 8.1; bis dahin null. */
  pruefbank: { vorher: unknown; nachher: unknown; gleich: boolean } | null;
  abweichungen: string[];
  bestanden: boolean;
}

const sha256Datei = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sha256Text = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

/** Was aus `.kern/` mitgeht. Alles andere dort ist wegwerfbar oder geheim. */
const KERN_MIT = new Set(['users.json', 'zugang-export.json']);

function alleDateien(basis: string, ohne: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const lauf = (rel: string) => {
    for (const e of fs.readdirSync(path.join(basis, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ohne(r)) continue;
      if (e.isSymbolicLink()) continue; // keine Symlinks ins Paket
      if (e.isDirectory()) lauf(r);
      else if (e.isFile()) out.push(r);
    }
  };
  lauf('');
  return out.sort();
}

export function gitHead(ordner: string): string {
  return execFileSync('git', ['-C', ordner, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function packen(o: {
  dataDir: string; ziel: string; version: string; instanz?: string;
  zugangExport?: unknown; befundeFehler: number | null;
  empfaenger?: string; passphraseAmTerminal?: boolean; unverschluesselt?: boolean;
}): { datei: string; sha256: string; bytes: number; dateien: number; head: string } {
  const { dataDir } = o;
  if (!fs.existsSync(path.join(dataDir, 'kern.yaml'))) throw new Error(`Kein Datenordner: ${dataDir}`);
  const offen = execFileSync('git', ['-C', dataDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (offen) throw new Error('Nicht übernommene Änderungen im Datenordner. Erst den Server anhalten (oder Modus nur_lesen) und neu versuchen.');
  if (!o.unverschluesselt && !o.empfaenger && !o.passphraseAmTerminal) throw new Error('Verschlüsselung wählen: --empfaenger <age-Schlüssel>, --passphrase (am Terminal) oder ausdrücklich --unverschluesselt.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-umzug-'));
  try {
    const daten = path.join(tmp, 'daten');
    fs.mkdirSync(daten, { recursive: true });
    const ohne = (rel: string) => rel.startsWith('.kern/') && !KERN_MIT.has(rel.slice(6));
    for (const rel of alleDateien(dataDir, ohne)) {
      const z = path.join(daten, rel);
      fs.mkdirSync(path.dirname(z), { recursive: true });
      fs.copyFileSync(path.join(dataDir, rel), z);
    }
    const ausgelassen = ['index', 'sitzungen', 'oauth_tokens', 'ki_schluessel', 'lesestand', 'uploads'];
    if (o.zugangExport !== undefined) {
      fs.mkdirSync(path.join(daten, '.kern'), { recursive: true });
      fs.writeFileSync(path.join(daten, '.kern', 'zugang-export.json'), JSON.stringify(o.zugangExport, null, 2), { mode: 0o600 });
    } else ausgelassen.push('zugaenge');
    const head = gitHead(dataDir);
    const dateien = alleDateien(daten, (rel) => rel === '.git' || rel.startsWith('.git/')).map((rel) => {
      const p = path.join(daten, rel);
      return { pfad: rel, sha256: sha256Datei(p), bytes: fs.statSync(p).size };
    });
    const manifest: UmzugManifest = {
      format: 'kern-umzug/1', erstellt: new Date().toISOString(),
      quelle: { ...(o.instanz ? { instanz: o.instanz } : {}), version: o.version, schema: 1 },
      head, dateien, ausgelassen, befunde_fehler_quelle: o.befundeFehler,
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const tar = path.join(tmp, 'paket.tar');
    execFileSync('tar', ['-C', tmp, '-cf', tar, 'manifest.json', 'daten']);
    const ziel = path.resolve(o.ziel);
    if (o.unverschluesselt) fs.copyFileSync(tar, ziel);
    else {
      const args = o.empfaenger ? ['-r', o.empfaenger, '-o', ziel, tar] : ['-p', '-o', ziel, tar];
      const r = spawnSync('age', args, { stdio: o.empfaenger ? ['ignore', 'inherit', 'inherit'] : 'inherit' });
      if (r.error || r.status !== 0) throw new Error(`age fehlgeschlagen${r.error ? `: ${r.error.message}` : ''}. Ist age installiert?`);
    }
    fs.chmodSync(ziel, 0o600);
    return { datei: ziel, sha256: sha256Datei(ziel), bytes: fs.statSync(ziel).size, dateien: dateien.length, head };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function auspacken(o: { paket: string; ordner: string; identitaet?: string }): { ordner: string; manifest: UmzugManifest } {
  const ziel = path.resolve(o.ordner);
  if (fs.existsSync(path.join(ziel, 'kern.yaml'))) throw new Error(`Ziel enthält schon einen Datenordner: ${ziel}`);
  if (fs.existsSync(ziel) && fs.readdirSync(ziel).length) throw new Error(`Ziel ist nicht leer: ${ziel}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-auspacken-'));
  try {
    let tar = path.resolve(o.paket);
    const kopf = fs.readFileSync(tar).subarray(0, 32).toString('latin1');
    if (kopf.startsWith('age-encryption.org/') || kopf.startsWith('-----BEGIN AGE')) {
      const klar = path.join(tmp, 'paket.tar');
      const args = o.identitaet ? ['-d', '-i', o.identitaet, '-o', klar, tar] : ['-d', '-o', klar, tar];
      const r = spawnSync('age', args, { stdio: 'inherit' });
      if (r.error || r.status !== 0) throw new Error('Entschlüsseln mit age fehlgeschlagen.');
      tar = klar;
    }
    // Pfadprüfung vor dem Entpacken: nur manifest.json und daten/…, keine absoluten Pfade, kein .., keine Links.
    const liste = execFileSync('tar', ['-tvf', tar], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean);
    for (const z of liste) {
      const typ = z[0];
      const name = z.split(/\s+/).slice(5).join(' ');
      if (typ !== '-' && typ !== 'd') throw new Error(`Paket enthält einen Link oder Sondereintrag: ${name}`);
      if (name.startsWith('/') || name.split('/').includes('..') || !(name === 'manifest.json' || name === 'daten' || name.startsWith('daten/'))) throw new Error(`Unzulässiger Pfad im Paket: ${name}`);
    }
    const aus = path.join(tmp, 'aus');
    fs.mkdirSync(aus);
    execFileSync('tar', ['-C', aus, '--no-same-owner', '--no-same-permissions', '-xf', tar]);
    const roh = fs.readFileSync(path.join(aus, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(roh) as UmzugManifest;
    if (manifest.format !== 'kern-umzug/1') throw new Error(`Unbekanntes Paketformat: ${String(manifest.format)}`);
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    if (fs.existsSync(ziel)) fs.rmdirSync(ziel);
    fs.renameSync(path.join(aus, 'daten'), ziel);
    fs.mkdirSync(path.join(ziel, '.kern'), { recursive: true });
    fs.writeFileSync(path.join(ziel, '.kern', 'umzug-manifest.json'), roh, { mode: 0o600 });
    return { ordner: ziel, manifest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Prüft einen ausgepackten Ordner gegen das Manifest. `reindex` und `befundeFehler` liefert der Aufrufer (core). */
export async function pruefen(o: { ordner: string; reindex: () => Promise<unknown>; befundeFehler: () => Promise<number> }): Promise<Pruefbericht> {
  const ordner = path.resolve(o.ordner);
  const mDatei = path.join(ordner, '.kern', 'umzug-manifest.json');
  if (!fs.existsSync(mDatei)) throw new Error('Kein Umzugsmanifest gefunden (.kern/umzug-manifest.json). Erst „kern umzug auspacken“.');
  const roh = fs.readFileSync(mDatei, 'utf8');
  const m = JSON.parse(roh) as UmzugManifest;
  const abweichungen: string[] = [];
  for (const d of m.dateien) {
    const p = path.join(ordner, d.pfad);
    if (!fs.existsSync(p)) { abweichungen.push(`fehlt: ${d.pfad}`); continue; }
    if (sha256Datei(p) !== d.sha256) abweichungen.push(`Prüfsumme weicht ab: ${d.pfad}`);
  }
  const fsck = spawnSync('git', ['-C', ordner, 'fsck', '--no-progress', '--no-dangling'], { encoding: 'utf8' });
  const git_fsck_ok = fsck.status === 0;
  let head_gleich = false;
  try { head_gleich = gitHead(ordner) === m.head; } catch { /* kein git */ }
  if (!head_gleich) abweichungen.push('HEAD weicht ab');
  let index_neu = false;
  try { await o.reindex(); index_neu = true; } catch (e) { abweichungen.push(`Index: ${(e as Error).message}`); }
  const fehlerJetzt = await o.befundeFehler();
  const pruefen_befunde_neu = Math.max(0, fehlerJetzt - (m.befunde_fehler_quelle ?? 0));
  const pruefsummen_ok = !abweichungen.some((a) => a.startsWith('fehlt') || a.startsWith('Prüfsumme'));
  const bericht: Pruefbericht = {
    format: 'kern-pruefbericht/1', am: new Date().toISOString(), manifest_sha256: sha256Text(roh),
    pruefsummen_ok, git_fsck_ok, head_gleich, index_neu, pruefen_befunde_neu, pruefbank: null, abweichungen,
    bestanden: pruefsummen_ok && git_fsck_ok && head_gleich && index_neu && pruefen_befunde_neu === 0,
  };
  fs.writeFileSync(path.join(ordner, '.kern', 'pruefbericht.json'), JSON.stringify(bericht, null, 2), { mode: 0o600 });
  return bericht;
}
