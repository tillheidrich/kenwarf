/**
 * S1 M8: PDF und DOCX nie im Hauptprozess ohne Grenzen. Jede Datei läuft in einem eigenen Worker-Thread mit
 * Zeitlimit, Speichergrenze, Seitengrenze (PDF) und Entpackgrenze (DOCX, vor dem Entpacken aus dem ZIP-Verzeichnis
 * gelesen). Höchstens zwei Parser gleichzeitig.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

export interface ParserGrenzen {
  /** Höchstgröße der Datei (Standard 50 MB). */
  maxBytes?: number;
  /** PDF: höchstens so viele Seiten (Standard 500). */
  maxSeiten?: number;
  /** DOCX: Summe der entpackten Größen (Standard 100 MB) und höchstens 2.000 Einträge. */
  maxEntpackt?: number;
  /** DOCX: höchstes Verhältnis entpackt zu gepackt je Eintrag (Standard 100). */
  maxVerhaeltnis?: number;
  /** Zeitlimit je Datei (Standard 60 s). */
  zeitMs?: number;
  /** Heap-Grenze des Workers (Standard 512 MB). */
  speicherMb?: number;
}

export class ParserFehler extends Error {
  constructor(public grund: 'zu_gross' | 'zu_viele_seiten' | 'entpackgrenze' | 'zeit' | 'kaputt', message: string) {
    super(message);
    this.name = 'ParserFehler';
  }
}

const STD = { maxBytes: 50 * 1024 * 1024, maxSeiten: 500, maxEntpackt: 100 * 1024 * 1024, maxVerhaeltnis: 100, zeitMs: 60_000, speicherMb: 512 };

