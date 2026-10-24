import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ordneNachBaum } from '../baum.js';
import type { OutlineAnhang, OutlineBuendel, OutlineDokument, OutlineKommentar, OutlineSammlung } from '../typen.js';
import { sammleAnhangVerweise } from '../links.js';

/**
 * Liest einen „MCP-Abzug“: einen Ordner mit `sammlungen.json` (Sammlungen, Bäume, Kommentare)
 * und `dokumente/*.md`. Jede Dokumentdatei hat in der ersten Zeile das JSON, das das Outline-MCP-Werkzeug
 * `fetch` liefert ({document, breadcrumb}), danach den Markdown-Text unverändert.
 * Anhänge werden nur erkannt, nicht geladen (MCP liefert dafür kurzlebige Adressen).
 */
export async function leseMcpAbzug(ordner: string): Promise<OutlineBuendel> {
  const kopf = JSON.parse(await readFile(join(ordner, 'sammlungen.json'), 'utf8')) as {
    abzug?: { quelle?: string };
    sammlungen: { id: string; urlId?: string; url?: string; name: string; description?: string | null; permission?: 'read' | 'read_write' | null; documentStructure?: OutlineSammlung['baum'] }[];
    kommentare?: { id: string; documentId: string; parentCommentId: string | null; createdBy?: { name?: string }; createdAt: string; resolvedAt?: string | null; text: string }[];
  };
  const basisUrl = kopf.abzug?.quelle?.replace(/\/+$/, '') ?? null;
  const sammlungen: OutlineSammlung[] = kopf.sammlungen.map((s) => ({
    id: s.id,
    urlId: s.urlId ?? null,
    url: s.url ?? null,
    name: s.name,
    beschreibung: s.description ?? null,
    permission: s.permission ?? null,
    baum: s.documentStructure ?? [],
  }));
  const warnungen: string[] = [];
  const dokumente: OutlineDokument[] = [];
  const dateien = (await readdir(join(ordner, 'dokumente'))).filter((f) => f.endsWith('.md')).sort();
  for (const f of dateien) {
    const roh = await readFile(join(ordner, 'dokumente', f), 'utf8');
    const umbruch = roh.indexOf('\n');
    let meta: { document: Record<string, unknown>; breadcrumb?: string };
    try {
      meta = JSON.parse(roh.slice(0, umbruch));
    } catch {
      warnungen.push(`${f}: erste Zeile ist kein JSON, übersprungen`);
      continue;
    }
    const d = meta.document;
    const name = (x: unknown) => (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string' ? (x as { name: string }).name : null);
    const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null);
    dokumente.push({
      schluessel: s('urlId') ?? s('id') ?? f,
      id: s('id'),
      urlId: s('urlId'),
      url: s('url'),
      titel: s('title') ?? f.replace(/\.md$/, ''),
      icon: s('icon'),
      sammlungId: s('collectionId') ?? '',
      elternId: s('parentDocumentId'),
      exportPfad: null,
      markdown: roh.slice(umbruch + 1).replace(/\s+$/, '') + '\n',
      erstelltAm: s('createdAt'),
      geaendertAm: s('updatedAt'),
      veroeffentlichtAm: s('publishedAt'),
      archiviertAm: s('archivedAt'),
      autor: name(d['createdBy']),
      geaendertVon: name(d['updatedBy']),
      revision: typeof d['revision'] === 'number' ? (d['revision'] as number) : null,
      breadcrumb: meta.breadcrumb ?? null,
    });
  }
  const anhaenge = sammleAnhaenge(dokumente);
  const kommentare: OutlineKommentar[] = (kopf.kommentare ?? []).map((k) => ({
    id: k.id,
    dokumentId: k.documentId,
    elternId: k.parentCommentId ?? null,
    autor: k.createdBy?.name ?? 'unbekannt',
    erstelltAm: k.createdAt,
    erledigtAm: k.resolvedAt ?? null,
    text: k.text,
  }));
  return ordneNachBaum({ art: 'mcp-abzug', basisUrl, sammlungen, dokumente, anhaenge, kommentare, warnungen });
}

/** Anhänge aus /api/attachments.redirect?id=… in allen Dokumenten (ohne Download). */
export function sammleAnhaenge(dokumente: OutlineDokument[], lader?: (id: string) => (() => Promise<Buffer | null>) | null): OutlineAnhang[] {
  const nachId = new Map<string, OutlineAnhang>();
  for (const d of dokumente) {
    for (const v of sammleAnhangVerweise(d.markdown)) {
      const a = nachId.get(v.id) ?? { id: v.id, name: v.name, contentType: null, groesse: null, exportPfad: null, dokumente: [], lade: lader ? lader(v.id) : null };
      if (!a.dokumente.includes(d.schluessel)) a.dokumente.push(d.schluessel);
      if ((!a.name || a.name === v.id) && v.name) a.name = v.name;
      nachId.set(v.id, a);
    }
  }
  return [...nachId.values()];
}
