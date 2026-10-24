import path from 'node:path';
import fs from 'node:fs';

/**
 * Prüft einen relativen Pfad aus einer URL oder einem Werkzeugaufruf.
 * Gibt den bereinigten Pfad (mit "/") zurück oder null, wenn er unzulässig ist.
 * Unzulässig: leer, absolut, Backslash, NUL, Steuerzeichen, Segmente "", ".", "..",
 * versteckte Segmente (".git", ".kern" usw.).
 */
export function pruefeRelPfad(roh: string): string | null {
  if (typeof roh !== 'string' || roh.length === 0 || roh.length > 1024) return null;
  if (/[\u0000-\u001f\\]/.test(roh)) return null;
  if (roh.startsWith('/') || /^[a-zA-Z]:/.test(roh)) return null;
  const teile = roh.split('/');
  for (const t of teile) {
    if (t === '' || t === '.' || t === '..' || t.startsWith('.')) return null;
  }
  return teile.join('/');
}

/** Zerlegt einen URL-Pfadrest segmentweise und dekodiert ihn. null bei kaputter Kodierung. */
export function dekodiereUrlPfad(rest: string): string | null {
  try {
    const segs = rest.split('/').map((s) => decodeURIComponent(s));
    // Kodierte Schrägstriche ("%2F") innerhalb eines Segments sind nicht erlaubt.
    if (segs.some((s) => s.includes('/'))) return null;
    return segs.join('/');
  } catch {
    return null;
  }
}

/**
 * Bindet einen geprüften relativen Pfad an einen Basisordner und stellt sicher,
 * dass das Ergebnis (auch nach Auflösen symbolischer Links) im Basisordner liegt.
 */
export function sicherVerbinden(basis: string, rel: string): string | null {
  const ok = pruefeRelPfad(rel);
  if (!ok) return null;
  const b = path.resolve(basis);
  const ziel = path.resolve(b, ok);
  if (!ziel.startsWith(b + path.sep)) return null;
  try {
    const echteBasis = fs.realpathSync(b);
    const echtesZiel = fs.realpathSync(ziel);
    if (!echtesZiel.startsWith(echteBasis + path.sep)) return null;
  } catch {
    // Datei existiert nicht: der reine Pfadvergleich oben reicht.
  }
  return ziel;
}

/** Artikelpfade sind relativ zum Datenordner und beginnen mit "wissen/". */
export function artikelPfad(rel: string): string | null {
  const p = pruefeRelPfad(rel);
  if (!p) return null;
  const voll = p.startsWith('wissen/') ? p : `wissen/${p}`;
  return voll.endsWith('.md') ? voll : `${voll}.md`;
}

/** Quellenpfade sind relativ zum Datenordner und beginnen mit "quellen/". */
export function quellenPfad(rel: string): string | null {
  const p = pruefeRelPfad(rel);
  if (!p) return null;
  const voll = p.startsWith('quellen/') ? p : `quellen/${p}`;
  return voll.endsWith('.md') ? voll : `${voll}.md`;
}
