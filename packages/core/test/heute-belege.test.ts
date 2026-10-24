import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { aufraeumen, seedKern } from './helfer.js';

let kern: Kern;
let u: Record<string, User>;
beforeAll(async () => {
  ({ kern, u } = await seedKern());
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

describe('Heute: Belege von Vorschlägen zeigen auf die Quelle (BF2)', () => {
  it('Vorschlag mit Quelle: Beleg ist die Quelldatei, nie eingang/*.json', async () => {
    const offen = (await kern.eingang(u['jörn']!, { alle: true })).filter((v) => v.status === 'offen' && v.quelle);
    expect(offen.length).toBeGreaterThan(0);
    const h = await kern.heute(u['jörn']!);
    const belege = h.punkte.flatMap((p) => p.belege);
    expect(belege.length).toBeGreaterThan(0);
    for (const f of belege) expect(f.quelle.startsWith('eingang/')).toBe(false);
    const quellen = new Set(offen.map((v) => v.quelle));
    expect(belege.some((f) => quellen.has(f.quelle))).toBe(true);
    for (const f of belege) expect(await kern.zitatStehtDrin(f)).toBe(true);
  });

  it('Vorschlag ohne Quelle: Beleg ist klar als Eingangseintrag mit Titel benannt', async () => {
    const v = await kern.schlageVor(u['jörn']!, { art: 'neu', ziel: 'wissen/allgemein/bf2-ohne-quelle.md', alt: null, neu: '---\ntitle: Ohne Quelle\n---\n\nText ohne Quelle.\n', grund: 'Merkzettel ohne Quelle' } as never);
    const h = await kern.heute(u['jörn']!);
    const f = h.punkte.flatMap((p) => p.belege).find((b) => b.quelle === `eingang/${v.id}.json`);
    expect(f).toBeDefined();
    expect(f!.abschnitt).toBe('Eingangseintrag „Merkzettel ohne Quelle“');
  });
});
