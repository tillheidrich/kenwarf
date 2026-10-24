/**
 * Abrechnungsregeln als reine Funktionen (G1 P-9, P-10, W-3 bis W-5, Z-2; CONTRACT v1.4 3.5, 3.9).
 *  - Wechsel nach oben (mehr Preis): sofort; Differenz für den Rest des laufenden Zeitraums tagesgenau als Einzelzahlung
 *    über das bestehende Mandat. Nach v1.4 3.5 erst nach bestätigter Zahlung umstellen; scheitert der Wechsel,
 *    wird erstattet (W-2: „nichts wird berechnet“).
 *  - Wechsel nach unten: neuer Betrag ab dem nächsten Zeitraum, keine Erstattung im Monatsvertrag. Bei Jahresvertrag
 *    entsteht ein Guthaben für die Restmonate (W-5); das führt der Leitstand nur als Zahl, ausgezahlt wird es bei
 *    Kündigung (E-6). Stufenwechsel selbst kostet nichts (Data Act, 3.9).
 */
export type Intervall = 'monat' | 'jahr';
export const MOLLIE_INTERVALL: Record<Intervall, '1 month' | '12 months'> = { monat: '1 month', jahr: '12 months' };
/** G1 P-3: jährlich mit zwei Monaten Nachlass. */
export const betragFuer = (monatCent: number, i: Intervall) => (i === 'jahr' ? monatCent * 10 : monatCent);

const TAG = 86_400_000;
const tag = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

/** Nächster Abbuchungstag nach `startTag` (YYYY-MM-DD) bei Monats- oder Jahresintervall; Monatsende wie Mollie (31. → letzter Tag). */
export function naechsterTermin(startTag: string, i: Intervall): string {
  const j = Number(startTag.slice(0, 4)), m = Number(startTag.slice(5, 7)) - 1, t = Number(startTag.slice(8, 10));
  const zj = i === 'jahr' ? j + 1 : j + Math.floor((m + 1) / 12), zm = i === 'jahr' ? m : (m + 1) % 12;
  const letzter = new Date(Date.UTC(zj, zm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(zj, zm, Math.min(t, letzter))).toISOString().slice(0, 10);
}

/**
 * Tagesgenaue Differenz für den Rest des laufenden Zeitraums [beginn, ende): (neu − alt) × Resttage / Tage des Zeitraums.
 * Ergebnis in Cent, kaufmännisch gerundet; negativ = Guthaben. `heute` zählt als erster Resttag.
 */
export function anteilig(e: { alt_cent: number; neu_cent: number; beginn: string; ende: string; heute: string }): { cent: number; resttage: number; tage: number } {
  const tage = Math.round((tag(e.ende) - tag(e.beginn)) / TAG);
  if (tage <= 0) throw new Error('Zeitraum ungültig');
  const rest = Math.max(0, Math.min(tage, Math.round((tag(e.ende) - tag(e.heute)) / TAG)));
  return { cent: Math.round(((e.neu_cent - e.alt_cent) * rest) / tage), resttage: rest, tage };
}

/** Wann eine Vorankündigung fällig ist (Z-2: spätestens 3 Tage vorher). */
export function vorankuendigungFaellig(naechste: string | null, heute: string, vorlauf = 3): boolean {
  if (!naechste) return false;
  const d = Math.round((tag(naechste) - tag(heute)) / TAG);
  return d >= 0 && d <= vorlauf;
}

export const euro = (cent: number) => `${(cent / 100).toFixed(2).replace('.', ',')} €`;
