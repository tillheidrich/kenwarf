import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { wortAnzahl } from '../src/util.js';
import { artikel, aufraeumen, gitLog, oeffne, seedKern, warteBis } from './helfer.js';

let kern: Kern;
let u: Record<string, User>;
let dir: string;

beforeAll(async () => {
  ({ kern, u, dir } = await seedKern());
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

const FRAGEN = ['Anzahlung Einbauküche', 'Aufmaß mitnehmen', 'Reklamation Fotos', 'Lackraum Lüftung', 'Werkstatt Feierabend Absaugung', 'Zahlungsziel Schlussrechnung'];

describe('reindex', () => {
  it('Index aus Dateien neu bauen ergibt identische Suchergebnisse', async () => {
    const vorher = [];
    for (const q of FRAGEN) vorher.push(await kern.suche(u.malte!, q, { limit: 10 }));
    const r = await kern.reindex();
    expect(r.dateien).toBeGreaterThan(25);
    expect(r.abschnitte).toBeGreaterThan(80);
    const nachher = [];
    for (const q of FRAGEN) nachher.push(await kern.suche(u.malte!, q, { limit: 10 }));
    expect(nachher).toEqual(vorher);
  });

  it('Index-Datei gelöscht ⇒ beim Öffnen neu gebaut, gleiche Ergebnisse', async () => {
    const vorher = await kern.suche(u.malte!, 'Absaugung leeren');
    await kern.schliesse();
    await rm(join(dir, '.kern', 'index.sqlite'), { force: true });
    await rm(join(dir, '.kern', 'index.sqlite-wal'), { force: true });
    await rm(join(dir, '.kern', 'index.sqlite-shm'), { force: true });
    kern = await oeffne(dir);
    expect(await kern.suche(u.malte!, 'Absaugung leeren')).toEqual(vorher);
  });
});

describe('externe Änderungen', () => {
  it('beobachteOrdner: Datei im Editor geändert ⇒ Index aktualisiert ⇒ Commit „extern geändert“', async () => {
    const gemeldet: string[][] = [];
    const stop = kern.beobachteOrdner((p) => gemeldet.push(p));
    try {
      await new Promise((r) => setTimeout(r, 400)); // Beobachter bereit
      const pfad = join(dir, 'wissen/ablaeufe/montage-vorbereiten.md');
      const alt = await readFile(pfad, 'utf8');
      await writeFile(pfad, alt + '\n## Nachtrag aus Obsidian\n\nSchutzfolie Zebrano einpacken.\n');
      await warteBis(async () => (await gitLog(dir))[0]?.nachricht === 'extern geändert');
      expect((await gitLog(dir))[0]!.autor).toBe('extern');
      await warteBis(async () => gemeldet.length > 0);
      expect(gemeldet.flat()).toContain('wissen/ablaeufe/montage-vorbereiten.md');
      expect((await kern.suche(u.malte!, 'Schutzfolie Zebrano'))[0]?.pfad).toBe('wissen/ablaeufe/montage-vorbereiten.md');
      // neue Datei von außen
      await writeFile(join(dir, 'wissen/ablaeufe/neu-von-aussen.md'), artikel('Von außen', 'Quarzsand liegt im Regal drei.', { gruppe: 'ablaeufe' }));
      await warteBis(async () => (await kern.suche(u.malte!, 'Quarzsand Regal')).length > 0);
      await warteBis(async () => (await gitLog(dir, 'wissen/ablaeufe/neu-von-aussen.md')).length > 0);
      // Löschen von außen
      await unlink(join(dir, 'wissen/ablaeufe/neu-von-aussen.md'));
      await warteBis(async () => (await gitLog(dir, 'wissen/ablaeufe/neu-von-aussen.md')).length === 2);
      expect(await kern.suche(u.malte!, 'Quarzsand Regal')).toEqual([]);
    } finally {
      stop();
    }
  });

  it('Änderungen, während Kern nicht lief, werden beim Start übernommen', async () => {
    await kern.schliesse();
    const pfad = join(dir, 'wissen/einarbeitung/glossar.md');
    await writeFile(pfad, (await readFile(pfad, 'utf8')) + '\n## Nachtrag\n\nFlämmen heißt hier Abflammen.\n');
    kern = await oeffne(dir);
    expect((await gitLog(dir))[0]!.nachricht).toBe('extern geändert (beim Start erkannt)');
    expect((await kern.suche(u.lena!, 'Abflammen'))[0]?.pfad).toBe('wissen/einarbeitung/glossar.md');
  });
});

describe('Briefing, fällig', () => {
  it('fällig: überschrittene Prüftermine und ablaufende Fakten', async () => {
    const f = (await kern.faellig(u.kai!)).map((a) => a.pfad);
    expect(f).toContain('wissen/ablaeufe/werkstatt-feierabend-und-maschinenpflege.md');
    expect(f).toContain('wissen/einarbeitung/glossar.md');
    expect(f).toContain('wissen/betrieb/zahlen-und-fristen.md'); // Rabatt läuft am 15.11. ab
    // Team-Artikel nur für Team
    expect((await kern.faellig(u.sabine!)).map((a) => a.pfad)).not.toContain('wissen/ablaeufe/werkstatt-feierabend-und-maschinenpflege.md');
  });

  it('Briefing ≤ 300 Wörter, höchstens drei Entscheidungen, auch bei vielen Änderungen', async () => {
    for (let i = 0; i < 25; i++) await kern.fuegeHinzu(u.kai!, { art: 'notiz', inhalt: `Notiz Nummer ${i} über die Hobelbank ${i} und den Leimtopf mit vielen weiteren Wörtern zum Füllen.`, titel: `Hobelbank Notiz ${i} mit einem sehr langen Titel, damit das Briefing viele Wörter bekommt`, sammlung: 'werkstatt', sichtbarkeit: 'betrieb' });
    const b = await kern.briefing(u['jörn']!, '2020-01-01');
    expect(wortAnzahl(b.text)).toBeLessThanOrEqual(300);
    expect(b.entscheidungen.length).toBeLessThanOrEqual(3);
    expect(b.entscheidungen.length).toBeGreaterThan(0);
    expect(b.text).toMatch(/Offen im Eingang: \d+ Vorschläge/);
    expect(b.text).toContain('Rabatt Beschlagversand Hanse');
    expect(b.datum).toBe('2026-10-24');
    expect(b.links.length).toBeGreaterThan(0);
    // Leser bekommt keine Freigabe-Entscheidungen
    const l = await kern.briefing(u.lena!, '2020-01-01');
    expect(l.entscheidungen.every((e) => !e.startsWith('Vorschlag'))).toBe(true);
  });
});
