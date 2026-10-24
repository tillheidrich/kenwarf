import { afterAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { docxZuMarkdown, pdfZuMarkdown } from '../src/ingest.js';
import { pruefeZip } from '../src/parser.js';
import { aufraeumen, benutzerSatz, minimalPdf, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

async function docx(text: string, extra: Record<string, string | Uint8Array> = {}): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for (const [k, v] of Object.entries(extra)) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

describe('S1 M8: Parser im Worker mit Grenzen', () => {
  it('normale PDF und DOCX werden gelesen', async () => {
    expect((await pdfZuMarkdown(minimalPdf(['Hallo Welt']))).text).toContain('Hallo Welt');
    expect((await docxZuMarkdown(await docx('Leimzeiten 20 Minuten'))).text).toContain('Leimzeiten 20 Minuten');
  });

  it('Zip-Bombe und zu große DOCX werden vor dem Entpacken abgelehnt', async () => {
    const bombe = await docx('x', { 'word/media/null.bin': new Uint8Array(150 * 1024 * 1024) });
    expect(bombe.length).toBeLessThan(1024 * 1024);
    expect(() => pruefeZip(bombe)).toThrow(expect.objectContaining({ grund: 'entpackgrenze' }));
    await expect(docxZuMarkdown(bombe)).rejects.toMatchObject({ grund: 'entpackgrenze' });
    await expect(docxZuMarkdown(await docx('x'), { maxBytes: 100 })).rejects.toMatchObject({ grund: 'zu_gross' });
    await expect(docxZuMarkdown(Buffer.from('kein zip'))).rejects.toMatchObject({ grund: 'kaputt' });
  });

  it('PDF: Seitengrenze und Zeitlimit', async () => {
    await expect(pdfZuMarkdown(minimalPdf(['a']), { maxSeiten: 0 })).rejects.toMatchObject({ grund: 'zu_viele_seiten' });
    await expect(pdfZuMarkdown(minimalPdf(['a']), { zeitMs: 1 })).rejects.toMatchObject({ grund: 'zeit' });
  });

  it('fuegeHinzu lehnt sauber ab (KernFehler ungueltig)', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const d = join(tmp('bombe-'), 'bombe.docx');
    await writeFile(d, await docx('x', { 'word/media/null.bin': new Uint8Array(150 * 1024 * 1024) }));
    await expect(kern.fuegeHinzu(b.autor, { art: 'datei', dateiPfad: d, sammlung: 'x', sichtbarkeit: 'betrieb', kompilieren: false })).rejects.toMatchObject({ code: 'ungueltig', grund: 'entpackgrenze' });
    await kern.schliesse();
  });
});
