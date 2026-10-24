/**
 * Export/Import im Open Knowledge Format (OKF) v0.2.
 * Kern-Dateien sind schon fast OKF: Export ergänzt die OKF-Felder (title, description, status, stale_after, sources, tags),
 * merkt sich in `okf_abgeleitet`, welche Felder er ergänzt hat, und verschiebt den Kern-Status nach `kern_status`.
 * Import nimmt genau das zurück. Unbekannte Felder bleiben erhalten.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { erzeugeIndex, istReserviert } from './ordnerindex.js';
import type { DateiEintrag } from './suchindex.js';
import { ordneArtikelKopf, ordneQuellenKopf } from './kopf.js';
import type { ArtikelKopf, QuellenKopf } from './types.js';
import { parseMarkdown, saetze, stringifyMarkdown } from './util.js';

export const OKF_VERSION = '0.2';
const STATUS_OKF: Record<string, string> = { entwurf: 'draft', freigegeben: 'stable', veraltet: 'deprecated' };

export function artikelNachOkf(inhalt: string, quellTitel: Map<string, string>): string {
  const p = parseMarkdown(inhalt);
  const k = p.kopf;
  const okf: Record<string, unknown> = { type: k['type'] ?? 'Artikel' };
  const abgeleitet: string[] = [];
  const setze = (f: string, v: unknown) => {
    if (k[f] !== undefined || v === undefined || v === null) return;
    okf[f] = v;
    abgeleitet.push(f);
  };
  setze('title', k['titel']);
  const kurz = typeof k['kurzfassung'] === 'string' ? saetze(k['kurzfassung'])[0] : undefined;
  if (kurz) setze('description', kurz);
  if (typeof k['status'] === 'string' && STATUS_OKF[k['status']]) {
    okf['status'] = STATUS_OKF[k['status']];
    abgeleitet.push('status');
  }
  if (typeof k['pruefen_bis'] === 'string') setze('stale_after', `${k['pruefen_bis']}T00:00:00Z`);
  if (Array.isArray(k['fundstellen']) && k['fundstellen'].length) {
    setze(
      'sources',
      (k['fundstellen'] as { id: string; quelle: string }[]).map((f) => ({ id: f.id, resource: `/${f.quelle}`, title: quellTitel.get(f.quelle) ?? posix.basename(f.quelle, '.md') })),
    );
  }
  if (typeof k['gruppe'] === 'string') setze('tags', [k['gruppe']]);
  const rest: Record<string, unknown> = {};
  for (const [f, v] of Object.entries(k)) {
    if (f === 'type') continue;
    if (f === 'status' && abgeleitet.includes('status')) rest['kern_status'] = v;
    else if (!(f in okf)) rest[f] = v;
  }
  return stringifyMarkdown({ ...okf, ...rest, okf_abgeleitet: abgeleitet }, p.text);
}

export function quelleNachOkf(inhalt: string): string {
  const p = parseMarkdown(inhalt);
  const k = p.kopf;
  if (k['title'] !== undefined || typeof k['titel'] !== 'string') return inhalt;
  const { type, ...rest } = k;
  return stringifyMarkdown({ type: type ?? 'Quelle', title: k['titel'], ...rest, okf_abgeleitet: ['title'] }, p.text);
}

/** Abgeleitete OKF-Felder entfernen, Kern-Kopf wiederherstellen. */
export function ausOkf(kopf: Record<string, unknown>): Record<string, unknown> {
  const abg = kopf['okf_abgeleitet'];
  if (!Array.isArray(abg)) return kopf;
  const k = { ...kopf };
  for (const f of abg) delete k[String(f)];
  delete k['okf_abgeleitet'];
  if (k['kern_status'] !== undefined) {
    k['status'] = k['kern_status'];
    delete k['kern_status'];
  }
  return k;
}

