import fs from 'node:fs';
import path from 'node:path';
import { schwereVon, teileFrontmatter, type Befund, type KernLike, type User } from '@kern/server';

const RESERVIERT = new Set(['index.md', 'log.md']);

function mdDateien(dataDir: string, ordner: string): string[] {
  const basis = path.join(dataDir, ordner);
  if (!fs.existsSync(basis)) return [];
  return fs.readdirSync(basis, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.includes('.orig.') && !RESERVIERT.has(e.name))
    .map((e) => path.relative(dataDir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

export interface Bericht {
  befunde: (Befund & { herkunft: 'core' | 'cli'; schwere: 'fehler' | 'warnung' | 'hinweis' })[];
  zahlen: { artikel: number; quellen: number; faellig: number; fehler: number; warnungen: number };
  coreVersion: 'v1.1' | 'v1';
}

/**
 * Konsistenzbericht. Nutzt `pruefe()` aus core (Nachtrag v1.1), wenn vorhanden,
 * und ergänzt eigene Dateiprüfungen: Pflichtfelder im Kopf, Fundstellen (Datei und
 * Zeilenbereich), fällige Artikel und Abgleich Dateien gegen das, was core liefert.
 */
export async function pruefeBestand(kern: KernLike, u: User, dataDir: string): Promise<Bericht> {
  const befunde: Bericht['befunde'] = [];
  const hatCore = typeof kern.pruefe === 'function';
  if (hatCore) for (const b of await kern.pruefe!(u)) befunde.push({ ...b, herkunft: 'core', schwere: schwereVon(b.art) });
  const add = (b: Befund) => befunde.push({ ...b, herkunft: 'cli', schwere: schwereVon(b.art) });

  const artikel = mdDateien(dataDir, 'wissen');
  const quellen = mdDateien(dataDir, 'quellen');
  const zeilenJeQuelle = new Map<string, number>();
  for (const q of quellen) zeilenJeQuelle.set(q, fs.readFileSync(path.join(dataDir, q), 'utf8').split('\n').length);

  const heute = new Date().toISOString().slice(0, 10);
  let faellig = 0;
  for (const a of artikel) {
    let kopf: Record<string, unknown>;
    try {
      kopf = teileFrontmatter(fs.readFileSync(path.join(dataDir, a), 'utf8')).kopf;
    } catch (e) {
      add({ art: 'kopf_fehlerhaft', pfad: a, text: `YAML-Kopf nicht lesbar: ${(e as Error).message}` });
      continue;
    }
    const fehlt = ['titel', 'gruppe', 'kurzfassung', 'stand', 'sichtbarkeit', 'status'].filter((f) => kopf[f] === undefined || kopf[f] === '');
    if (fehlt.length) add({ art: 'kopf_fehlerhaft', pfad: a, text: `Im Kopf fehlt: ${fehlt.join(', ')}` });
    const pb = kopf.pruefen_bis ? String(kopf.pruefen_bis instanceof Date ? kopf.pruefen_bis.toISOString().slice(0, 10) : kopf.pruefen_bis) : null;
    if (pb && pb < heute) {
      faellig++;
      if (!hatCore) add({ art: 'pruefung_faellig', pfad: a, text: `Prüftermin ${pb} überschritten.` });
    }
    if (!hatCore) {
      const fs_ = Array.isArray(kopf.fundstellen) ? (kopf.fundstellen as { quelle?: string; zeilen?: [number, number] }[]) : [];
      for (const f of fs_) {
        if (!f?.quelle) { add({ art: 'fundstelle_kaputt', pfad: a, text: 'Fundstelle ohne Quelle.' }); continue; }
        const n = zeilenJeQuelle.get(f.quelle);
        if (n === undefined) add({ art: 'fundstelle_kaputt', pfad: a, text: `Quelle ${f.quelle} existiert nicht.` });
        else if (Array.isArray(f.zeilen) && (f.zeilen[1] ?? 0) > n) add({ art: 'fundstelle_kaputt', pfad: a, text: `Zeilen ${f.zeilen.join('–')} liegen hinter dem Ende von ${f.quelle} (${n} Zeilen).` });
      }
    }
  }

  // Dateien gegen das, was core sieht (Index und Lesefunktionen)
  const gesehen = new Set([...(await kern.listeWissen(u)).map((x) => x.pfad), ...(await kern.listeQuellen(u)).map((x) => x.pfad)]);
  for (const p of [...artikel, ...quellen]) {
    if (!gesehen.has(p)) add({ art: 'index_veraltet', pfad: p, text: 'Datei liegt im Ordner, wird aber nicht geliefert (Index veraltet oder nur für den Besitzer sichtbar). Abhilfe: kern reindex' });
  }
  const aufPlatte = new Set([...artikel, ...quellen]);
  for (const p of gesehen) {
    if (!aufPlatte.has(p)) add({ art: 'index_veraltet', pfad: p, text: 'Im Index, aber nicht mehr im Ordner. Abhilfe: kern reindex' });
  }

  const fehler = befunde.filter((b) => b.schwere === 'fehler').length;
  const warnungen = befunde.filter((b) => b.schwere === 'warnung').length;
  return { befunde, zahlen: { artikel: artikel.length, quellen: quellen.length, faellig, fehler, warnungen }, coreVersion: hatCore ? 'v1.1' : 'v1' };
}
