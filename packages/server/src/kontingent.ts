import type { KernLike } from './types.js';
import type { Grenzwerte } from './betrieb.js';
import { KernFehler } from './fehler.js';

/**
 * v1.4 3.4 (G1 P-5, P-6): KI-Kontingent und Speicher.
 * Ohne Dark Patterns: kein Countdown, kein Nachkauf, kein Rabatt. Ab 80 % ein sachlicher Hinweis, ab 100 % KI aus
 * bis Monatsende (bzw. bis morgen beim Tagesdeckel); Suche, Wissen, Export laufen weiter.
 */
export interface Verbrauch { monat: string; cent_monat: number; cent_heute: number }

export interface KontingentStand {
  ki: { verbraucht_cent: number; kontingent_cent: number | null; tagesdeckel_cent: number | null; anteil: number | null; stufe: 'ok' | 'hinweis' | 'aufgebraucht'; text: string | null } | null;
  speicher: { belegt_bytes: number; max_bytes: number; anteil: number; stufe: 'ok' | 'hinweis' | 'voll'; text: string | null } | null;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
/** Erster Tag des Folgemonats als Text, z. B. „1. November“. */
export function naechsterMonat(monat: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monat);
  const i = m ? Number(m[2]) % 12 : (new Date().getMonth() + 1) % 12;
  return `1. ${MONATE[i]}`;
}

export async function leseVerbrauch(kern: KernLike): Promise<Verbrauch | null> {
  if (typeof kern.verbrauch !== 'function') return null;
  try { return await kern.verbrauch(); } catch { return null; }
}

/** Wirft 429 `kontingent` (grund `ki`), wenn Monatskontingent oder Tagesdeckel erreicht ist. */
export async function pruefeKiKontingent(kern: KernLike, g: Grenzwerte): Promise<void> {
  if (g.ki_kontingent_cent_monat === null && g.ki_tagesdeckel_cent === null) return;
  const v = await leseVerbrauch(kern);
  if (!v) return;
  if (g.ki_kontingent_cent_monat !== null && v.cent_monat >= g.ki_kontingent_cent_monat) {
    throw Object.assign(new KernFehler(429, `Das KI-Kontingent eures Pakets für diesen Monat ist aufgebraucht. Suche, Wissen und Export laufen weiter. Ab dem ${naechsterMonat(v.monat)} antwortet die KI wieder. Es wird nichts automatisch nachgekauft.`, 'kontingent'), { grund: 'ki' });
  }
  if (g.ki_tagesdeckel_cent !== null && v.cent_heute >= g.ki_tagesdeckel_cent) {
    throw Object.assign(new KernFehler(429, 'Das KI-Budget für heute ist aufgebraucht. Suche, Wissen und Export laufen weiter. Morgen antwortet die KI wieder.', 'kontingent'), { grund: 'ki_tag', retryAfter: sekundenBisMitternacht() });
  }
}

function sekundenBisMitternacht(): number {
  const j = new Date();
  const m = new Date(j); m.setHours(24, 0, 0, 0);
  return Math.max(60, Math.round((m.getTime() - j.getTime()) / 1000));
}

export async function kontingentStand(kern: KernLike, g: Grenzwerte, speicherBytes: () => number): Promise<KontingentStand> {
  let ki: KontingentStand['ki'] = null;
  if (g.ki_kontingent_cent_monat !== null || g.ki_tagesdeckel_cent !== null) {
    const v = await leseVerbrauch(kern);
    if (v) {
      const k = g.ki_kontingent_cent_monat;
      const anteil = k ? Math.min(1, v.cent_monat / k) : null;
      const auf = (k !== null && v.cent_monat >= k) || (g.ki_tagesdeckel_cent !== null && v.cent_heute >= g.ki_tagesdeckel_cent);
      const stufe = auf ? 'aufgebraucht' : anteil !== null && anteil >= 0.8 ? 'hinweis' : 'ok';
      ki = {
        verbraucht_cent: v.cent_monat, kontingent_cent: k, tagesdeckel_cent: g.ki_tagesdeckel_cent, anteil, stufe,
        text: stufe === 'aufgebraucht'
          ? `KI-Kontingent aufgebraucht. Suche, Wissen und Export laufen weiter. Die KI antwortet wieder ab dem ${naechsterMonat(v.monat)}.`
          : stufe === 'hinweis' ? `${Math.round((anteil ?? 0) * 100)} % des KI-Kontingents für diesen Monat sind verbraucht.` : null,
      };
    }
  }
  let speicher: KontingentStand['speicher'] = null;
  if (g.speicher_max_bytes !== null && g.speicher_max_bytes > 0) {
    const b = speicherBytes();
    const anteil = Math.min(1, b / g.speicher_max_bytes);
    const stufe = anteil >= 1 ? 'voll' : anteil >= 0.9 ? 'hinweis' : 'ok';
    speicher = { belegt_bytes: b, max_bytes: g.speicher_max_bytes, anteil, stufe,
      text: stufe === 'voll' ? 'Der Speicher eures Pakets ist voll. Neue Uploads gehen erst nach dem Aufräumen oder einem Stufenwechsel; alles andere läuft weiter.'
        : stufe === 'hinweis' ? `${Math.round(anteil * 100)} % des Speichers sind belegt.` : null };
  }
  return { ki, speicher };
}
