import { ordneNachBaum } from '../baum.js';
import type { OutlineBuendel, OutlineDokument, OutlineKommentar, OutlineKnoten, OutlineSammlung } from '../typen.js';
import { sammleAnhaenge } from './mcp-abzug.js';

export interface ApiOptionen {
  /** Wiki-Adresse, Standard: Umgebungsvariable OUTLINE_URL. */
  basisUrl?: string;
  /** API-Schlüssel, Standard: Umgebungsvariable OUTLINE_API_TOKEN. Steht nie im Code oder in Berichten. */
  token?: string;
  /** Nur diese Sammlungen (Name, id oder urlId). Standard: alle, auf die der Schlüssel Zugriff hat. */
  sammlungen?: string[];
  kommentare?: boolean;
  /** Anhänge herunterladbar machen (Standard true). */
  anhaenge?: boolean;
  /** Archivierte Dokumente mitnehmen (als „veraltet“). Standard false. */
  archivierte?: boolean;
  /** Für Tests: eigene fetch-Funktion. */
  fetch?: typeof fetch;
  /** Wartezeit bei 429 in ms, Standard aus Retry-After. */
  pauseMs?: number;
}

/**
 * Liest Sammlungen, Dokumente (Markdown aus documents.info), Kommentare und Anhangsverweise über die Outline-API.
 * Nur lesende Methoden: collections.list, collections.documents, documents.list, documents.info,
 * documents.archived, comments.list, attachments.redirect. Schreibt nie ins Wiki.
 */
export async function leseApi(opt: ApiOptionen = {}): Promise<OutlineBuendel> {
  const basisUrl = (opt.basisUrl ?? process.env['OUTLINE_URL'] ?? '').replace(/\/+$/, '');
  const token = opt.token ?? process.env['OUTLINE_API_TOKEN'] ?? '';
  if (!basisUrl) throw new Error('Wiki-Adresse fehlt (Option basisUrl oder Umgebungsvariable OUTLINE_URL)');
  if (!token) throw new Error('API-Schlüssel fehlt (Umgebungsvariable OUTLINE_API_TOKEN)');
  const f = opt.fetch ?? fetch;
  const warnungen: string[] = [];

  const rufe = async <T>(methode: string, body: Record<string, unknown>): Promise<T> => {
    for (let versuch = 0; versuch < 5; versuch++) {
      const r = await f(`${basisUrl}/api/${methode}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (r.status === 429) {
        const warte = opt.pauseMs ?? Number(r.headers.get('retry-after') ?? '2') * 1000;
        await new Promise((ok) => setTimeout(ok, warte));
        continue;
      }
      if (!r.ok) throw new Error(`Outline-API ${methode}: HTTP ${r.status}`);
      return (await r.json()) as T;
    }
    throw new Error(`Outline-API ${methode}: zu viele Anfragen (429)`);
  };
  const alle = async <T>(methode: string, body: Record<string, unknown>): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; ; offset += 100) {
      const r = await rufe<{ data: T[] }>(methode, { ...body, limit: 100, offset });
      out.push(...r.data);
      if (r.data.length < 100) break;
    }
    return out;
  };

  type ApiSammlung = { id: string; urlId: string; url?: string; name: string; description?: string | null; permission?: 'read' | 'read_write' | null };
  let roh = await alle<ApiSammlung>('collections.list', {});
  if (opt.sammlungen?.length) {
    const w = new Set(opt.sammlungen.map((x) => x.toLowerCase()));
    roh = roh.filter((s) => w.has(s.name.toLowerCase()) || w.has(s.id) || w.has(s.urlId.toLowerCase()));
  }
  const sammlungen: OutlineSammlung[] = [];
  const dokumente: OutlineDokument[] = [];
  const kommentare: OutlineKommentar[] = [];
  type ApiDok = { id: string; urlId: string; url: string; title: string; icon?: string | null; text?: string; createdAt: string; updatedAt: string; publishedAt: string | null; archivedAt: string | null; createdBy?: { name?: string }; updatedBy?: { name?: string }; revision?: number; collectionId: string; parentDocumentId: string | null };
  for (const s of roh) {
    const baum = (await rufe<{ data: OutlineKnoten[] }>('collections.documents', { id: s.id })).data;
    sammlungen.push({ id: s.id, urlId: s.urlId, url: s.url ? (s.url.startsWith('http') ? s.url : basisUrl + s.url) : null, name: s.name, beschreibung: s.description ?? null, permission: s.permission ?? null, baum });
    const liste = await alle<ApiDok>('documents.list', { collectionId: s.id });
    if (opt.archivierte) liste.push(...(await alle<ApiDok>('documents.archived', { collectionId: s.id })));
    for (const kurz of liste) {
      const d = typeof kurz.text === 'string' ? kurz : (await rufe<{ data: ApiDok }>('documents.info', { id: kurz.id })).data;
      dokumente.push({
        schluessel: d.urlId,
        id: d.id,
        urlId: d.urlId,
        url: d.url.startsWith('http') ? d.url : basisUrl + d.url,
        titel: d.title,
        icon: d.icon ?? null,
        sammlungId: d.collectionId,
        elternId: d.parentDocumentId,
        exportPfad: null,
        markdown: (d.text ?? '').replace(/\s+$/, '') + '\n',
        erstelltAm: d.createdAt,
        geaendertAm: d.updatedAt,
        veroeffentlichtAm: d.publishedAt,
        archiviertAm: d.archivedAt,
        autor: d.createdBy?.name ?? null,
        geaendertVon: d.updatedBy?.name ?? null,
        revision: d.revision ?? null,
        breadcrumb: null,
      });
    }
    if (opt.kommentare !== false) {
      type ApiKommentar = { id: string; documentId: string; parentCommentId: string | null; createdBy?: { name?: string }; createdAt: string; resolvedAt?: string | null; text?: string; data?: unknown };
      for (const k of await alle<ApiKommentar>('comments.list', { collectionId: s.id })) {
        kommentare.push({ id: k.id, dokumentId: k.documentId, elternId: k.parentCommentId, autor: k.createdBy?.name ?? 'unbekannt', erstelltAm: k.createdAt, erledigtAm: k.resolvedAt ?? null, text: k.text ?? '' });
        if (!k.text) warnungen.push(`Kommentar ${k.id}: kein Text im API-Ergebnis`);
      }
    }
  }
  const lader = opt.anhaenge === false
    ? undefined
    : (id: string) => async (): Promise<Buffer | null> => {
        const r = await f(`${basisUrl}/api/attachments.redirect?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' });
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      };
  const anhaenge = sammleAnhaenge(dokumente, lader);
  return ordneNachBaum({ art: 'api', basisUrl, sammlungen, dokumente, anhaenge, kommentare, warnungen });
}
