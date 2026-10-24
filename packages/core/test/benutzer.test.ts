import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aufraeumen, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

describe('Benutzer', () => {
  it('anlegen, prüfen, Rollen, Tokens; Passwort nur als scrypt-Hash, nicht in git', async () => {
    const dir = tmp();
    const k = await oeffne(dir);
    const a = await k.benutzer.anlegen('Jörn Wendt', 'geheim-123', ['admin'], ['buero']);
    expect(a).toEqual({ id: 'joern-wendt', name: 'Jörn Wendt', rollen: ['admin'], teams: ['buero'] });
    await expect(k.benutzer.anlegen('jörn wendt', 'geheim-123', ['leser'])).rejects.toMatchObject({ code: 'konflikt' });
    await expect(k.benutzer.anlegen('Kurz', '123', ['leser'])).rejects.toMatchObject({ code: 'ungueltig' });
    expect(await k.benutzer.pruefe('Jörn Wendt', 'geheim-123')).toMatchObject({ ...a, zugangsStand: 0, mussPasswortAendern: false });
    expect(await k.benutzer.pruefe('Jörn Wendt', 'falsch')).toBeNull();
    expect(await k.benutzer.pruefe('Niemand', 'geheim-123')).toBeNull();
    const roh = await readFile(join(dir, '.kern/users.json'), 'utf8');
    expect(roh).not.toContain('geheim-123');
    expect(roh).toMatch(/scrypt\$131072\$8\$1\$/);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.kern/');
    const t = await k.benutzer.erzeugeToken(a.id);
    expect((await k.benutzer.pruefeToken(t))?.id).toBe(a.id);
    expect(await k.benutzer.pruefeToken(t + 'x')).toBeNull();
    await k.benutzer.widerrufeTokens(a.id);
    expect(await k.benutzer.pruefeToken(t)).toBeNull();
    expect((await k.benutzer.aendere(a.id, { rollen: ['freigeber'] })).rollen).toEqual(['freigeber']);
    expect(await k.benutzer.liste()).toHaveLength(1);
    await k.schliesse();
  });
});

describe('S1 N2: Seed ohne feste Passwörter', () => {
  it('seedDemo zweimal ergibt verschiedene Hashes und Passwörter; demo-passwort gilt nicht', async () => {
    const { seedDemo } = await import('../src/seed/index.js');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmp, oeffne } = await import('./helfer.js');
    const a = tmp('seed-a-');
    const b = tmp('seed-b-');
    const ra = await seedDemo(a);
    const rb = await seedDemo(b);
    expect(ra.benutzer[0]!.passwort.length).toBeGreaterThanOrEqual(16);
    expect(ra.benutzer[0]!.passwort).not.toBe(rb.benutzer[0]!.passwort);
    const ha = JSON.parse(await readFile(join(a, '.kern/users.json'), 'utf8'))[0].passwort;
    const hb = JSON.parse(await readFile(join(b, '.kern/users.json'), 'utf8'))[0].passwort;
    expect(ha).not.toBe(hb);
    const k = await oeffne(a);
    expect(await k.benutzer.pruefe('Jörn Wendt', 'demo-passwort')).toBeNull();
    expect((await k.benutzer.pruefe('Jörn Wendt', ra.benutzer[0]!.passwort))?.name).toBe('Jörn Wendt');
    await k.schliesse();
  });
});
