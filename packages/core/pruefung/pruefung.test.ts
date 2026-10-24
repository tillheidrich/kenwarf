/**
 * Öffentliche Prüfbank (v1.4 8.1, vorher Prüfsuite v1.2 F2) als `npm run pruefung`. Läuft über `Kern.pruefbank` mit dem
 * Satz `oeffentlich` (Seed „Tischlerei Wendt“ plus pruefung/oeffentlich/), Ergebnis: pruefung/ergebnis.json und ergebnis.md.
 * Mit echtem Anbieter: KERN_PRUEFUNG_PROVIDER='{"art":"openai","url":"…","apiKey":"…","chatModell":"…","embedModell":"…"}'
 * (nur wenn ein Schlüssel vorhanden ist; ohne Variable läuft mock).
 */
import { afterAll, expect, it } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderConfig } from '../src/types.js';
import { aufraeumen, seedKern } from '../test/helfer.js';

afterAll(() => aufraeumen());

it('öffentliche Prüfbank gegen den Beispielbetrieb', async () => {
  const anbieter: ProviderConfig | undefined = process.env['KERN_PRUEFUNG_PROVIDER'] ? JSON.parse(process.env['KERN_PRUEFUNG_PROVIDER']) : undefined;
  const { kern, dir, u } = await seedKern();
  const l = await kern.pruefbank(u['jörn']!, { satz: 'oeffentlich', ...(anbieter ? { anbieter } : {}) });
  const md = await readFile(join(dir, l.datei!.replace(/\.json$/, '.md')), 'utf8');
  await kern.schliesse();
  await writeFile(new URL('./ergebnis.json', import.meta.url), JSON.stringify({ ...l, am: l.am.slice(0, 10), dauerSek: undefined, latenzMs: undefined, zeilen: l.zeilen.map((z) => ({ ...z, ms: undefined })) }, null, 2) + '\n');
  await writeFile(new URL('./ergebnis.md', import.meta.url), md.replace(/, \d+(\.\d+)? s, Latenz Median \d+ ms, p95 \d+ ms/, '').replace(/\| \d+ \| (ja|nein) \|/g, '| – | $1 |'));
  expect(l.kennzahlen.lecks).toBe(0);
  if (!anbieter) {
    expect(l.bestanden).toBe(true);
    expect(l.kennzahlen.enthaltung).toBe(1);
  }
}, 120_000);
