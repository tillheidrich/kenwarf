import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kern, type User } from '@kern/core';
import type { OutlineBuendel, OutlineDokument } from '../src/index.js';

export const HEUTE = () => new Date('2026-10-24T10:00:00Z');
const ordner: string[] = [];

export function tmp(name = 'kern-io-test-'): string {
  const d = mkdtempSync(join(tmpdir(), name));
  ordner.push(d);
  return d;
}

export function aufraeumen(): void {
  for (const d of ordner.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function neuerKern(dir = tmp()): Promise<{ kern: Kern; dir: string; till: User; leser: User; mira: User }> {
  const kern = await Kern.open({ dataDir: dir, provider: { art: 'mock' }, betrieb: 'Heidrich Digital (Test)', sprache: 'de', heute: HEUTE } as Parameters<typeof Kern.open>[0]);
  const till = await kern.benutzer.anlegen('Till', 'geheim-geheim', ['admin'], []);
  const leser = await kern.benutzer.anlegen('Leser', 'geheim-geheim', ['leser'], []);
  const mira = await kern.benutzer.anlegen('Mira', 'geheim-geheim', ['autor'], ['marke-branding']);
  return { kern, dir, till, leser, mira };
}

/** Minimales gültiges PDF mit Textzeilen (wie in core/test/helfer.ts). */
export function minimalPdf(zeilen: string[], titel = 'Testdokument'): Buffer {
  const strom = `BT /F1 12 Tf 72 720 Td ${zeilen.map((z, i) => `${i ? '0 -20 Td ' : ''}(${z.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`;
  const objekte = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(strom)} >>\nstream\n${strom}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${titel}) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objekte.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function dok(teil: Partial<OutlineDokument> & Pick<OutlineDokument, 'schluessel' | 'titel' | 'sammlungId' | 'markdown'>): OutlineDokument {
  return {
    id: null, urlId: teil.schluessel, url: `https://wiki.example.de/doc/x-${teil.schluessel}`, icon: null, elternId: null, exportPfad: null,
    erstelltAm: '2026-09-24T02:39:01.929Z', geaendertAm: '2026-09-24T02:39:01.929Z', veroeffentlichtAm: '2026-09-24T02:39:01.963Z', archiviertAm: null,
    autor: 'Till Heidrich', geaendertVon: 'Till Heidrich', revision: 3, breadcrumb: null,
    ...teil,
  };
}

/** Kleines synthetisches Bündel: zwei Sammlungen (eine privat), Querverweise, ein PDF-Anhang, ein Bild, ein Kommentar. */
export function beispielBuendel(): OutlineBuendel {
  return {
    art: 'api',
    basisUrl: 'https://wiki.example.de',
    sammlungen: [
      { id: 's-marke', urlId: 'MarkeAbc01', url: null, name: 'Marke & Branding', beschreibung: null, permission: 'read_write', baum: [{ id: 'd-start', title: 'Start', url: '/doc/start-Start00001', children: [{ id: 'd-farbe', title: 'Farbe', url: '/doc/farbe-Farbe00001', children: [] }] }] },
      { id: 's-privat', urlId: 'PrivatX001', url: null, name: 'Strategie (privat)', beschreibung: null, permission: null, baum: [{ id: 'd-geheim', title: 'Geheim', url: '/doc/geheim-Geheim0001', children: [] }] },
    ],
    dokumente: [
      dok({ schluessel: 'Start00001', id: 'd-start', titel: 'Start', sammlungId: 's-marke', markdown: 'Einstieg. Die Farbe steht in [Farbe](https://wiki.example.de/doc/farbe-Farbe00001). Handbuch: [handbuch.pdf](https://wiki.example.de/api/attachments.redirect?id=a0000001-aaaa-4bbb-8ccc-000000000002)\n\n![Logo](https://wiki.example.de/api/attachments.redirect?id=a0000002-aaaa-4bbb-8ccc-000000000003)\n' }),
      dok({ schluessel: 'Farbe00001', id: 'd-farbe', titel: 'Farbe', sammlungId: 's-marke', elternId: 'Start00001', markdown: '## Markenfarbe\n\nDie Markenfarbe ist Kobalt #2055b3. Zurück zum [Start](/doc/start-Start00001).\n' }),
      dok({ schluessel: 'Geheim0001', id: 'd-geheim', titel: 'Geheim', sammlungId: 's-privat', markdown: 'Das Jahresziel für die Rücklage beträgt zwölftausend Euro.\n' }),
    ],
    anhaenge: [
      { id: 'a0000001-aaaa-4bbb-8ccc-000000000002', name: 'handbuch.pdf', contentType: 'application/pdf', groesse: null, exportPfad: null, dokumente: ['Start00001'], lade: async () => minimalPdf(['Das Markenhandbuch hat zwanzig Seiten.']) },
      { id: 'a0000002-aaaa-4bbb-8ccc-000000000003', name: 'Logo', contentType: null, groesse: null, exportPfad: null, dokumente: ['Start00001'], lade: null },
    ],
    kommentare: [{ id: 'k1', dokumentId: 'd-start', elternId: null, autor: 'Till Heidrich', erstelltAm: '2026-10-24T02:54:20.294Z', erledigtAm: null, text: 'Bitte das Logo prüfen.' }],
    warnungen: [],
  };
}