/** ZIP-Verzeichnis lesen, ohne zu entpacken: Summe der entpackten Größen, Anzahl, Verhältnis, Pfade. */
export function pruefeZip(daten: Buffer, g: ParserGrenzen = {}): { eintraege: number; entpackt: number } {
  const maxEntpackt = g.maxEntpackt ?? STD.maxEntpackt;
  const maxV = g.maxVerhaeltnis ?? STD.maxVerhaeltnis;
  // End of Central Directory suchen (letzte 64 KB + 22)
  let eocd = -1;
  for (let i = daten.length - 22; i >= Math.max(0, daten.length - 65_557); i--) {
    if (daten.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ParserFehler('kaputt', 'Keine gültige DOCX-Datei (ZIP-Verzeichnis fehlt)');
  const anzahl = daten.readUInt16LE(eocd + 10);
  const groesse = daten.readUInt32LE(eocd + 12);
  const start = daten.readUInt32LE(eocd + 16);
  if (anzahl === 0xffff || start === 0xffffffff) throw new ParserFehler('entpackgrenze', 'ZIP64 wird bei DOCX nicht angenommen');
  if (anzahl > 2000) throw new ParserFehler('entpackgrenze', `Zu viele Einträge im Dokument (${anzahl})`);
  if (start + groesse > daten.length) throw new ParserFehler('kaputt', 'ZIP-Verzeichnis beschädigt');
  let pos = start;
  let summe = 0;
  for (let n = 0; n < anzahl; n++) {
    if (pos + 46 > daten.length || daten.readUInt32LE(pos) !== 0x02014b50) throw new ParserFehler('kaputt', 'ZIP-Verzeichnis beschädigt');
    const gepackt = daten.readUInt32LE(pos + 20);
    const entpackt = daten.readUInt32LE(pos + 24);
    const nl = daten.readUInt16LE(pos + 28);
    const el = daten.readUInt16LE(pos + 30);
    const kl = daten.readUInt16LE(pos + 32);
    const name = daten.subarray(pos + 46, pos + 46 + nl).toString('utf8');
    const extAttr = daten.readUInt32LE(pos + 38);
    if (name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\')) throw new ParserFehler('kaputt', 'Unzulässiger Pfad im Dokument');
    if (((extAttr >>> 16) & 0o170000) === 0o120000) throw new ParserFehler('kaputt', 'Symbolische Links im Dokument');
    if (gepackt === 0xffffffff || entpackt === 0xffffffff) throw new ParserFehler('entpackgrenze', 'ZIP64 wird bei DOCX nicht angenommen');
    if (entpackt > 1024 * 1024 && entpackt / Math.max(1, gepackt) > maxV) throw new ParserFehler('entpackgrenze', 'Auffällig stark gepackter Inhalt (möglicherweise eine ZIP-Bombe)');
    summe += entpackt;
    if (summe > maxEntpackt) throw new ParserFehler('entpackgrenze', `Entpackt größer als ${Math.round(maxEntpackt / 1024 / 1024)} MB`);
    pos += 46 + nl + el + kl;
  }
  return { eintraege: anzahl, entpackt: summe };
}

/* ---------------- Worker ---------------- */

const WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { art, daten, maxSeiten, pdfjsUrl, mammothPfad } = workerData;
  try {
    if (art === 'pdf') {
      const pdfjs = await import(pdfjsUrl);
      const aufgabe = pdfjs.getDocument({ data: new Uint8Array(daten), useSystemFonts: false, verbosity: 0, isEvalSupported: false, disableFontFace: true });
      const doc = await aufgabe.promise;
      if (doc.numPages > maxSeiten) { parentPort.postMessage({ fehler: 'zu_viele_seiten', text: 'Das PDF hat ' + doc.numPages + ' Seiten, höchstens ' + maxSeiten + ' sind erlaubt' }); await aufgabe.destroy(); return; }
      let titel;
      try { const m = await doc.getMetadata(); const t = m.info && m.info.Title; if (typeof t === 'string' && t.trim()) titel = t.trim(); } catch {}
      const seiten = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        let s = '';
        for (const it of tc.items) {
          if (typeof it.str !== 'string') continue;
          s += it.str;
          s += it.hasEOL ? '\n' : it.str && !it.str.endsWith(' ') ? ' ' : '';
        }
        const sauber = s.split('\n').map((z) => z.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
        seiten.push('## Seite ' + i + '\n\n' + sauber);
        page.cleanup();
      }
      await aufgabe.destroy();
      parentPort.postMessage({ titel, text: seiten.join('\n\n') });
    } else {
      const mammoth = require(mammothPfad);
      const r = await mammoth.convertToHtml({ buffer: Buffer.from(daten) });
      parentPort.postMessage({ html: r.value });
    }
  } catch (e) {
    parentPort.postMessage({ fehler: 'kaputt', text: String((e && e.message) || e).slice(0, 200) });
  }
})();
`;

let laufend = 0;
const warteschlange: (() => void)[] = [];
async function platz(): Promise<() => void> {
  if (laufend >= 2) await new Promise<void>((r) => warteschlange.push(r));
  laufend++;
  return () => {
    laufend--;
    warteschlange.shift()?.();
  };
}

const req = createRequire(import.meta.url);

async function imWorker(art: 'pdf' | 'docx', daten: Buffer, g: ParserGrenzen): Promise<{ titel?: string; text?: string; html?: string }> {
  const frei = await platz();
  try {
    const pdfjsUrl = pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
    const mammothPfad = req.resolve('mammoth');
    const kopie = new Uint8Array(daten); // eigener Puffer, übertragbar
    const w = new Worker(WORKER, {
      eval: true,
      workerData: { art, daten: kopie, maxSeiten: g.maxSeiten ?? STD.maxSeiten, pdfjsUrl, mammothPfad },
      transferList: [kopie.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: g.speicherMb ?? STD.speicherMb, maxYoungGenerationSizeMb: 64 },
    });
    return await new Promise((ok, fehl) => {
      const t = setTimeout(() => {
        void w.terminate();
        fehl(new ParserFehler('zeit', `Verarbeitung länger als ${Math.round((g.zeitMs ?? STD.zeitMs) / 1000)} s abgebrochen`));
      }, g.zeitMs ?? STD.zeitMs);
      w.once('message', (m: { fehler?: ParserFehler['grund']; text?: string; titel?: string; html?: string }) => {
        clearTimeout(t);
        void w.terminate();
        if (m.fehler) fehl(new ParserFehler(m.fehler, m.fehler === 'kaputt' ? `Datei nicht lesbar: ${m.text ?? ''}` : m.text ?? 'Grenze überschritten'));
        else ok(m);
      });
      w.once('error', (e: Error) => {
        clearTimeout(t);
        fehl(new ParserFehler((e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'zu_gross' : 'kaputt', `Datei nicht lesbar: ${e.message.slice(0, 200)}`));
      });
      w.once('exit', (c) => {
        clearTimeout(t);
        if (c !== 0) fehl(new ParserFehler('kaputt', 'Verarbeitung abgebrochen'));
      });
    });
  } finally {
    frei();
  }
}

export async function pdfImWorker(daten: Buffer, g: ParserGrenzen = {}): Promise<{ titel?: string; text: string }> {
  if (daten.length > (g.maxBytes ?? STD.maxBytes)) throw new ParserFehler('zu_gross', `Datei größer als ${Math.round((g.maxBytes ?? STD.maxBytes) / 1024 / 1024)} MB`);
  const r = await imWorker('pdf', daten, g);
  return { ...(r.titel ? { titel: r.titel } : {}), text: r.text ?? '' };
}

export async function docxHtmlImWorker(daten: Buffer, g: ParserGrenzen = {}): Promise<string> {
  if (daten.length > (g.maxBytes ?? STD.maxBytes)) throw new ParserFehler('zu_gross', `Datei größer als ${Math.round((g.maxBytes ?? STD.maxBytes) / 1024 / 1024)} MB`);
  pruefeZip(daten, g);
  return (await imWorker('docx', daten, g)).html ?? '';
}
