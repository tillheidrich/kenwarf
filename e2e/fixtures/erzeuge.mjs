// Erzeugt die kleinen Prüfdateien für Rauchtest und Stoppuhr: eine PDF (von Hand, ohne Bibliothek) und eine DOCX
// (über jszip aus den Repo-Abhängigkeiten). Aufruf aus dem Repo-Wurzelordner: node e2e/fixtures/erzeuge.mjs
// Inhalte sind erfunden (Tischlerei Wendt, wie im Beispielbetrieb), keine echten Daten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const hier = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(hier, '..', '..', 'package.json'));

// ---------- PDF 1.4, eine Seite, Helvetica, nur ASCII ----------
function pdf(zeilen) {
  const text = zeilen.map((z, i) => `BT /F1 12 Tf 56 ${780 - i * 18} Td (${z.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
  const objekte = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let aus = '%PDF-1.4\n';
  const versatz = [];
  objekte.forEach((o, i) => { versatz.push(Buffer.byteLength(aus)); aus += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(aus);
  aus += `xref\n0 ${objekte.length + 1}\n0000000000 65535 f \n` + versatz.map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join('');
  aus += `trailer\n<< /Size ${objekte.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(aus, 'latin1');
}

fs.writeFileSync(path.join(hier, 'lieferzeiten.pdf'), pdf([
  'Lieferzeiten Tischlerei Wendt',
  'Beschlaege von Hettich haben eine Lieferzeit von zehn Werktagen.',
  'Eichenplatten in Sondermass werden in drei Wochen geliefert.',
  'Eilauftraege nimmt nur die Werkstattleitung an.',
]));

// ---------- DOCX ----------
const JSZip = require('jszip');
const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
const absatz = (t, stil) => `<w:p>${stil ? `<w:pPr><w:pStyle w:val="${stil}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
  absatz('Urlaub und Abwesenheit', 'Heading1'),
  absatz('Urlaubsanträge müssen spätestens zwei Wochen vor Beginn im Büro eingereicht werden.'),
  absatz('Über Brückentage entscheidet die Geschäftsführung bis Ende Januar.'),
].join('')}</w:body></w:document>`);
fs.writeFileSync(path.join(hier, 'urlaub.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('geschrieben: lieferzeiten.pdf, urlaub.docx');
