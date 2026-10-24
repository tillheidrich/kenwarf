import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import JSZip from 'jszip';
import { simpleGit } from 'simple-git';
import { Kern } from '../src/kern.js';
import { DEMO_PASSWORT, seedDemo } from '../src/seed/index.js';
import type { KernConfig, Provider, User } from '../src/types.js';

/** Testserver laufen auf 127.0.0.1 mit zufälligem Port; kein Proxy aus der Sandbox-Umgebung. */
export const TEST_NETZ = { erlaubeAdressen: ['127.0.0.1'], erlaubtePorts: 'alle' as const, proxy: null };
export const HEUTE = () => new Date('2026-10-24T10:00:00Z');
const ordner: string[] = [];

export function tmp(name = 'kern-test-'): string {
  const d = mkdtempSync(join(tmpdir(), name));
  ordner.push(d);
  return d;
}

export function aufraeumen(): void {
  for (const d of ordner.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function oeffne(dataDir = tmp(), extra: Partial<KernConfig> & { providerInstanz?: Provider } = {}): Promise<Kern> {
  return Kern.open({ dataDir, provider: { art: 'mock' }, betrieb: 'Testbetrieb', sprache: 'de', heute: HEUTE, netz: TEST_NETZ, ...extra });
}

/** Seed einmal anlegen und Kern öffnen; gibt Kern und Benutzer nach Vorname zurück. */
export async function seedKern(extra: Partial<KernConfig> & { providerInstanz?: Provider } = {}): Promise<{ kern: Kern; dir: string; u: Record<string, User> }> {
  const dir = tmp('kern-seed-');
  await seedDemo(dir, { heute: HEUTE, passwort: DEMO_PASSWORT });
  const kern = await oeffne(dir, extra);
  const u: Record<string, User> = {};
  for (const b of await kern.benutzer.liste()) u[b.name.split(' ')[0]!.toLowerCase()] = b;
  return { kern, dir, u };
}

export async function gitLog(dir: string, pfad?: string): Promise<{ autor: string; nachricht: string; text: string }[]> {
  const raw = await simpleGit(dir).raw(['log', '--format=%an%x1f%s%x1f%b%x1e', ...(pfad ? ['--', pfad] : [])]);
  return raw
    .split('\x1e')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [autor, nachricht, text] = x.split('\x1f');
      return { autor: autor ?? '', nachricht: nachricht ?? '', text: text ?? '' };
    });
}

/** Minimales gültiges PDF mit zwei Textzeilen. */
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
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objekte.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Minimale DOCX-Datei mit Überschrift und Absätzen. */
export async function minimalDocx(ueberschrift: string, absaetze: string[]): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  z.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  const p = (t: string, stil?: string) => `<w:p>${stil ? `<w:pPr><w:pStyle w:val="${stil}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p(ueberschrift, 'Heading1')}${absaetze.map((a) => p(a)).join('')}</w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

/** Kleiner HTTP-Server für Web-/Provider-Tests. */
export async function testServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ url: string; schliessen: () => Promise<void> }> {
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const adr = s.address() as { port: number };
  return { url: `http://127.0.0.1:${adr.port}`, schliessen: () => new Promise((r) => s.close(() => r())) };
}

export async function warteBis(bedingung: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const ende = Date.now() + ms;
  while (Date.now() < ende) {
    if (await bedingung()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Zeitüberschreitung beim Warten');
}

export async function benutzerSatz(kern: Kern): Promise<Record<'admin' | 'frei' | 'autor' | 'leser' | 'werk', User>> {
  return {
    admin: await kern.benutzer.anlegen('Ada Admin', 'passwort-1', ['admin'], ['buero']),
    frei: await kern.benutzer.anlegen('Fritz Frei', 'passwort-1', ['freigeber'], ['buero']),
    autor: await kern.benutzer.anlegen('Anna Autor', 'passwort-1', ['autor'], ['werkstatt']),
    leser: await kern.benutzer.anlegen('Leo Leser', 'passwort-1', ['leser'], []),
    werk: await kern.benutzer.anlegen('Wera Werk', 'passwort-1', ['leser'], ['werkstatt']),
  };
}

/** Artikeltext mit vollständigem Kopf. */
export function artikel(titel: string, text: string, kopf: Record<string, unknown> = {}): string {
  const k = {
    type: 'Artikel', titel, gruppe: 'test', kurzfassung: `${titel}.`, stand: '2026-10-01', verantwortlich: 'Test', pruefen_bis: null,
    sichtbarkeit: 'betrieb', besitzer: 'ada-admin', fundstellen: [], status: 'freigegeben', ...kopf,
  };
  const yaml = Object.entries(k).map(([a, b]) => `${a}: ${JSON.stringify(b)}`).join('\n');
  return `---\n${yaml}\n---\n\n${text}\n`;
}
