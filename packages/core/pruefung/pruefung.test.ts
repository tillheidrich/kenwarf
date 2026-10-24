/**
 * Prüfsuite (Contract v1.2 F2): Treffer@5, Belegtreue, Enthaltung bei Fangfragen, Rechte-Lecks (muss 0 sein).
 * Läuft gegen den Seed mit dem Mock-Anbieter (deterministisch). Ergebnis: pruefung/ergebnis.json und pruefung/ergebnis.md.
 * Mit echtem Anbieter: KERN_PRUEFUNG_PROVIDER='{"art":"ollama","url":"http://localhost:11434","chatModell":"…","embedModell":"bge-m3"}'
 */
import { afterAll, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { Kern } from '../src/kern.js';
import { darfSehen } from '../src/rechte.js';
import type { ProviderConfig, User } from '../src/types.js';
import { aufraeumen, HEUTE, tmp } from '../test/helfer.js';
import { seedDemo } from '../src/seed/index.js';

interface Frage { id: string; frage: string; als: string; art: 'belegt' | 'fang' | 'regel' | 'rechte'; erwartet?: string[] }

afterAll(() => aufraeumen());

it('Prüfsuite gegen den Beispielbetrieb', async () => {
  const fragen = (YAML.parse(await readFile(new URL('./fragen.yaml', import.meta.url), 'utf8')) as { fragen: Frage[] }).fragen;
  const provider: ProviderConfig = process.env['KERN_PRUEFUNG_PROVIDER'] ? JSON.parse(process.env['KERN_PRUEFUNG_PROVIDER']) : { art: 'mock' };
  const dir = tmp('kern-pruefung-');
  await seedDemo(dir, { heute: HEUTE });
  const kern = await Kern.open({ dataDir: dir, provider, betrieb: 'Tischlerei Wendt GmbH (Beispiel)', sprache: 'de', heute: HEUTE });
  const nutzer: Record<string, User> = {};
  for (const u of await kern.benutzer.liste()) nutzer[u.name.split(' ')[0]!.toLowerCase().replace('ö', 'oe')] = u;
  const sichtbar = (u: User, pfad: string) => {
    const d = kern.ix.datei(pfad);
    return !!d && darfSehen(u, d.sichtbarkeit, d.besitzer);
  };

  const zeilen: { id: string; art: string; als: string; status: string; treffer5: boolean | null; belege: number; belegeKorrekt: number; lecks: number; ok: boolean }[] = [];
  let lecks = 0;
  for (const f of fragen) {
    const u = nutzer[f.als];
    if (!u) throw new Error(`Benutzer ${f.als} fehlt`);
    const treffer = await kern.suche(u, f.frage, { limit: 5 });
    const a = await kern.frage(u, f.frage);
    // Rechte-Lecks: jeder Treffer und jeder Beleg muss für den Fragenden sichtbar sein (Regel-Datei ist betrieb)
    const l = [...treffer.map((t) => t.pfad), ...a.belege.map((b) => b.quelle)].filter((p) => !sichtbar(u, p)).length;
    lecks += l;
    let treffer5: boolean | null = null;
    let korrekt = 0;
    for (const b of a.belege) if ((await kern.zitatStehtDrin(b)) && (!f.erwartet || f.erwartet.includes(b.quelle))) korrekt++;
    let ok = l === 0;
    if (f.art === 'belegt') {
      treffer5 = treffer.some((t) => f.erwartet!.includes(t.pfad));
      ok = ok && a.status === 'beantwortet' && a.belege.length > 0 && korrekt === a.belege.length;
    } else if (f.art === 'fang') ok = ok && a.status === 'steht_nicht_drin';
    else if (f.art === 'regel') ok = ok && a.status === 'gehoert_nicht_hierher';
    zeilen.push({ id: f.id, art: f.art, als: f.als, status: a.status, treffer5, belege: a.belege.length, belegeKorrekt: korrekt, lecks: l, ok });
  }
  await kern.schliesse();

  const belegt = zeilen.filter((z) => z.art === 'belegt');
  const fang = zeilen.filter((z) => z.art === 'fang' || z.art === 'regel');
  const alleBelege = belegt.reduce((n, z) => n + z.belege, 0);
  const ergebnis = {
    datum: HEUTE().toISOString().slice(0, 10),
    anbieter: provider.art,
    fragen: zeilen.length,
    treffer_at_5: belegt.filter((z) => z.treffer5).length / belegt.length,
    belegtreue: alleBelege ? belegt.reduce((n, z) => n + z.belegeKorrekt, 0) / alleBelege : 0,
    beantwortet_belegt: belegt.filter((z) => z.ok).length / belegt.length,
    enthaltung: fang.filter((z) => z.ok).length / fang.length,
    rechte_lecks: lecks,
    zeilen,
  };
  const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
  const md = [
    `# Prüfsuite @kern/core (${ergebnis.datum}, Anbieter ${ergebnis.anbieter})`,
    '',
    `| Messgröße | Wert | Ziel |`,
    `|---|---|---|`,
    `| Treffer@5 | ${pct(ergebnis.treffer_at_5)} | ≥ 80 % |`,
    `| Belegtreue (Zitat wörtlich und aus erwarteter Datei) | ${pct(ergebnis.belegtreue)} | ≥ 80 % (mock) |`,
    `| Belegte Antwort vollständig korrekt | ${pct(ergebnis.beantwortet_belegt)} | — |`,
    `| Enthaltung bei Fang- und Regelfragen | ${pct(ergebnis.enthaltung)} | 100 % |`,
    `| Rechte-Lecks | ${ergebnis.rechte_lecks} | 0 |`,
    '',
    '| Frage | Art | als | Status | Treffer@5 | Belege korrekt | Lecks | ok |',
    '|---|---|---|---|---|---|---|---|',
    ...zeilen.map((z) => `| ${z.id} | ${z.art} | ${z.als} | ${z.status} | ${z.treffer5 === null ? '–' : z.treffer5 ? 'ja' : 'nein'} | ${z.belegeKorrekt}/${z.belege} | ${z.lecks} | ${z.ok ? 'ja' : 'nein'} |`),
    '',
  ].join('\n');
  await writeFile(new URL('./ergebnis.json', import.meta.url), JSON.stringify(ergebnis, null, 2) + '\n');
  await writeFile(new URL('./ergebnis.md', import.meta.url), md);

  expect(ergebnis.rechte_lecks).toBe(0);
  expect(ergebnis.enthaltung).toBe(1);
  expect(ergebnis.treffer_at_5).toBeGreaterThanOrEqual(0.8);
  expect(ergebnis.belegtreue).toBeGreaterThanOrEqual(0.8);
}, 120_000);
