import { afterAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aufraeumen, benutzerSatz, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

async function alles(dir: string): Promise<string> {
  let out = '';
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out += await readFile(join(e.parentPath, e.name), 'utf8');
  return out;
}

describe('S1 N1 / P2: Index, Protokoll und Export verraten keine Team-Titel', () => {
  it('gemeinsame index.md/log.md nennen Team-Dateien nur als Zahl; Leser-Export ohne fremde Team-Dateien', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    await kern.fuegeHinzu(b.admin, { art: 'text', titel: 'Geheime Gehaltsrunde Buero', inhalt: 'Nur fürs Büro.', sammlung: 'x', sichtbarkeit: 'team:buero', kompilieren: false });
    await kern.fuegeHinzu(b.admin, { art: 'text', titel: 'Hobelmesser', inhalt: 'Für alle.', sammlung: 'x', sichtbarkeit: 'betrieb', kompilieren: false });
    const idx = await readFile(join(dir, 'quellen/index.md'), 'utf8');
    expect(idx).toContain('Hobelmesser');
    expect(idx).not.toContain('Gehaltsrunde');
    expect(idx).toMatch(/1 weitere Quellen mit eingeschränkter Sichtbarkeit/);
    expect(await readFile(join(dir, 'quellen/log.md'), 'utf8')).not.toContain('Gehaltsrunde');
    expect(await readFile(join(dir, 'log.md'), 'utf8')).not.toContain('Gehaltsrunde');
    // nach Rechten erzeugter Index
    expect(await kern.ordnerIndex(b.frei, 'quellen')).toContain('Gehaltsrunde');
    expect(await kern.ordnerIndex(b.leser, 'quellen')).not.toContain('Gehaltsrunde');
    // Export für den Leser
    const z = tmp('exp-');
    const r = await kern.exportiereOkf(z, { fuer: b.leser });
    expect(r.ausgelassen).toBeGreaterThan(0);
    const inhalt = await alles(z);
    expect(inhalt).toContain('Hobelmesser');
    expect(inhalt).not.toContain('Gehaltsrunde');
    const z2 = tmp('exp-');
    await kern.exportiereOkf(z2, { fuer: b.frei });
    expect(await alles(z2)).toContain('Gehaltsrunde');
    await kern.schliesse();
  });
});
