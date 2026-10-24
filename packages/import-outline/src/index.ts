/**
 * @kern/import-outline: Import-Art `outline` für Kern.
 * Leser: Outline-Export (Markdown-, OKF-, JSON-ZIP oder entpackter Ordner), Outline-API (Token aus OUTLINE_API_TOKEN),
 * MCP-Abzug (Ordner aus Outline-MCP-Abrufen). Alles landet über die öffentliche Schnittstelle von @kern/core
 * als Quellen plus Vorschläge im Eingang, nie direkt im Wissen.
 */
export type { OutlineBuendel, OutlineDokument, OutlineSammlung, OutlineAnhang, OutlineKommentar, OutlineKnoten, BuendelArt } from './typen.js';
export { urlIdAusPfad } from './typen.js';
export { leseExport } from './lesen/export-zip.js';
export { leseApi, type ApiOptionen } from './lesen/api.js';
export { leseMcpAbzug } from './lesen/mcp-abzug.js';
export { prosemirrorZuMarkdown, type PmKnoten } from './prosemirror.js';
export { schreibeLinksUm, sammleAnhangVerweise, type LinkKontext, type LinkErgebnis } from './links.js';
export { importiereOutline, berichtAlsMarkdown, type ImportOptionen, type ImportBericht, type DokumentBericht } from './importieren.js';
export { bestandsaufnahme, type Bestand } from './bestand.js';
export { lese, type LeseOptionen } from './lese.js';
