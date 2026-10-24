import { posix } from 'node:path';
import type { ArtikelFundstelle, ArtikelKopf, FaktEintrag, QuellenKopf } from './types.js';
import { artikelKopfSchema, faktSchema, quellenKopfSchema } from './types.js';

const istDatum = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : d);

function zodText(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return e.issues.map((i) => `${i.path.map(String).join('.') || 'kopf'}: ${i.message}`).join('; ');
}

/** Fundstellen vereinheitlichen und fehlende ids (`f1`, `f2` …) vergeben. */
export function normalisiereFundstellen(roh: unknown): ArtikelFundstelle[] {
  if (!Array.isArray(roh)) return [];
  const vergeben = new Set<string>();
  const out: ArtikelFundstelle[] = [];
  for (const f of roh) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const z = Array.isArray(o['zeilen']) ? (o['zeilen'] as unknown[]).map(Number) : [1, 1];
    let id = str(o['id']);
    if (!id || vergeben.has(id)) {
      let n = out.length + 1;
      while (vergeben.has(`f${n}`)) n++;
      id = `f${n}`;
    }
    vergeben.add(id);
    out.push({ id, quelle: str(o['quelle']), abschnitt: str(o['abschnitt']), zeilen: [z[0] || 1, z[1] || z[0] || 1] });
  }
  return out;
}

export function normalisiereFakten(roh: unknown): { fakten: FaktEintrag[]; fehler: string[] } {
  if (roh == null) return { fakten: [], fehler: [] };
  if (!Array.isArray(roh)) return { fakten: [], fehler: ['fakten: muss eine Liste sein'] };
  const fakten: FaktEintrag[] = [];
  const fehler: string[] = [];
  roh.forEach((f, i) => {
    const r = faktSchema.safeParse(f);
    if (r.success) fakten.push(r.data as FaktEintrag);
    else fehler.push(`fakten.${i}: ${zodText(r.error)}`);
  });
  return { fakten, fehler };
}

/**
 * Artikelkopf tolerant lesen (auch von Hand oder in Obsidian geschriebene Dateien):
 * fehlende Felder bekommen Standardwerte, Fehler werden gemeldet, nicht geworfen.
 */
export function normalisiereArtikelKopf(
  roh: Record<string, unknown>,
  pfad: string,
  std: { besitzer: string; heute: string; sichtbarkeit?: string },
): { kopf: ArtikelKopf; fehler: string | null } {
  const teile = pfad.split('/');
  const gruppe = str(roh['gruppe']) || (teile.length > 2 ? teile[1]! : 'allgemein');
  const fakt = normalisiereFakten(roh['fakten']);
  const kopf: ArtikelKopf = {
    ...roh,
    type: str(roh['type']) || 'Artikel',
    titel: str(roh['titel']) || str(roh['title']) || posix.basename(pfad, '.md'),
    gruppe,
    kurzfassung: str(roh['kurzfassung']) || str(roh['description']),
    stand: istDatum(roh['stand']) ? roh['stand'] : std.heute,
    verantwortlich: str(roh['verantwortlich']),
    pruefen_bis: istDatum(roh['pruefen_bis']) ? roh['pruefen_bis'] : null,
    sichtbarkeit: (str(roh['sichtbarkeit']) || std.sichtbarkeit || 'betrieb') as ArtikelKopf['sichtbarkeit'],
    besitzer: str(roh['besitzer']) || std.besitzer,
    fundstellen: normalisiereFundstellen(roh['fundstellen']),
    status: (['entwurf', 'freigegeben', 'veraltet'].includes(str(roh['status'])) ? str(roh['status']) : 'freigegeben') as ArtikelKopf['status'],
  };
  if (roh['fakten'] !== undefined) kopf.fakten = fakt.fakten;
  const r = artikelKopfSchema.safeParse(kopf);
  const fehler = [...(r.success ? [] : [zodText(r.error)]), ...fakt.fehler];
  // Felder, die im Rohkopf fehlten, als Hinweis melden (nicht als Fehler, wenn Standard sinnvoll)
  if (roh['pruefen_bis'] !== undefined && roh['pruefen_bis'] !== null && !istDatum(roh['pruefen_bis'])) fehler.push('pruefen_bis: Datum im Format JJJJ-MM-TT');
  if (roh['stand'] !== undefined && !istDatum(roh['stand'])) fehler.push('stand: Datum im Format JJJJ-MM-TT');
  return { kopf, fehler: fehler.length ? fehler.join('; ') : null };
}

export function normalisiereQuellenKopf(roh: Record<string, unknown>, pfad: string, std: { besitzer: string; heute: string }): { kopf: QuellenKopf; fehler: string | null } {
  const art = str(roh['art']);
  const kopf: QuellenKopf = {
    ...roh,
    type: 'Quelle',
    titel: str(roh['titel']) || str(roh['title']) || posix.basename(pfad, '.md'),
    art: (['datei', 'text', 'web', 'audio', 'notiz'].includes(art) ? art : 'datei') as QuellenKopf['art'],
    herkunft: str(roh['herkunft']),
    erfasst_am: str(roh['erfasst_am']) || std.heute,
    erfasst_von: str(roh['erfasst_von']) || std.besitzer,
    sichtbarkeit: (str(roh['sichtbarkeit']) || 'betrieb') as QuellenKopf['sichtbarkeit'],
    sammlung: str(roh['sammlung']) || 'allgemein',
    hash: str(roh['hash']),
    ersetzt: str(roh['ersetzt']) || null,
    beobachtet: roh['beobachtet'] === true,
  };
  const r = quellenKopfSchema.safeParse(kopf);
  return { kopf, fehler: r.success ? null : zodText(r.error) };
}

/** Feldreihenfolge beim Schreiben: Pflichtfelder vorn, unbekannte Felder bleiben erhalten (OKF). */
export function ordneArtikelKopf(k: ArtikelKopf): Record<string, unknown> {
  const reihenfolge = ['type', 'titel', 'gruppe', 'kurzfassung', 'stand', 'verantwortlich', 'pruefen_bis', 'sichtbarkeit', 'besitzer', 'status', 'generated', 'verified', 'fundstellen', 'fakten'];
  const out: Record<string, unknown> = {};
  for (const f of reihenfolge) if (k[f] !== undefined) out[f] = k[f];
  for (const [f, v] of Object.entries(k)) if (!(f in out) && v !== undefined) out[f] = v;
  return out;
}

export function ordneQuellenKopf(k: QuellenKopf): Record<string, unknown> {
  const reihenfolge = ['type', 'titel', 'art', 'herkunft', 'erfasst_am', 'erfasst_von', 'sichtbarkeit', 'sammlung', 'hash', 'ersetzt', 'beobachtet'];
  const out: Record<string, unknown> = {};
  for (const f of reihenfolge) if (k[f] !== undefined) out[f] = k[f];
  for (const [f, v] of Object.entries(k)) if (!(f in out) && v !== undefined) out[f] = v;
  return out;
}
