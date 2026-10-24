import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { berichtAlsMarkdown, importiereOutline, leseApi, leseExport } from '../src/index.js';
import { aufraeumen, minimalPdf, neuerKern, tmp } from './helfer.js';

afterEach(aufraeumen);

const ATT = 'a0000001-aaaa-4bbb-8ccc-000000000002';

/** JSON-Export wie ExportJSONTask (Outline 1.12.0): <Sammlung>.json + metadata.json + Anhänge unter ihrem Schlüssel. */
async function jsonZip(): Promise<string> {
  const zip = new JSZip();
  zip.file('metadata.json', JSON.stringify({ exportVersion: 1, version: '1.12.0', createdAt: '2026-10-24T06:00:00Z', createdById: 'u', createdByEmail: null }));
  const key = `uploads/a0000000-aaaa-4bbb-8ccc-000000000001/${ATT}/handbuch.pdf`;
  zip.file(key, minimalPdf(['Zwanzig Seiten Markenhandbuch.']));
  const para = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
  zip.file(
    'Marke & Branding.json',
    JSON.stringify({
      collection: {
        id: 'c1', urlId: 'MarkeAbc01', name: 'Marke & Branding', permission: 'read_write', sort: { field: 'title', direction: 'asc' },
        documentStructure: [{ id: 'd1', title: 'Start', url: '/doc/start-Start00001', children: [{ id: 'd2', title: 'Farbe', url: '/doc/farbe-Farbe00001', children: [] }] }],
      },
      documents: {
        d1: {
          id: 'd1', urlId: 'Start00001', title: 'Start', icon: '🎨', createdByName: 'Till Heidrich', createdAt: '2026-09-24T02:38:21Z', updatedAt: '2026-10-20T07:26:03Z', publishedAt: '2026-09-24T02:38:21Z', parentDocumentId: null, fullWidth: false,
          data: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Siehe ' }, { type: 'mention', attrs: { type: 'document', label: 'Farbe', modelId: 'd2' } }, { type: 'text', text: '.' }] },
              { type: 'attachment', attrs: { href: `/api/attachments.redirect?id=${ATT}`, title: 'handbuch.pdf', size: 900 } },
              { type: 'table', content: [{ type: 'tr', content: [{ type: 'th', content: [para('Baustein')] }, { type: 'th', content: [para('Festlegung')] }] }, { type: 'tr', content: [{ type: 'td', content: [para('Markenfarbe')] }, { type: 'td', content: [para('Kobalt')] }] }] },
            ],
          },
        },
        d2: { id: 'd2', urlId: 'Farbe00001', title: 'Farbe', createdByName: 'Till Heidrich', createdAt: '2026-09-24T02:39:01Z', updatedAt: '2026-09-24T02:39:01Z', publishedAt: '2026-09-24T02:39:01Z', parentDocumentId: 'd1', data: { type: 'doc', content: [para('Die Palette hat neun Werte.')] } },
      },
      attachments: { [ATT]: { id: ATT, documentId: 'd1', contentType: 'application/pdf', name: 'handbuch.pdf', size: 900, key } },
    }),
  );
  const p = join(tmp(), 'export-json.zip');
  writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));
  return p;
}

