import { NetzFehler, sichererAbruf, type NetzOptionen } from './netz.js';
import { docxHtmlImWorker, pdfImWorker, type ParserGrenzen } from './parser.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type { WhisperConfig } from './types.js';
import { parseMarkdown } from './util.js';

const execFileP = promisify(execFile);

export interface IngestErgebnis {
  /** Markdown-Text der Quelle. */
  text: string;
  titel?: string;
  /** Original-Datei, die neben der Quelle abgelegt wird. */
  original?: { ext: string; daten: Buffer };
  /** Zusätzliche Kopf-Felder (z. B. `transkript: wartet`). */
  kopf?: Record<string, unknown>;
}

function turndown(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*' });
  td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'svg'] as any);
  // Einfache Tabellen als Markdown-Tabellen
  td.addRule('tabelle', {
    filter: 'table',
    replacement: (_c, node: any) => {
      const rows: string[][] = [];
      for (const tr of Array.from(node.querySelectorAll('tr')) as any[]) {
        rows.push((Array.from(tr.querySelectorAll('th,td')) as any[]).map((c) => String(c.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
      }
      if (!rows.length) return '';
      const breite = Math.max(...rows.map((r) => r.length));
      const zeile = (r: string[]) => `| ${Array.from({ length: breite }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return `\n\n${zeile(rows[0]!)}\n| ${Array.from({ length: breite }, () => '---').join(' | ')} |\n${rows.slice(1).map(zeile).join('\n')}\n\n`;
    },
  });
  return td;
}

export function htmlZuMarkdown(html: string): string {
  return turndown()
    .turndown(html)
    .replace(/^(\s*)([-*]|\d+\.)[ \t]{2,}/gm, '$1$2 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** HTML-Dokument: Titel + Hauptinhalt (Readability), sonst ganzer Body. */
export function htmlDokumentZuMarkdown(html: string, url?: string): { titel?: string; text: string } {
  const { document } = parseHTML(html);
  const titel = document.querySelector('title')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || undefined;
  let inhalt: string | null = null;
  try {
    const art = new Readability(document as any, { keepClasses: false }).parse();
    if (art?.content && (art.textContent ?? '').trim().length > 80) inhalt = art.content;
    if (art?.title && !titel) return { titel: art.title, text: htmlZuMarkdown(inhalt ?? '') };
  } catch {
    /* Rückfall */
  }
  if (!inhalt) {
    const { document: d2 } = parseHTML(html);
    inhalt = d2.querySelector('main')?.innerHTML ?? d2.querySelector('body')?.innerHTML ?? html;
  }
  void url;
  return { ...(titel ? { titel } : {}), text: htmlZuMarkdown(inhalt) };
}

/** PDF → Markdown, im Worker mit Grenzen (S1 M8). */
export async function pdfZuMarkdown(daten: Uint8Array, g: ParserGrenzen = {}): Promise<{ titel?: string; text: string }> {
  return pdfImWorker(Buffer.from(daten.buffer, daten.byteOffset, daten.byteLength), g);
}

/** DOCX → Markdown: ZIP-Verzeichnis vorab geprüft, Umwandlung im Worker mit Grenzen (S1 M8). */
export async function docxZuMarkdown(daten: Buffer, g: ParserGrenzen = {}): Promise<{ text: string; titel?: string }> {
  const md = htmlZuMarkdown(await docxHtmlImWorker(daten, g));
  const h = /^#{1,2}\s+(.+)$/m.exec(md);
  return { text: md, ...(h?.[1] ? { titel: h[1].trim() } : {}) };
}

export async function ladeWebseite(url: string, timeoutMs = 20_000, produkt = 'Kern', netz: NetzOptionen = {}): Promise<{ titel?: string; text: string; html: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Nur http(s)-Adressen');
  const r = await sichererAbruf(url, {
    timeoutMs, ...netz,
    headers: { 'user-agent': `${produkt.replace(/[^\w.-]/g, '')}/0.1 (+Wissensordner)`, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
  });
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`Seite antwortet ${r.status}`), { status: r.status });
  const html = r.text();
  if (r.typ.includes('text/plain') || r.typ.includes('markdown')) return { text: html.trim(), html };
  return { ...htmlDokumentZuMarkdown(html, r.url), html };
}

/** robots.txt respektieren: true = Abruf erlaubt. Fehlende robots.txt = erlaubt. */
export async function robotsErlaubt(url: string, agent: string, timeoutMs = 10_000, netz: NetzOptionen = {}): Promise<boolean> {
  const u = new URL(url);
  let text = '';
  try {
    const r = await sichererAbruf(`${u.origin}/robots.txt`, { timeoutMs, maxBytes: 512 * 1024, ...netz, headers: { 'user-agent': agent } });
    if (r.status === 401 || r.status === 403) return false;
    if (r.status < 200 || r.status >= 300) return true;
    text = r.text();
  } catch (e) {
    if (e instanceof NetzFehler && (e.grund === 'gesperrt' || e.grund === 'adresse' || e.grund === 'port')) throw e;
    return true;
  }
  const regeln: { agenten: string[]; verbote: string[]; erlaubt: string[] }[] = [];
  let aktuell: { agenten: string[]; verbote: string[]; erlaubt: string[] } | null = null;
  let letzteWarAgent = false;
  for (const roh of text.split(/\r?\n/)) {
    const z = roh.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(z);
    if (!m) continue;
    const feld = m[1]!.toLowerCase();
    const wert = m[2]!.trim();
    if (feld === 'user-agent') {
      if (!aktuell || !letzteWarAgent) {
        aktuell = { agenten: [], verbote: [], erlaubt: [] };
        regeln.push(aktuell);
      }
      aktuell.agenten.push(wert.toLowerCase());
      letzteWarAgent = true;
      continue;
    }
    letzteWarAgent = false;
    if (!aktuell) continue;
    if (feld === 'disallow' && wert) aktuell.verbote.push(wert);
    if (feld === 'allow' && wert) aktuell.erlaubt.push(wert);
  }
  const name = agent.split('/')[0]!.toLowerCase();
  const gruppe = regeln.find((r) => r.agenten.some((a) => a !== '*' && name.includes(a))) ?? regeln.find((r) => r.agenten.includes('*'));
  if (!gruppe) return true;
  const pfad = u.pathname + u.search;
  const passt = (muster: string) => {
    const re = new RegExp('^' + muster.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    return re.test(pfad);
  };
  const verbot = gruppe.verbote.filter(passt).sort((a, b) => b.length - a.length)[0];
  const erlaubt = gruppe.erlaubt.filter(passt).sort((a, b) => b.length - a.length)[0];
  if (!verbot) return true;
  return !!erlaubt && erlaubt.length >= verbot.length;
}

export async function transkribiere(datei: string, w: WhisperConfig): Promise<string> {
  const args = (w.argumente ?? [...(w.modell ? ['-m', '{modell}'] : []), '-nt', '-f', '{datei}']).map((a) =>
    a.replace('{datei}', datei).replace('{modell}', w.modell ?? ''),
  );
  const { stdout } = await execFileP(w.pfad, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
  return stdout
    .split('\n')
    .map((z) => z.replace(/^\s*\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');
}

const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.webm', '.aac', '.opus']);
const HTML = new Set(['.html', '.htm', '.xhtml']);
const TEXT = new Set(['.md', '.markdown', '.txt', '.text', '.csv']);

export function istAudio(pfad: string): boolean {
  return AUDIO.has(extname(pfad).toLowerCase());
}

/** Datei nach Endung einlesen. */
export async function leseDatei(pfad: string, whisper?: WhisperConfig, grenzen: ParserGrenzen = {}): Promise<IngestErgebnis> {
  const ext = extname(pfad).toLowerCase();
  const daten = await readFile(pfad);
  const name = basename(pfad, extname(pfad));
  const original = { ext: ext.slice(1) || 'bin', daten };
  if (TEXT.has(ext)) {
    const roh = daten.toString('utf8');
    if (ext === '.md' || ext === '.markdown') {
      const p = parseMarkdown(roh);
      const t = typeof p.kopf['titel'] === 'string' ? (p.kopf['titel'] as string) : typeof p.kopf['title'] === 'string' ? (p.kopf['title'] as string) : /^#\s+(.+)$/m.exec(p.text)?.[1];
      return { text: p.text.trim(), titel: t ?? name, original };
    }
    return { text: roh.trim(), titel: name, original };
  }
  if (HTML.has(ext)) {
    const r = htmlDokumentZuMarkdown(daten.toString('utf8'));
    return { text: r.text, titel: r.titel ?? name, original };
  }
  if (ext === '.pdf') {
    const r = await pdfZuMarkdown(daten, grenzen);
    return { text: r.text, titel: r.titel ?? name, original };
  }
  if (ext === '.docx') {
    const r = await docxZuMarkdown(daten, grenzen);
    return { text: r.text, titel: r.titel ?? name, original };
  }
  if (AUDIO.has(ext)) {
    if (!whisper) return { text: '*Wartet auf Transkript.* Für Audio ist kein whisper-Programm eingerichtet.', titel: name, original, kopf: { transkript: 'wartet' } };
    const t = await transkribiere(pfad, whisper);
    return { text: t, titel: name, original, kopf: { transkript: 'fertig' } };
  }
  throw new Error(`Dateityp ${ext || '(ohne Endung)'} wird nicht unterstützt (md, txt, html, pdf, docx, Audio)`);
}
