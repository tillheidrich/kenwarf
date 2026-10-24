import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { nurMarkup } from '../src/kern.js';
import { artikel, aufraeumen, benutzerSatz, oeffne, seedKern } from './helfer.js';

afterAll(() => aufraeumen());

describe('v1.4.1 U8, U10, U11', () => {
  it('U8: herkunft, extern_id und zusatz im Quellenkopf; gleiche extern_id ersetzt die alte Fassung; Pflichtfelder geschützt', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const opt = { art: 'text' as const, sammlung: 'outline', sichtbarkeit: 'betrieb' as const, kompilieren: false };
    const a = await kern.fuegeHinzu(b.autor, { ...opt, titel: 'Hobel', inhalt: 'Hobelmesser alle 40 Stunden wechseln.', herkunft: 'https://wiki.example/doc/hobel-abc', extern_id: 'abc', zusatz: { outline_sammlung: 'Werkstatt', titel: 'X', sichtbarkeit: 'ich' } });
    expect(a.quelle.kopf).toMatchObject({ herkunft: 'https://wiki.example/doc/hobel-abc', extern_id: 'abc', outline_sammlung: 'Werkstatt', titel: 'Hobel', sichtbarkeit: 'betrieb' });
    const n = await kern.fuegeHinzu(b.autor, { ...opt, titel: 'Hobel neu', inhalt: 'Hobelmesser alle 30 Stunden wechseln.', herkunft: 'https://wiki.example/doc/hobel-abc', extern_id: 'abc' });
    expect(n.quelle.kopf.ersetzt).toBe(a.quelle.pfad);
    await expect(kern.fuegeHinzu(b.autor, { ...opt, inhalt: 'x y z', zusatz: { gross: 'x'.repeat(9000) } })).rejects.toThrow(/zusatz/);
    await kern.schliesse();
  });

  it('U10: Nachtrag nur angehängt, sonst abgelehnt; nach Änderung am Ziel wird angehängt statt Konflikt; Sammelfreigabe', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    for (const n of ['a', 'b', 'c']) {
      const v = await kern.schlageVor(b.admin, { art: 'neu', ziel: `wissen/test/${n}.md`, alt: null, neu: artikel(n.toUpperCase(), `# ${n}\n\nText ${n}.`, { besitzer: b.admin.id }), grund: 'Anlage' });
      await kern.entscheide(b.admin, v.id, { aktion: 'freigeben' });
    }
    const alt = readFileSync(join(kern.dir, 'wissen/test/a.md'), 'utf8');
    await expect(kern.schlageVor(b.autor, { art: 'nachtrag', ziel: 'wissen/test/a.md', alt, neu: alt.replace('Text a.', 'Anders.'), grund: 'x' })).rejects.toThrow(/nur anhängen/);
    const v = await kern.nachtrag(b.autor, { ziel: 'wissen/test/a.md', text: '## Nachtrag\n\nNeu dazu.', grund: 'Outline-Import' });
    expect(v.art).toBe('nachtrag');
    // Ziel ändert sich zwischendurch
    const z = await kern.schlageVor(b.admin, { art: 'aenderung', ziel: 'wissen/test/a.md', alt, neu: alt.replace('Text a.', 'Text a, geändert.'), grund: 'Zwischendurch' });
    await kern.entscheide(b.admin, z.id, { aktion: 'freigeben' });
    const r = await kern.entscheide(b.frei, v.id, { aktion: 'freigeben' });
    expect(r.status).toBe('freigegeben');
    const jetzt = readFileSync(join(kern.dir, 'wissen/test/a.md'), 'utf8');
    expect(jetzt).toContain('Text a, geändert.');
    expect(jetzt.trimEnd().endsWith('Neu dazu.')).toBe(true);
    // Sammelfreigabe nach Grund
    await kern.nachtrag(b.autor, { ziel: 'wissen/test/b.md', text: 'Mehr b.', grund: 'Outline-Import Lauf 7' });
    await kern.nachtrag(b.autor, { ziel: 'wissen/test/c.md', text: 'Mehr c.', grund: 'Outline-Import Lauf 7' });
    await kern.nachtrag(b.autor, { ziel: 'wissen/test/c.md', text: 'Anderes.', grund: 'Einzeln' });
    await expect(kern.entscheideSammel(b.frei, {}, { aktion: 'freigeben' })).rejects.toThrow();
    const s = await kern.entscheideSammel(b.frei, { grund: 'Outline-Import Lauf 7' }, { aktion: 'freigeben' });
    expect(s.erledigt.map((x) => x.ziel).sort()).toEqual(['wissen/test/b.md', 'wissen/test/c.md']);
    expect(s.fehler).toEqual([]);
    expect((await kern.eingang(b.frei, { alle: true })).map((x) => x.grund)).toEqual(['Einzeln']);
    await expect(kern.entscheideSammel(b.autor, { grund: 'Einzeln' }, { aktion: 'freigeben' })).resolves.toMatchObject({ erledigt: [], fehler: [{ meldung: expect.any(String) }] });
    await kern.schliesse();
  });

  it('U11: Bild- und Linkzeilen nie als Beleg; Artikel und seine einzige Quelle ergeben einen Beleg', async () => {
    expect(nurMarkup('![Logo](bilder/logo.png)')).toBe(true);
    expect(nurMarkup('[Preisblatt 2026](/quellen/2026/preisblatt.md)')).toBe(true);
    expect(nurMarkup('Siehe https://example.org/x')).toBe(false);
    expect(nurMarkup('Der Satz steht in den [Textbausteinen](/wissen/x.md).')).toBe(false);
    const { kern, u } = await seedKern();
    for (const q of ['Wie viel Anzahlung nehmen wir bei Einbauküchen?', 'Wer nimmt Reklamationen auf?', 'Wie lange dauert die Lieferung von Plattenware?']) {
      const a = await kern.frage(u['lena']!, q);
      for (const b of a.belege) expect(nurMarkup(b.zitat), `${q}: ${b.zitat}`).toBe(false);
    }
    const kai = u['kai']!;
    const q = await kern.fuegeHinzu(kai, { art: 'text', titel: 'Leimholz Lieferant', inhalt: '# Leimholz\n\n![Foto](foto.png)\n\nLeimholzplatten liefert die Firma Brettmann innerhalb von fünf Werktagen.', sammlung: 'werkstatt', sichtbarkeit: 'betrieb', kompilieren: false });
    const text = `# Leimholz\n\nLeimholzplatten liefert die Firma Brettmann innerhalb von fünf Werktagen.`;
    const v = await kern.schlageVor(kai, { art: 'neu', ziel: 'wissen/werkstatt/leimholz.md', alt: null, neu: artikel('Leimholz', text, { besitzer: kai.id, fundstellen: [{ id: 'f1', quelle: q.quelle.pfad, abschnitt: 'Leimholz', zeilen: [1, 1] }] }), grund: 'Leimholz' });
    await kern.entscheide(u['jörn']!, v.id, { aktion: 'freigeben' });
    const a = await kern.frage(u['lena']!, 'Wer liefert Leimholzplatten in fünf Werktagen?');
    expect(a.status).toBe('beantwortet');
    const pfade = a.belege.map((b) => b.quelle);
    expect(pfade).toContain('wissen/werkstatt/leimholz.md');
    expect(pfade).not.toContain(q.quelle.pfad);
    for (const p of a.punkte) for (const n of p.belege) expect(a.belege[n - 1]).toBeDefined();
    await kern.schliesse();
  });
});
