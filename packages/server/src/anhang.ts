import { KernFehler } from './fehler.js';

/**
 * v1.4.1 U1: Anhänge jeden Typs. Der Server prüft vor dem Ablegen
 *  1. die Größe gegen `kern.yaml anhaenge.max_mb` (Standard 25 [Schätzung], wie core `ANHANG_MAX_MB`),
 *  2. ob der Inhalt zur Endung passt (Signatur der ersten Bytes). Eine Datei, die sich als Bild oder PDF ausgibt,
 *     aber etwas anderes ist, wird abgewiesen (415). Unbekannte Endungen sind erlaubt und werden nur als Anhang
 *     gespeichert; ausgeliefert wird immer als Download mit nosniff und Sandbox-CSP.
 */
export const ANHANG_MAX_MB_STANDARD = 25;

export function anhangMaxBytes(yaml: Record<string, unknown>): number {
  const mb = Number((yaml['anhaenge'] as { max_mb?: unknown } | undefined)?.max_mb ?? ANHANG_MAX_MB_STANDARD);
  return (Number.isFinite(mb) && mb > 0 ? mb : ANHANG_MAX_MB_STANDARD) * 1024 * 1024;
}

const hex = (b: Uint8Array, von: number, n: number) => Buffer.from(b.subarray(von, von + n)).toString('hex');
const ascii = (b: Uint8Array, von: number, n: number) => Buffer.from(b.subarray(von, von + n)).toString('latin1');

/** Erwartete Signatur je Endung (nur Typen mit eindeutiger Signatur). */
const SIGNATUR: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => hex(b, 0, 8) === '89504e470d0a1a0a',
  jpg: (b) => hex(b, 0, 3) === 'ffd8ff',
  jpeg: (b) => hex(b, 0, 3) === 'ffd8ff',
  gif: (b) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a',
  webp: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP',
  bmp: (b) => ascii(b, 0, 2) === 'BM',
  tif: (b) => ['49492a00', '4d4d002a'].includes(hex(b, 0, 4)),
  tiff: (b) => ['49492a00', '4d4d002a'].includes(hex(b, 0, 4)),
  avif: (b) => ascii(b, 4, 4) === 'ftyp',
  heic: (b) => ascii(b, 4, 4) === 'ftyp',
  pdf: (b) => ascii(b, 0, 5) === '%PDF-',
  zip: (b) => hex(b, 0, 4) === '504b0304' || hex(b, 0, 4) === '504b0506',
  docx: (b) => hex(b, 0, 4) === '504b0304',
  xlsx: (b) => hex(b, 0, 4) === '504b0304',
  pptx: (b) => hex(b, 0, 4) === '504b0304',
  odt: (b) => hex(b, 0, 4) === '504b0304',
  gz: (b) => hex(b, 0, 2) === '1f8b',
  mp3: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  wav: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE',
  ogg: (b) => ascii(b, 0, 4) === 'OggS',
  m4a: (b) => ascii(b, 4, 4) === 'ftyp',
  mp4: (b) => ascii(b, 4, 4) === 'ftyp',
  mov: (b) => ascii(b, 4, 4) === 'ftyp' || ascii(b, 4, 4) === 'moov',
};
/** Textendungen: dürfen keine NUL-Bytes enthalten (sonst ist es kein Text). */
const TEXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'html', 'htm', 'xml', 'svg']);

export function pruefeAnhang(name: string, inhalt: Uint8Array, maxBytes: number): void {
  if (inhalt.byteLength > maxBytes) {
    throw Object.assign(new KernFehler(413, `Datei größer als ${Math.round(maxBytes / 1048576)} MB (kern.yaml anhaenge.max_mb).`, 'zu_gross'), { grund: 'zu_gross' });
  }
  const ext = (/\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1] ?? '').toLowerCase();
  if (!ext || !inhalt.byteLength) return;
  const sig = SIGNATUR[ext];
  if (sig && !sig(inhalt)) throw new KernFehler(415, `Der Inhalt passt nicht zur Endung .${ext}. Bitte die Datei mit der richtigen Endung hochladen.`, 'typ_passt_nicht');
  if (TEXT.has(ext) && inhalt.subarray(0, 8192).includes(0)) throw new KernFehler(415, `Die Datei .${ext} enthält Binärdaten und ist kein Text.`, 'typ_passt_nicht');
}
