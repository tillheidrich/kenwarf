import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { artikel, aufraeumen, benutzerSatz, oeffne, tmp } from './helfer.js';

let kern: Kern;
let b: Awaited<ReturnType<typeof benutzerSatz>>;

beforeAll(async () => {
  const dir = tmp();
  kern = await oeffne(dir);
  b = await benutzerSatz(kern);
  const lege = async (p: string, s: string) => {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), s);
  };
  await lege('wissen/test/offen.md', artikel('Hallenordnung', 'Die Hallentore schließen um 17 Uhr.'));
  await lege('wissen/test/team.md', artikel('Werkstatt-Zahlencode', 'Der Schrankcode Werkstatt lautet Hallentore Nordseite.', { sichtbarkeit: 'team:werkstatt', besitzer: 'jemand' }));
  await lege('wissen/test/privat.md', artikel('Annas Notiz', 'Hallentore privat: Anna denkt an den Schlüssel.', { sichtbarkeit: 'ich', besitzer: b.autor.id }));
  await kern.uebernimmAenderungen('Test', 'Testdaten');
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

const pfade = async (u: User) => (await kern.listeWissen(u)).map((a) => a.pfad).sort();

describe('Rechte ich / team / betrieb', () => {
  it('listeWissen filtert', async () => {
    expect(await pfade(b.leser)).toEqual(['wissen/test/offen.md']);
    expect(await pfade(b.werk)).toEqual(['wissen/test/offen.md', 'wissen/test/team.md']);
    expect(await pfade(b.autor)).toEqual(['wissen/test/offen.md', 'wissen/test/privat.md', 'wissen/test/team.md']);
    // admin sieht fremde private Notizen nicht, Teams nur als Mitglied
    expect(await pfade(b.admin)).toEqual(['wissen/test/offen.md']);
  });

  it('Suche: Rechtefilter vor dem Ranking', async () => {
    for (const [u, erlaubt] of [
      [b.leser, ['wissen/test/offen.md']],
      [b.werk, ['wissen/test/offen.md', 'wissen/test/team.md']],
      [b.autor, ['wissen/test/offen.md', 'wissen/test/privat.md', 'wissen/test/team.md']],
    ] as const) {
      const t = await kern.suche(u, 'Hallentore', { limit: 50 });
      for (const x of t) expect(erlaubt).toContain(x.pfad);
      expect(t.length).toBe(erlaubt.length);
    }
  });

  it('Reichweite ich / team / betrieb', async () => {
    expect((await kern.suche(b.autor, 'Hallentore', { reichweite: 'ich' })).map((t) => t.pfad)).toEqual(['wissen/test/privat.md']);
    expect((await kern.suche(b.autor, 'Hallentore', { reichweite: 'team' })).map((t) => t.pfad).sort()).toEqual(['wissen/test/privat.md', 'wissen/test/team.md']);
    expect((await kern.suche(b.autor, 'Hallentore', { reichweite: 'betrieb' })).length).toBe(3);
  });

  it('frage nutzt nur erlaubte Abschnitte', async () => {
    const a = await kern.frage(b.leser, 'Wie lautet der Schrankcode Werkstatt?');
    for (const x of a.belege) expect(x.quelle).toBe('wissen/test/offen.md');
    const w = await kern.frage(b.werk, 'Wie lautet der Schrankcode Werkstatt?');
    expect(w.status).toBe('beantwortet');
    expect(w.belege[0]?.quelle).toBe('wissen/test/team.md');
  });

  it('leseArtikel: unsichtbar = nicht gefunden (kein Hinweis auf Existenz)', async () => {
    await expect(kern.leseArtikel(b.leser, 'wissen/test/privat.md')).rejects.toMatchObject({ code: 'nicht_gefunden' });
    await expect(kern.leseArtikel(b.leser, 'wissen/test/gibtsnicht.md')).rejects.toMatchObject({ code: 'nicht_gefunden' });
    await expect(kern.leseArtikel(b.leser, '../etc/passwd')).rejects.toThrow();
    expect((await kern.leseArtikel(b.autor, 'wissen/test/privat.md')).kopf.sichtbarkeit).toBe('ich');
  });

  it('Sichtbarkeit setzen nur für eigene Teams', async () => {
    await expect(kern.fuegeHinzu(b.autor, { art: 'text', inhalt: 'Büro intern', sammlung: 'x', sichtbarkeit: 'team:buero' })).rejects.toMatchObject({ code: 'keine_rechte' });
  });

  it('index.md nennt private Dateien nicht', async () => {
    const { readFile } = await import('node:fs/promises');
    const idx = await readFile(join(kern.dir, 'wissen/test/index.md'), 'utf8');
    expect(idx).toContain('Hallenordnung');
    expect(idx).not.toContain('Annas Notiz');
  });
});
