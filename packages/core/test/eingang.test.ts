import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import { parseMarkdown } from '../src/util.js';
import { artikel, aufraeumen, benutzerSatz, gitLog, oeffne, tmp } from './helfer.js';

let kern: Kern;
let dir: string;
let b: Awaited<ReturnType<typeof benutzerSatz>>;

beforeAll(async () => {
  dir = tmp();
  kern = await oeffne(dir);
  b = await benutzerSatz(kern);
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

describe('Eingang', () => {
  it('Vorschlag → Freigabe schreibt Datei und Commit (Autor = Freigeber, Nachricht = Grund)', async () => {
    const v = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/werkstatt/leimzeiten.md', alt: null, neu: artikel('Leimzeiten', 'Weißleim braucht 20 Minuten Presszeit.', { besitzer: b.autor.id, gruppe: 'werkstatt' }), grund: 'Leimzeiten aufschreiben' });
    expect(v.status).toBe('offen');
    expect(v.von).toBe(b.autor.id);
    expect(v.diff).toContain('+Weißleim braucht 20 Minuten Presszeit.');
    expect(v.basis_hash).toBe('');
    expect(existsSync(join(dir, 'wissen/werkstatt/leimzeiten.md'))).toBe(false);
    expect((await kern.eingang(b.frei)).map((x) => x.id)).toContain(v.id);
    // leser und autor dürfen nicht freigeben
    await expect(kern.entscheide(b.leser, v.id, { aktion: 'freigeben' })).rejects.toMatchObject({ code: 'keine_rechte' });
    await expect(kern.entscheide(b.autor, v.id, { aktion: 'freigeben' })).rejects.toMatchObject({ code: 'keine_rechte' });

    const f = await kern.entscheide(b.frei, v.id, { aktion: 'freigeben' });
    expect(f.status).toBe('freigegeben');
    expect(f.entscheidung?.von).toBe(b.frei.id);
    const datei = await readFile(join(dir, 'wissen/werkstatt/leimzeiten.md'), 'utf8');
    const k = parseMarkdown(datei).kopf;
    expect(k['status']).toBe('freigegeben');
    expect(k['type']).toBe('Artikel');
    expect((k['verified'] as { by: string }[])[0]!.by).toBe(`human:${b.frei.id}`);
    const log = await gitLog(dir, 'wissen/werkstatt/leimzeiten.md');
    expect(log[0]).toMatchObject({ autor: 'Fritz Frei', nachricht: 'Leimzeiten aufschreiben' });
    expect(existsSync(join(dir, `eingang/erledigt/${v.id}.json`))).toBe(true);
    expect(existsSync(join(dir, `eingang/${v.id}.json`))).toBe(false);
    expect((await kern.eingang(b.frei)).map((x) => x.id)).not.toContain(v.id);
    // index.md und log.md des Ordners
    expect(await readFile(join(dir, 'wissen/werkstatt/index.md'), 'utf8')).toContain('[Leimzeiten](/wissen/werkstatt/leimzeiten.md)');
    expect(await readFile(join(dir, 'wissen/werkstatt/log.md'), 'utf8')).toMatch(/## 2026-10-24[\s\S]*Leimzeiten aufschreiben \(Fritz Frei\)/);
    // Verlauf
    const vl = await kern.verlauf('wissen/werkstatt/leimzeiten.md');
    expect(vl[0]).toMatchObject({ von: 'Fritz Frei', grund: 'Leimzeiten aufschreiben' });
    // Suche findet den neuen Artikel
    expect((await kern.suche(b.leser, 'Presszeit Weißleim'))[0]?.pfad).toBe('wissen/werkstatt/leimzeiten.md');
    // Zweites Entscheiden geht nicht
    await expect(kern.entscheide(b.frei, v.id, { aktion: 'freigeben' })).rejects.toMatchObject({ code: 'konflikt' });
  });

  it('Ablehnung ohne Begründung schlägt fehl, mit Begründung wird committet', async () => {
    const v = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/werkstatt/unsinn.md', alt: null, neu: artikel('Unsinn', 'Text.', { besitzer: b.autor.id }), grund: 'Test' });
    await expect(kern.entscheide(b.frei, v.id, { aktion: 'ablehnen' })).rejects.toMatchObject({ code: 'ungueltig' });
    await expect(kern.entscheide(b.frei, v.id, { aktion: 'ablehnen', begruendung: '   ' })).rejects.toMatchObject({ code: 'ungueltig' });
    const r = await kern.entscheide(b.frei, v.id, { aktion: 'ablehnen', begruendung: 'Gehört nicht in den Ordner.' });
    expect(r.status).toBe('abgelehnt');
    expect(r.entscheidung?.begruendung).toBe('Gehört nicht in den Ordner.');
    expect(existsSync(join(dir, 'wissen/werkstatt/unsinn.md'))).toBe(false);
    const log = await gitLog(dir);
    expect(log[0]!.nachricht).toBe('Vorschlag abgelehnt: Test');
    expect(log[0]!.text).toContain('Gehört nicht in den Ordner.');
  });

  it('ändern und freigeben', async () => {
    const v = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/werkstatt/kleber.md', alt: null, neu: artikel('Kleber', 'Erste Fassung.', { besitzer: b.autor.id }), grund: 'Kleber' });
    const r = await kern.entscheide(b.frei, v.id, { aktion: 'aendern', neuerText: artikel('Kleber', 'Korrigierte Fassung.', { besitzer: b.autor.id }), begruendung: 'Wort korrigiert' });
    expect(r.status).toBe('freigegeben');
    expect(await readFile(join(dir, 'wissen/werkstatt/kleber.md'), 'utf8')).toContain('Korrigierte Fassung.');
  });

  it('Konflikt: Zieldatei inzwischen geändert ⇒ Status konflikt mit neuem Vergleich, nichts überschrieben', async () => {
    const alt = await readFile(join(dir, 'wissen/werkstatt/kleber.md'), 'utf8');
    const v = await kern.schlageVor(b.autor, { art: 'aenderung', ziel: 'wissen/werkstatt/kleber.md', alt, neu: alt.replace('Korrigierte Fassung.', 'Vorschlag A.'), grund: 'Änderung A' });
    expect(v.basis_hash).toMatch(/^[0-9a-f]{64}$/);
    // jemand ändert die Datei direkt (z. B. in Obsidian)
    const extern = alt.replace('Korrigierte Fassung.', 'Extern geändert.');
    await writeFile(join(dir, 'wissen/werkstatt/kleber.md'), extern);
    const k = await kern.entscheide(b.frei, v.id, { aktion: 'freigeben' });
    expect(k.status).toBe('konflikt');
    expect(k.alt).toBe(extern);
    expect(k.diff).toContain('-Extern geändert.');
    expect(await readFile(join(dir, 'wissen/werkstatt/kleber.md'), 'utf8')).toBe(extern);
    expect((await kern.eingang(b.frei)).find((x) => x.id === v.id)?.status).toBe('konflikt');
    // erneute Freigabe entscheidet gegen den neuen Stand
    await kern.uebernimmAenderungen();
    const f = await kern.entscheide(b.frei, v.id, { aktion: 'freigeben' });
    expect(f.status).toBe('freigegeben');
    expect(await readFile(join(dir, 'wissen/werkstatt/kleber.md'), 'utf8')).toContain('Vorschlag A.');
  });

  it('Löschung', async () => {
    const alt = await readFile(join(dir, 'wissen/werkstatt/kleber.md'), 'utf8');
    const v = await kern.schlageVor(b.autor, { art: 'loeschung', ziel: 'wissen/werkstatt/kleber.md', alt, neu: '', grund: 'Doppelt' });
    await kern.entscheide(b.frei, v.id, { aktion: 'freigeben' });
    expect(existsSync(join(dir, 'wissen/werkstatt/kleber.md'))).toBe(false);
    expect((await gitLog(dir))[0]!.nachricht).toBe('Doppelt');
  });

  it('Regeln nur per admin, reservierte Namen und Ausbrüche abgelehnt', async () => {
    const v = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/_regeln/was-nie-hineinkommt.md', alt: null, neu: artikel('Regeln', '- Gehalt', { besitzer: b.autor.id }), grund: 'Regel' });
    expect(v.regel).toBe(true);
    await expect(kern.entscheide(b.frei, v.id, { aktion: 'freigeben' })).rejects.toMatchObject({ code: 'keine_rechte' });
    expect((await kern.entscheide(b.admin, v.id, { aktion: 'freigeben' })).status).toBe('freigegeben');
    for (const ziel of ['wissen/test/index.md', 'wissen/log.md', 'quellen/x.md', '../x.md', 'wissen/../kern.yaml']) {
      await expect(kern.schlageVor(b.autor, { art: 'neu', ziel, alt: null, neu: artikel('X', 'x'), grund: 'x' })).rejects.toThrow();
    }
    await expect(kern.schlageVor(b.leser, { art: 'neu', ziel: 'wissen/a/b.md', alt: null, neu: artikel('X', 'x'), grund: 'x' })).rejects.toMatchObject({ code: 'keine_rechte' });
  });

  it('ungültiger Kopf wird abgewiesen', async () => {
    await expect(kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/a/kaputt.md', alt: null, neu: '---\ntitel: X\nstand: gestern\n---\nText', grund: 'x' })).rejects.toMatchObject({ code: 'ungueltig' });
  });

  it('eigene private Vorschläge darf der Besitzer selbst freigeben', async () => {
    const v = await kern.schlageVor(b.autor, { art: 'neu', ziel: 'wissen/notizen/anna.md', alt: null, neu: artikel('Annas Liste', 'Privat.', { sichtbarkeit: 'ich', besitzer: b.autor.id }), grund: 'Eigene Notiz' });
    expect((await kern.eingang(b.frei)).map((x) => x.id)).not.toContain(v.id);
    expect((await kern.entscheide(b.autor, v.id, { aktion: 'freigeben' })).status).toBe('freigegeben');
  });

  it('kompiliere: Vorschlag aus Quelle mit Fundstellen und Fußnoten, nie direkt ins Wissen', async () => {
    const r = await kern.fuegeHinzu(b.autor, { art: 'notiz', inhalt: 'Die Formatkreissäge bekommt jeden Montag ein neues Sägeblatt. Alte Blätter gehen zum Schärfen.', titel: 'Notiz Formatkreissäge', sammlung: 'werkstatt', sichtbarkeit: 'betrieb' });
    expect(r.vorschlaege).toHaveLength(1);
    const v = r.vorschlaege[0]!;
    expect(v.art).toBe('neu');
    expect(v.quelle).toBe(r.quelle.pfad);
    expect(existsSync(join(dir, v.ziel))).toBe(false);
    const k = parseMarkdown(v.neu).kopf as Record<string, any>;
    expect(k['status']).toBe('entwurf');
    expect(k['generated'].by).toBe('kern-ki/mock');
    expect(k['fundstellen'][0]).toMatchObject({ id: 'f1', quelle: r.quelle.pfad });
    expect(v.neu).toContain('[^f1]');
  });
});