/** Markdown-Export wie ExportMarkdownZipTask: Ordner je Sammlung, Unterseiten im Ordner des Elterndokuments. */
async function markdownZip(okf = false): Promise<string> {
  const zip = new JSZip();
  const fm = (urlId: string, title: string) => (okf ? `---\ntype: Document\ntitle: ${title}\nresource: https://wiki.example.de/doc/${title.toLowerCase()}-${urlId}\nstatus: stable\ngenerated:\n  by: human:mail@example.de\n  at: 2026-10-20T07:26:03.000Z\n---\n\n` : '');
  zip.file('Marke & Branding/Start.md', `${fm('Start00001', 'Start')}# 🎨 Start\n\nSiehe [Farbe](./Start/Farbe.md) und das ![Logo](uploads/a/b/logo.png).\n`, { comment: JSON.stringify({ createdAt: '2026-09-24T02:38:21Z', updatedAt: '2026-10-20T07:26:03Z' }) } as JSZip.JSZipFileOptions);
  zip.file('Marke & Branding/Start/Farbe.md', `${fm('Farbe00001', 'Farbe')}# Farbe\n\nZurück zum [Start](../Start.md).\n`);
  zip.file('Marke & Branding/uploads/a/b/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (okf) zip.file('index.md', '---\nokf_version: "0.2"\n---\n\n# Collections\n\n* [Marke & Branding](Marke%20&%20Branding/)\n');
  const p = join(tmp(), okf ? 'export-okf.zip' : 'export-md.zip');
  writeFileSync(p, await zip.generateAsync({ type: 'nodebuffer' }));
  return p;
}

describe('leseExport', () => {
  it('JSON-Export: Sammlung mit Recht, Baum, ProseMirror → Markdown, Anhang aus dem Archiv', async () => {
    const b = await leseExport(await jsonZip(), { basisUrl: 'https://wiki.example.de' });
    expect(b.art).toBe('json-zip');
    expect(b.sammlungen[0]).toMatchObject({ name: 'Marke & Branding', permission: 'read_write', urlId: 'MarkeAbc01' });
    expect(b.dokumente.map((d) => d.titel)).toEqual(['Start', 'Farbe']);
    expect(b.dokumente[1]!.elternId).toBe('Start00001');
    expect(b.dokumente[0]!.markdown).toContain('Siehe [Farbe](/doc/d2).');
    expect(b.dokumente[0]!.markdown).toContain('| Markenfarbe | Kobalt |');
    expect(b.anhaenge[0]!.dokumente).toEqual(['Start00001']);
    expect((await b.anhaenge[0]!.lade!())!.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('JSON-Export importiert: Erwähnung wird Kern-Link, PDF wird Quelle', async () => {
    const { kern, dir, till } = await neuerKern();
    const r = await importiereOutline(kern, till, await leseExport(await jsonZip(), { basisUrl: 'https://wiki.example.de' }), { datenOrdner: dir, freigeben: true });
    expect(r.summe.anhaengeAlsQuelle).toBe(1);
    const a = await kern.leseArtikel(till, 'wissen/marke-branding/start.md');
    expect(a.text).toContain('Siehe [Farbe](./farbe.md).');
    expect(a.text).toMatch(/\[handbuch\.pdf\]\(\.\.\/\.\.\/quellen\/2026\/.+\.md\)/);
    await kern.schliesse();
  });

  it('Markdown-Export: Titel aus H1 ohne Symbol, Eltern aus Ordner, relative Links, Zeit aus ZIP-Kommentar, Warnung zu fehlenden Kennungen', async () => {
    const b = await leseExport(await markdownZip());
    expect(b.art).toBe('markdown-zip');
    expect(b.dokumente.map((d) => [d.titel, d.schluessel, d.elternId])).toEqual([
      ['Start', 'zip:Marke & Branding/Start.md', null],
      ['Farbe', 'zip:Marke & Branding/Start/Farbe.md', 'zip:Marke & Branding/Start.md'],
    ]);
    expect(b.dokumente[0]!.geaendertAm).toBe('2026-10-20T07:26:03Z');
    expect(b.warnungen.join(' ')).toMatch(/keine Outline-Kennungen/);
    const { kern, dir, till } = await neuerKern();
    const r = await importiereOutline(kern, till, b, { datenOrdner: dir });
    expect(r.dokumente[0]!.links.aufgeloest).toBe(1);
    expect(r.anhaenge[0]).toMatchObject({ name: 'logo.png', aktion: 'uebersprungen' });
    expect(r.sammlungen[0]!.sichtbarkeit).toBe('ich');
    expect(berichtAlsMarkdown(r)).toContain('Relativer Export-Verweis');
    await kern.schliesse();
  });

  it('OKF-Export: urlId aus resource, Wiki-Adresse erkannt', async () => {
    const b = await leseExport(await markdownZip(true));
    expect(b.art).toBe('okf-zip');
    expect(b.basisUrl).toBe('https://wiki.example.de');
    expect(b.dokumente.map((d) => d.schluessel)).toEqual(['Start00001', 'Farbe00001']);
    expect(b.dokumente[1]!.elternId).toBe('Start00001');
    expect(b.dokumente[0]!.geaendertVon).toBe('mail@example.de');
  });
});

describe('leseApi', () => {
  it('liest nur mit lesenden Methoden, Token nur im Header, Text per documents.info, Kommentare, Anhang über Weiterleitung', async () => {
    const aufrufe: string[] = [];
    let auth = '';
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        aufrufe.push(req.url!);
        auth = req.headers.authorization ?? '';
        const j = (x: unknown) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));
        const b = body ? JSON.parse(body) : {};
        switch (req.url!.split('?')[0]) {
          case '/api/collections.list':
            return j({ data: b.offset ? [] : [{ id: 'c1', urlId: 'MarkeAbc01', url: '/collection/marke-MarkeAbc01', name: 'Marke & Branding', permission: null }] });
          case '/api/collections.documents':
            return j({ data: [{ id: 'd1', title: 'Start', url: '/doc/start-Start00001', children: [] }] });
          case '/api/documents.list':
            return j({ data: [{ id: 'd1', urlId: 'Start00001', url: '/doc/start-Start00001', title: 'Start', collectionId: 'c1', parentDocumentId: null, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', publishedAt: '2026-09-24T00:00:00Z', archivedAt: null }] });
          case '/api/documents.info':
            return j({ data: { id: 'd1', urlId: 'Start00001', url: '/doc/start-Start00001', title: 'Start', text: `Handbuch: [handbuch.pdf](/api/attachments.redirect?id=${ATT})`, collectionId: 'c1', parentDocumentId: null, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', publishedAt: '2026-09-24T00:00:00Z', archivedAt: null, createdBy: { name: 'Till Heidrich' }, updatedBy: { name: 'Till Heidrich' }, revision: 4 } });
          case '/api/comments.list':
            return j({ data: [{ id: 'k1', documentId: 'd1', parentCommentId: null, createdBy: { name: 'Till Heidrich' }, createdAt: '2026-10-24T02:54:20Z', resolvedAt: null, text: 'Bitte prüfen.' }] });
          case '/api/attachments.redirect':
            res.writeHead(302, { location: '/signiert/handbuch.pdf' });
            return res.end();
          case '/signiert/handbuch.pdf':
            res.writeHead(200, { 'content-type': 'application/pdf' });
            return res.end(minimalPdf(['Handbuch aus der API.']));
          default:
            res.writeHead(404);
            return res.end();
        }
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const b = await leseApi({ basisUrl: url, token: 'ol_api_GEHEIM' });
      expect(auth).toBe('Bearer ol_api_GEHEIM');
      const methoden = aufrufe.map((a) => a.split('?')[0]!.replace('/api/', '')).filter((m) => !m.startsWith('/'));
      expect(new Set(methoden)).toEqual(new Set(['collections.list', 'collections.documents', 'documents.list', 'documents.info', 'comments.list']));
      expect(b.dokumente[0]).toMatchObject({ schluessel: 'Start00001', url: `${url}/doc/start-Start00001`, geaendertVon: 'Till Heidrich', revision: 4 });
      expect(b.kommentare).toHaveLength(1);
      const { kern, dir, till } = await neuerKern();
      const r = await importiereOutline(kern, till, b, { datenOrdner: dir });
      expect(r.summe.anhaengeAlsQuelle).toBe(1);
      expect(JSON.stringify(r)).not.toContain('GEHEIM');
      expect(r.sammlungen[0]!.sichtbarkeit).toBe('ich');
      await kern.schliesse();
    } finally {
      server.close();
    }
  });

  it('ohne Token bricht es mit klarer Meldung ab', async () => {
    const vorher = process.env['OUTLINE_API_TOKEN'];
    delete process.env['OUTLINE_API_TOKEN'];
    await expect(leseApi({ basisUrl: 'https://wiki.example.de' })).rejects.toThrow(/OUTLINE_API_TOKEN/);
    if (vorher !== undefined) process.env['OUTLINE_API_TOKEN'] = vorher;
  });
});
