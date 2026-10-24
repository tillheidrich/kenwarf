import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import { rrf, kosinus, type RohTreffer } from '../src/suchindex.js';
import { mockEmbedding } from '../src/provider.js';
import { ftsText, stamm } from '../src/util.js';
import type { User } from '../src/types.js';
import { artikel, aufraeumen, benutzerSatz, oeffne, tmp } from './helfer.js';

let kern: Kern;
let vek: Kern;
let u: User;
let dir: string;

async function lege(d: string, pfad: string, inhalt: string) {
  await mkdir(join(d, pfad, '..'), { recursive: true });
  await writeFile(join(d, pfad), inhalt);
}

beforeAll(async () => {
  dir = tmp();
  await lege(dir, 'wissen/test/kueche.md', artikel('Einbauküchen', '## Anzahlung\n\nBei Einbauküchen nehmen wir 30 Prozent Anzahlung.'));
  await lege(dir, 'wissen/test/lack.md', artikel('Lackraum', '## Lüftung\n\nDie Lackraumlüftung läuft zehn Minuten nach.'));
  await lege(dir, 'wissen/test/tueren.md', artikel('Innentüren', '## Montage\n\nTürzargen werden geschäumt und am Folgetag verkleidet.'));
  await lege(dir, 'wissen/test/werkzeug.md', artikel('Werkzeugpflege', '## Sägeblätter\n\nStumpfe Sägeblätter kommen in die Kiste zum Schärfen.'));
  kern = await oeffne(dir);
  u = (await benutzerSatz(kern)).leser;
  await kern.schliesse();
  kern = await oeffne(dir);
  vek = await oeffne(dir, { vektoren: true, vektorErweiterung: true } as never);
});
afterAll(async () => {
  await kern.schliesse();
  await vek.schliesse();
  aufraeumen();
});

describe('Normalisierung', () => {
  it('Umlaute und einfache Stammformen', () => {
    expect(ftsText('Küchen Küche Kuechen')).toBe('kuch kuch kuch');
    expect(stamm('anzahlungen')).toBe(stamm('anzahlung'));
    expect(stamm('lüftung'.replace('ü', 'ue'))).toBe(stamm('lueften'));
    expect(stamm('montagen')).toBe(stamm('montage'));
  });
});

describe('FTS5', () => {
  it('findet trotz Umlaut-Schreibweise und Beugung', async () => {
    const t = await kern.suche(u, 'Kuechen Anzahlungen');
    expect(t[0]?.pfad).toBe('wissen/test/kueche.md');
    expect(t[0]?.abschnitt).toBe('Anzahlung');
    expect(t[0]?.zeilen[0]).toBeGreaterThan(10);
  });
  it('ohne Vektoren (mock) sind nur FTS und Trigramm aktiv', () => {
    expect(kern.vektorenAn).toBe(false);
    expect(vek.vektorenAn).toBe(true);
  });
});

describe('Trigramm (Komposita)', () => {
  it('„Lüftung“ findet „Lackraumlüftung“', async () => {
    const ix = kern.ix;
    const erlaubt = ix.dateien().map((d) => d.pfad);
    expect(ix.fts('Lüftung', erlaubt).map((t) => t.pfad)).toContain('wissen/test/lack.md'); // Überschrift
    const tri = ix.trigramm('zargen', erlaubt);
    expect(tri[0]?.pfad).toBe('wissen/test/tueren.md');
    expect(ix.fts('zargen', erlaubt)).toHaveLength(0); // FTS allein findet das Kompositum nicht
    const t = await kern.suche(u, 'zargen');
    expect(t[0]?.pfad).toBe('wissen/test/tueren.md');
  });
});

describe('Vektor', () => {
  it('Hash-Embedding ist deterministisch und normiert', () => {
    const a = mockEmbedding('Sägeblätter schärfen');
    const b = mockEmbedding('Sägeblätter schärfen');
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(kosinus(a, b)).toBeCloseTo(1, 5);
  });
  it('sqlite-vec und JS-Rückfall liefern dieselbe Reihenfolge', async () => {
    const q = mockEmbedding('Sägeblätter Kiste');
    const erlaubt = vek.ix.dateien().map((d) => d.pfad);
    const sql = vek.ix.vektor(q, erlaubt, 10);
    const js = vek.ix.vektor(q, erlaubt, 10, true);
    expect(sql.map((t) => t.id)).toEqual(js.map((t) => t.id));
    expect(sql[0]?.pfad).toBe('wissen/test/werkzeug.md');
    sql.forEach((t, i) => expect(t.score).toBeCloseTo(js[i]!.score, 4));
  });
  it('hybride Suche mit Vektoren', async () => {
    const t = await vek.suche(u, 'Sägeblätter');
    expect(t[0]?.pfad).toBe('wissen/test/werkzeug.md');
  });
});

describe('RRF', () => {
  const t = (id: number): RohTreffer => ({ id, pfad: `p${id}`, abschnitt: '', von: 1, bis: 1, text: '', art: 'wissen', titel: '', score: 0 });
  it('verschmilzt Ranglisten nach 1/(k+rang)', () => {
    const r = rrf([[t(1), t(2), t(3)], [t(3), t(1)]], 60);
    expect(r.map((x) => x.id)).toEqual([1, 3, 2]);
    expect(r[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
  });
});
