import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { artikel, aufraeumen, seedKern } from './helfer.js';

let kern: Kern;
let u: Record<string, User>;
let dir: string;
beforeAll(async () => {
  ({ kern, u, dir } = await seedKern());
  // Widerspruch: zweiter gültiger Fakt mit anderem Wert
  await writeFile(join(dir, 'wissen/betrieb/zahlungsziel-alt.md'), artikel('Zahlungsziel (alt)', 'Siehe [Start](/wissen/betrieb/start-hier.md).', {
    gruppe: 'betrieb', besitzer: 'joern-wendt',
    fundstellen: [{ id: 'f1', quelle: 'quellen/2026/preisblatt-und-fristen-2026.md', abschnitt: 'Zahlungsziel', zeilen: [27, 27] }, { id: 'f2', quelle: 'quellen/2026/gibt-es-nicht.md', abschnitt: 'X', zeilen: [1, 2] }],
    fakten: [{ id: 'zz', art: 'frist', gegenstand: 'Zahlungsziel Schlussrechnung', wert: 30, einheit: 'Tage', fundstelle: 'f1' }],
  }));
  await writeFile(join(dir, 'wissen/betrieb/riesig.md'), artikel('Riesig', 'Langer Text. '.repeat(900)));
  await kern.uebernimmAenderungen();
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

describe('pruefe (Lint)', () => {
  it('findet Widerspruch, abgelaufene Fakten, kaputte Fundstellen, zu große und verwaiste Artikel; legt Vorschläge an', async () => {
    await expect(kern.pruefe(u.lena!)).rejects.toMatchObject({ code: 'keine_rechte' });
    const b = await kern.pruefe(u['jörn']!);
    const arten = (a: string) => b.filter((x) => x.art === a);
    expect(arten('widerspruch')[0]?.text).toMatch(/Zahlungsziel Schlussrechnung.*14 Tage.*30 Tage/);
    expect(arten('fakt_abgelaufen')[0]?.pfad).toBe('wissen/betrieb/zahlen-und-fristen.md');
    expect(arten('fakt_abgelaufen')[0]?.vorschlag).toBeDefined();
    expect(arten('fakt_laeuft_ab')[0]?.text).toContain('Rabatt Beschlagversand Hanse');
    expect(arten('fundstelle_kaputt')[0]).toMatchObject({ pfad: 'wissen/betrieb/zahlungsziel-alt.md' });
    expect(arten('fundstelle_kaputt')[0]?.vorschlag).toBeDefined();
    expect(arten('zu_gross').map((x) => x.pfad)).toContain('wissen/betrieb/riesig.md');
    expect(arten('verwaist').map((x) => x.pfad)).toContain('wissen/betrieb/riesig.md');
    expect(arten('pruefung_faellig').length).toBeGreaterThanOrEqual(1);
    const eingang = await kern.eingang(u['jörn']!, { alle: true }); // v1.3 R5: ohne alle höchstens 3
    expect(eingang.some((v) => v.grund.startsWith('Aufräumen: kaputte Fundstellen entfernen'))).toBe(true);
    // zweiter Lauf legt keine doppelten Vorschläge an
    const vorher = eingang.length;
    await kern.pruefe(u['jörn']!);
    expect((await kern.eingang(u['jörn']!, { alle: true })).length).toBe(vorher);
  });
});
