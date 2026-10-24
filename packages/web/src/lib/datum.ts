// Datumsangaben im Vertrag sind YYYY-MM-DD (oder ISO mit Zeit). Anzeige immer deutsch.

export function heuteIso(jetzt = new Date()): string {
  const y = jetzt.getFullYear();
  const m = String(jetzt.getMonth() + 1).padStart(2, '0');
  const d = String(jetzt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function teile(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? [+m[1], +m[2], +m[3]] : null;
}

export function datum(iso: string | null | undefined): string {
  if (!iso) return 'ohne Datum';
  const t = teile(iso);
  if (!t) return iso;
  return `${String(t[2]).padStart(2, '0')}.${String(t[1]).padStart(2, '0')}.${t[0]}`;
}

const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

export function datumLang(iso: string): string {
  const t = teile(iso);
  if (!t) return iso;
  const d = new Date(Date.UTC(t[0], t[1] - 1, t[2]));
  return `${WOCHENTAGE[d.getUTCDay()]}, ${datum(iso)}`;
}

export function tageZwischen(von: string, bis: string): number {
  const a = teile(von);
  const b = teile(bis);
  if (!a || !b) return NaN;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

export type AmpelStufe = 'aktuell' | 'bald' | 'ueberfaellig' | 'ohne';

export interface Ampel {
  stufe: AmpelStufe;
  wort: string;
  erklaerung: string;
}

/** Prüftermin-Ampel. „Bald“ heißt: in den nächsten 30 Tagen fällig. */
export function ampel(pruefenBis: string | null | undefined, heute = heuteIso()): Ampel {
  if (!pruefenBis) return { stufe: 'ohne', wort: 'Kein Prüftermin', erklaerung: 'Für diesen Artikel ist kein Prüftermin gesetzt.' };
  const tage = tageZwischen(heute, pruefenBis);
  if (Number.isNaN(tage)) return { stufe: 'ohne', wort: 'Kein Prüftermin', erklaerung: '' };
  if (tage < 0) {
    const n = -tage;
    return {
      stufe: 'ueberfaellig',
      wort: 'Überfällig',
      erklaerung: `Prüftermin war am ${datum(pruefenBis)}, seit ${n} ${n === 1 ? 'Tag' : 'Tagen'} überschritten.`,
    };
  }
  if (tage <= 30)
    return {
      stufe: 'bald',
      wort: 'Bald prüfen',
      erklaerung: tage === 0 ? 'Heute prüfen.' : `Prüfen bis ${datum(pruefenBis)}, noch ${tage} ${tage === 1 ? 'Tag' : 'Tage'}.`,
    };
  return { stufe: 'aktuell', wort: 'Aktuell', erklaerung: `Nächste Prüfung bis ${datum(pruefenBis)}.` };
}

export function relativ(iso: string, heute = heuteIso()): string {
  const t = tageZwischen(iso, heute);
  if (Number.isNaN(t)) return iso;
  if (t === 0) return 'heute';
  if (t === 1) return 'gestern';
  if (t > 1 && t < 14) return `vor ${t} Tagen`;
  return `am ${datum(iso)}`;
}

/** Gültigkeit eines Fakts (v1.1). Ampel nur, wenn gilt_bis gesetzt ist. */
export function gueltigkeit(giltBis: string | null | undefined, heute = heuteIso()): Ampel {
  if (!giltBis) return { stufe: 'ohne', wort: 'Unbefristet', erklaerung: 'Gilt ohne Enddatum.' };
  const tage = tageZwischen(heute, giltBis);
  if (tage < 0) return { stufe: 'ueberfaellig', wort: 'Abgelaufen', erklaerung: `Galt bis ${datum(giltBis)}.` };
  if (tage <= 30)
    return { stufe: 'bald', wort: 'Läuft bald ab', erklaerung: `Gilt noch bis ${datum(giltBis)} (${tage} ${tage === 1 ? 'Tag' : 'Tage'}).` };
  return { stufe: 'aktuell', wort: 'Gültig', erklaerung: `Gilt bis ${datum(giltBis)}.` };
}
