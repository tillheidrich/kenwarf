import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { berichtAlsMarkdown, importiereOutline } from '../src/index.js';
import { aufraeumen, beispielBuendel, neuerKern, tmp } from './helfer.js';

afterEach(aufraeumen);

describe('importiereOutline', () => {
  it('Trockenlauf ohne Datenordner schreibt nichts und plant alles', async () => {
    const dir = join(tmp(), 'gibt-es-nicht');
    const r = await importiereOutline(null, { id: 't', name: 't', rollen: ['admin'], teams: [] }, beispielBuendel(), { trockenlauf: true, datenOrdner: dir });
    expect(existsSync(dir)).toBe(false);
    expect(r.trockenlauf).toBe(true);
    expect(r.summe.neu).toBe(3);
    expect(r.dokumente.map((d) => d.wissen?.ziel)).toEqual(['wissen/marke-branding/start.md', 'wissen/marke-branding/farbe.md', 'wissen/strategie-privat/geheim.md']);
    expect(r.sammlungen.find((s) => s.name === 'Strategie (privat)')!.sichtbarkeit).toBe('ich');
    expect(r.sammlungen.find((s) => s.name === 'Marke & Branding')!.sichtbarkeit).toBe('betrieb');
    expect(berichtAlsMarkdown(r)).toContain('Trockenlauf');
  });

  it('legt Quellen und 1:1-Vorschläge an, schreibt Links um, nimmt PDF-Anhang als Quelle, Kommentare als eigene Quelle', async () => {
    const { kern, dir, till } = await neuerKern();
    const r = await importiereOutline(kern, till, beispielBuendel(), { datenOrdner: dir });
    expect(r.summe).toMatchObject({ dokumente: 3, neu: 3, vorschlaege: 3, freigegeben: 0, anhaengeAlsQuelle: 1, anhaengeOffen: 1, kommentare: 1 });
    // nichts direkt im Wissen
    expect(existsSync(join(dir, 'wissen/marke-branding/start.md'))).toBe(false);
    const eingang = await (kern.eingang as unknown as (u: unknown, o: unknown) => Promise<{ ziel: string; neu: string }[]>).call(kern, till, { alle: true });
    const start = eingang.find((v) => v.ziel === 'wissen/marke-branding/start.md')!;
    expect(start.neu).toContain('[Farbe](./farbe.md)');
    expect(start.neu).toMatch(/\[handbuch\.pdf\]\(\.\.\/\.\.\/quellen\/2026\/[^)]+\.md\)/);
    expect(start.neu).toContain('![Logo](https://wiki.example.de/api/attachments.redirect?id=a0000002');
    expect(start.neu).toContain('outline_schluessel: Start00001');
    expect(start.neu).toMatch(/kommentare: quellen\/2026\//);
    const farbe = eingang.find((v) => v.ziel === 'wissen/marke-branding/farbe.md')!;
    expect(farbe.neu).toContain('[Start](./start.md)');
    expect(farbe.neu).toContain('eltern: wissen/marke-branding/start.md');
    const quellen = await kern.listeQuellen(till);
    expect(quellen.map((q) => q.kopf.herkunft).sort()).toEqual(['outline-anhang-a0000001-aaaa-4bbb-8ccc-000000000002.pdf', 'outline-farbe00001.md', 'outline-geheim0001.md', 'outline-start00001-kommentare.md', 'outline-start00001.md']);
    const q = quellen.find((x) => x.kopf.herkunft === 'outline-start00001.md')!;
    expect(q.text).toContain('> Aus Outline: [Start](https://wiki.example.de/doc/x-Start00001)');
    // Original mit Outline-Kopf bleibt erhalten
    const orig = readdirSync(join(dir, 'quellen/2026')).find((f) => f.endsWith('.orig.md') && f.startsWith('start'));
    expect(orig).toBeTruthy();
    await kern.schliesse();
  });

  it('Wiederholungslauf: nichts doppelt; Änderung in Outline ergibt neue Quellfassung und Änderungsvorschlag', async () => {
    const { kern, dir, till } = await neuerKern();
    await importiereOutline(kern, till, beispielBuendel(), { datenOrdner: dir, freigeben: true });
    expect(existsSync(join(dir, 'wissen/marke-branding/farbe.md'))).toBe(true);
    const nQuellen = (await kern.listeQuellen(till)).length;

    const zweiter = await importiereOutline(kern, till, beispielBuendel(), { datenOrdner: dir });
    expect(zweiter.summe).toMatchObject({ neu: 0, aktualisiert: 0, unveraendert: 3, vorschlaege: 0 });
    expect((await kern.listeQuellen(till)).length).toBe(nQuellen);

    const b = beispielBuendel();
    b.dokumente[1]!.markdown = '## Markenfarbe\n\nDie Markenfarbe ist Kobalt #2055b3.\n\n## Nachtrag 24.10.2026\n\nEis nur auf Blau.\n';
    b.dokumente[1]!.geaendertAm = '2026-10-24T05:00:00.000Z';
    const dritter = await importiereOutline(kern, till, b, { datenOrdner: dir });
    expect(dritter.summe).toMatchObject({ neu: 0, aktualisiert: 1, unveraendert: 2, vorschlaege: 1 });
    const d = dritter.dokumente.find((x) => x.schluessel === 'Farbe00001')!;
    expect(d.quelle.aktion).toBe('aktualisieren');
    expect(d.wissen!.aktion).toBe('aktualisieren');
    const eingang = await (kern.eingang as unknown as (u: unknown, o: unknown) => Promise<{ art: string; ziel: string; diff?: string }[]>).call(kern, till, { alle: true });
    const v = eingang.find((x) => x.ziel === 'wissen/marke-branding/farbe.md')!;
    expect(v.art).toBe('aenderung');
    expect(v.diff).toContain('+Eis nur auf Blau.');
    // alte Quellfassung bleibt im Verlauf, gilt aber als ersetzt
    expect((await kern.listeQuellen(till)).length).toBe(nQuellen);
    // vierter Lauf mit derselben Änderung: der offene Vorschlag wird erkannt, kein zweiter
    const vierter = await importiereOutline(kern, till, b, { datenOrdner: dir });
    expect(vierter.summe.vorschlaege).toBe(0);
    await kern.schliesse();
  });

  it('Rechte: private Sammlung bleibt „ich“, Leser sieht sie nicht, Team-Zuordnung nur für Mitglieder', async () => {
    const { kern, dir, till, leser, mira } = await neuerKern();
    await importiereOutline(kern, till, beispielBuendel(), { datenOrdner: dir, freigeben: true });
    await kern.reindex();
    const sichtTill = (await kern.listeWissen(till)).map((a) => a.pfad);
    const sichtLeser = (await kern.listeWissen(leser)).map((a) => a.pfad);
    expect(sichtTill).toContain('wissen/strategie-privat/geheim.md');
    expect(sichtLeser).not.toContain('wissen/strategie-privat/geheim.md');
    expect(sichtLeser).toContain('wissen/marke-branding/farbe.md');
    const a = await kern.frage(leser, 'Wie hoch ist das Jahresziel für die Rücklage?');
    expect(a.status).toBe('steht_nicht_drin');

    // Team-Zuordnung durch einen Nicht-Mitglied-Autor fällt auf „ich“ zurück
    const r = await importiereOutline(kern, mira, beispielBuendel(), { datenOrdner: dir, trockenlauf: true, rechte: { 'Strategie (privat)': 'team:geschaeftsfuehrung' } });
    const s = r.sammlungen.find((x) => x.name === 'Strategie (privat)')!;
    expect(s.sichtbarkeit).toBe('ich');
    expect(s.grund).toContain('nicht im Team');
    await kern.schliesse();
  });

  it('freigeben nur mit Rolle freigeber', async () => {
    const { kern, dir, mira } = await neuerKern();
    await expect(importiereOutline(kern, mira, beispielBuendel(), { datenOrdner: dir, freigeben: true })).rejects.toThrow(/freigeber/);
    await kern.schliesse();
  });
});
