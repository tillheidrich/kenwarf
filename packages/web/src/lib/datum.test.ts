import { describe, expect, it } from 'vitest';
import { ampel, datum, datumLang, gueltigkeit, relativ, tageZwischen } from './datum';

describe('datum', () => {
  it('formatiert deutsch', () => {
    expect(datum('2026-10-24')).toBe('24.10.2026');
    expect(datum(null)).toBe('ohne Datum');
    expect(datumLang('2026-10-24')).toBe('Samstag, 24.10.2026');
  });
  it('rechnet Tage', () => {
    expect(tageZwischen('2026-10-24', '2026-11-23')).toBe(30);
    expect(relativ('2026-10-23', '2026-10-24')).toBe('gestern');
  });
  it('setzt die Prüftermin-Ampel mit Wort', () => {
    expect(ampel('2026-10-15', '2026-10-24')).toMatchObject({ stufe: 'ueberfaellig', wort: 'Überfällig' });
    expect(ampel('2026-11-12', '2026-10-24')).toMatchObject({ stufe: 'bald', wort: 'Bald prüfen' });
    expect(ampel('2027-10-14', '2026-10-24')).toMatchObject({ stufe: 'aktuell', wort: 'Aktuell' });
    expect(ampel(null, '2026-10-24')).toMatchObject({ stufe: 'ohne' });
  });
  it('bewertet die Gültigkeit von Fakten', () => {
    expect(gueltigkeit('2026-11-05', '2026-10-24').wort).toBe('Läuft bald ab');
    expect(gueltigkeit('2026-10-01', '2026-10-24').wort).toBe('Abgelaufen');
    expect(gueltigkeit(null).wort).toBe('Unbefristet');
  });
});