export async function exportiereOkfBuendel(
  ziel: string,
  dateien: { pfad: string; inhalt: string | Buffer }[],
  opt: { betrieb: string; quellTitel: Map<string, string>; eintraege: DateiEintrag[]; produkt?: string },
): Promise<number> {
  let n = 0;
  const schreibe = async (pfad: string, inhalt: string | Buffer) => {
    const abs = join(ziel, pfad);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, inhalt);
    n++;
  };
  for (const d of dateien) {
    if (typeof d.inhalt !== 'string' || !d.pfad.endsWith('.md') || d.pfad.includes('.orig.') || istReserviert(d.pfad)) await schreibe(d.pfad, d.inhalt);
    else if (d.pfad.startsWith('wissen/')) await schreibe(d.pfad, artikelNachOkf(d.inhalt, opt.quellTitel));
    else await schreibe(d.pfad, quelleNachOkf(d.inhalt));
  }
  // Verzeichnisse (index.md) frisch erzeugen, Wurzel mit okf_version
  const kurz = new Map<string, string>();
  for (const d of dateien) if (d.pfad.startsWith('wissen/') && typeof d.inhalt === 'string') kurz.set(d.pfad, String(parseMarkdown(d.inhalt).kopf['kurzfassung'] ?? ''));
  const ordner = new Set(['', 'wissen', 'quellen']);
  for (const e of opt.eintraege) {
    const t = e.pfad.split('/');
    if (t[0] === 'wissen' && t.length > 2) ordner.add(`wissen/${t[1]}`);
  }
  for (const o of ordner) await schreibe(o ? `${o}/index.md` : 'index.md', erzeugeIndex(o, opt.eintraege, opt.betrieb, kurz, opt.produkt, true));
  return n;
}

export interface OkfBuendel {
  kernQuellen: { pfad: string; inhalt: string; originale: { endung: string; daten: Buffer }[] }[];
  kernArtikel: { pfad: string; inhalt: string }[];
  fremd: { pfad: string; inhalt: string; titel?: string }[];
}

export async function leseOkfBuendel(dir: string): Promise<OkfBuendel> {
  const alle: string[] = [];
  const lauf = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await lauf(p);
      else if (e.isFile()) alle.push(p);
    }
  };
  await lauf('');
  const b: OkfBuendel = { kernQuellen: [], kernArtikel: [], fremd: [] };
  for (const p of alle.sort()) {
    if (!p.endsWith('.md') || p.includes('.orig.') || istReserviert(p)) continue;
    const roh = await readFile(join(dir, p), 'utf8');
    const m = parseMarkdown(roh);
    if (m.fehler || m.kopf['type'] === undefined) {
      b.fremd.push({ pfad: p, inhalt: roh });
      continue;
    }
    const k = ausOkf(m.kopf);
    if (p.startsWith('quellen/') && k['type'] === 'Quelle' && typeof k['erfasst_von'] === 'string' && typeof k['hash'] === 'string') {
      const basis = posix.basename(p, '.md');
      const originale: { endung: string; daten: Buffer }[] = [];
      for (const x of alle) if (posix.dirname(x) === posix.dirname(p) && posix.basename(x).startsWith(`${basis}.orig.`)) originale.push({ endung: posix.basename(x).slice(basis.length), daten: await readFile(join(dir, x)) });
      b.kernQuellen.push({ pfad: p, inhalt: stringifyMarkdown(ordneQuellenKopf(k as QuellenKopf), m.text), originale });
    } else if (p.startsWith('wissen/') && typeof k['titel'] === 'string' && typeof k['gruppe'] === 'string' && typeof k['besitzer'] === 'string') {
      b.kernArtikel.push({ pfad: p, inhalt: stringifyMarkdown(ordneArtikelKopf(k as ArtikelKopf), m.text) });
    } else {
      const titel = typeof m.kopf['title'] === 'string' ? (m.kopf['title'] as string) : typeof m.kopf['titel'] === 'string' ? (m.kopf['titel'] as string) : undefined;
      b.fremd.push({ pfad: p, inhalt: roh, ...(titel ? { titel } : {}) });
    }
  }
  return b;
}
