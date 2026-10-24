import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { leseApi, type ApiOptionen } from './lesen/api.js';
import { leseExport } from './lesen/export-zip.js';
import { leseMcpAbzug } from './lesen/mcp-abzug.js';
import type { OutlineBuendel } from './typen.js';

export interface LeseOptionen extends ApiOptionen {
  /** Pfad zu Export-ZIP, entpacktem Export oder MCP-Abzug. Ohne Pfad: API. */
  pfad?: string;
}

/** Erkennt die Eingabe: MCP-Abzug (Ordner mit sammlungen.json), Export (ZIP oder Ordner) oder API. */
export async function lese(opt: LeseOptionen): Promise<OutlineBuendel> {
  if (!opt.pfad) return leseApi(opt);
  if (statSync(opt.pfad).isDirectory() && existsSync(join(opt.pfad, 'sammlungen.json')) && existsSync(join(opt.pfad, 'dokumente'))) return leseMcpAbzug(opt.pfad);
  return leseExport(opt.pfad, { basisUrl: opt.basisUrl ?? process.env['OUTLINE_URL'] ?? null });
}
