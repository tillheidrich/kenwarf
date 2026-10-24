import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/provider.js';
import { aufraeumen, seedKern } from './helfer.js';

afterAll(() => aufraeumen());

class EchtWieMock extends MockProvider { override name = 'test-ki'; }

describe('v1.4 8.1/8.2 Prüfbank: Satz betrieb, Prüffragen, Modellwechsel-Schranke', () => {
  it('ohne eigene Prüffragen: Fragen aus Artikeltiteln; mit gespeicherter Prüffrage nur diese', async () => {
    const { kern, dir, u } = await seedKern();
    const admin = u['jörn']!;
    const s = await kern.pruefbankSchaetzung(admin, { satz: 'betrieb' });
    expect(s.fragen).toBeGreaterThan(5);
    expect(s.cent).toBe(0);
    const auto = await kern.pruefbank(admin, { satz: 'betrieb', speichern: false });
    expect(auto.auto).toBe(true);
    expect(auto.kennzahlen.lecks).toBe(0);
    expect(auto.ohneFragen).toContain('injektionsfest');
    expect(auto.bestanden).toBe(false);
    expect(auto.warnung).toMatch(/öffentlichen Satz/);
    await expect(kern.speicherePrueffrage(u['kai']!, { frage: 'x', art: 'belegt' })).rejects.toThrow();
    const { id } = await kern.speicherePrueffrage(u['sabine']!, { frage: 'Wer nimmt Reklamationen auf?', art: 'belegt', erwartet: ['wissen/ablaeufe/reklamation.md', 'wissen/betrieb/wer-macht-was.md', 'quellen/2026/preisblatt-und-fristen-2026.md', 'wissen/betrieb/zahlen-und-fristen.md'] });
    const y = YAML.parse(readFileSync(join(dir, 'pruefung', 'fragen.yaml'), 'utf8')) as { fragen: { id: string; als: string }[] };
    expect(y.fragen.map((f) => f.id)).toEqual([id]);
    const eigen = await kern.pruefbank(admin, { satz: 'betrieb' });
    expect(eigen).toMatchObject({ auto: false, fragen: 1 });
    expect(eigen.zeilen[0]).toMatchObject({ id, ok: true });
    await kern.schliesse();
  });

  it('statusSetzen schreibt ki.status (geprueft) für die aktive KI; Bilanz zeigt den Lauf', async () => {
    const { kern, u } = await seedKern({ providerInstanz: new EchtWieMock() });
    const admin = u['jörn']!;
    await kern.speichereEinstellungen(admin, { ki: { art: 'openai', status: 'ungeprueft' } });
    expect(await kern.kiStatus()).toBe('ungeprueft');
    const l = await kern.pruefbank(admin, { satz: 'oeffentlich', statusSetzen: true });
    expect(l.anbieter).toBe('test-ki');
    expect(l.kostenCent).toBeNull();
    expect(await kern.kiStatus()).toBe(l.bestanden ? 'geprueft' : 'unter_schwelle');
    const b = await kern.kontextbilanz(admin);
    expect(b.pruefbank).toMatchObject({ letzterLauf: l.am, anbieter: 'test-ki', lecks: 0, kiStatus: 'geprueft' });
    await kern.schliesse();
  });
});
