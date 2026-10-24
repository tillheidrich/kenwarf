import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../src/util.js';
import { artikel, aufraeumen, benutzerSatz, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

describe('S1 M7: Rechte im core', () => {
  it('keine Selbstfreigabe durch Umstellen auf „ich“; private eigene Artikel weiter selbst freigebbar', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const v0 = await kern.schlageVor(b.admin, { art: 'neu', ziel: 'wissen/test/preise.md', alt: null, neu: artikel('Preise', 'Stundensatz 80 Euro.', { besitzer: b.admin.id }), grund: 'Preise' });
    await kern.entscheide(b.frei, v0.id, { aktion: 'freigeben' });
    // Autor stellt fremden Betriebsartikel auf „ich“ mit sich als Besitzer und will selbst freigeben
    await expect(kern.schlageVor(b.autor, { art: 'aenderung', ziel: 'wissen/test/preise.md', alt: null, neu: artikel('Preise', 'weg', { sichtbarkeit: 'ich', besitzer: b.autor.id }), grund: 'kapern' })).rejects.toMatchObject({ code: 'keine_rechte' });
    const v1 = await kern.schlageVor(b.autor, { art: 'aenderung', ziel: 'wissen/test/preise.md', alt: null, neu: artikel('Preise', 'weg', { sichtbarkeit: 'ich', besitzer: b.admin.id }), grund: 'kapern 2' });
    await expect(kern.entscheide(b.autor, v1.id, { aktion: 'freigeben' })).rejects.toMatchObject({ code: expect.stringMatching(/keine_rechte|nicht_gefunden/) });
    // eigener privater Artikel: Selbstfreigabe erlaubt
    const v2 = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/test/notiz.md', alt: null, neu: artikel('Notiz', 'Meine Notiz.', { sichtbarkeit: 'ich', besitzer: b.autor.id }), grund: 'privat' });
    expect((await kern.entscheide(b.autor, v2.id, { aktion: 'freigeben' })).status).toBe('freigegeben');
    // privat → betrieb veröffentlichen geht nicht selbst
    const v3 = await kern.schlageVor(b.autor, { art: 'aenderung', ziel: 'wissen/test/notiz.md', alt: null, neu: artikel('Notiz', 'Meine Notiz.', { sichtbarkeit: 'ich', besitzer: b.autor.id }), grund: 'noch privat' });
    await expect(kern.entscheide(b.autor, v3.id, { aktion: 'aendern', neuerText: artikel('Notiz', 'Für alle.', { sichtbarkeit: 'betrieb', besitzer: b.autor.id }) })).rejects.toMatchObject({ code: 'keine_rechte' });
    await kern.schliesse();
  });

  it('besitzer ist nicht frei setzbar (nur admin)', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    await expect(kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/test/x.md', alt: null, neu: artikel('X', 'x', { besitzer: b.frei.id }), grund: 'x' })).rejects.toMatchObject({ code: 'keine_rechte' });
    const ohne = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/test/y.md', alt: null, neu: artikel('Y', 'y', { besitzer: '' }), grund: 'y' });
    expect(parseMarkdown(ohne.neu).kopf['besitzer']).toBe(b.autor.id);
    const adm = await kern.schlageVor(b.admin, { art: 'neu', ziel: 'wissen/test/z.md', alt: null, neu: artikel('Z', 'z', { besitzer: b.frei.id }), grund: 'z' });
    expect(parseMarkdown(adm.neu).kopf['besitzer']).toBe(b.frei.id);
    await kern.schliesse();
  });

  it('OKF-Import übernimmt keinen fremden Urheber und keine fremde private Sichtbarkeit', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const ordner = tmp('okf-boese-');
    await mkdir(join(ordner, 'quellen/2026'), { recursive: true });
    await writeFile(join(ordner, 'index.md'), '---\nokf_version: "0.2"\n---\n\n# Index\n');
    const q = (titel: string, sicht: string, von: string) =>
      `---\ntype: Quelle\ntitel: ${titel}\nart: text\nherkunft: text\nerfasst_am: 2026-10-01T00:00:00.000Z\nerfasst_von: ${von}\nsichtbarkeit: "${sicht}"\nsammlung: x\nhash: abc\nersetzt: null\nbeobachtet: false\n---\n\n${titel} Inhalt.\n`;
    await writeFile(join(ordner, 'quellen/2026/a.md'), q('Fremd betrieb', 'betrieb', b.frei.id));
    await writeFile(join(ordner, 'quellen/2026/b.md'), q('Fremd privat', 'ich', b.frei.id));
    await writeFile(join(ordner, 'quellen/2026/c.md'), q('Fremdes Team', 'team:buero', b.frei.id));
    const r = await kern.importiereOkf(b.autor, ordner);
    const pfade = r.quellen.map((x) => x.kopf.titel);
    expect(pfade).toContain('Fremd betrieb');
    expect(pfade).not.toContain('Fremd privat');
    expect(pfade).not.toContain('Fremdes Team'); // autor ist nicht im Team buero
    expect(r.quellen.every((x) => x.kopf.erfasst_von === b.autor.id)).toBe(true);
    expect(r.uebersprungen.join(' ')).toMatch(/nicht erlaubt/);
    await kern.schliesse();
  });
});
