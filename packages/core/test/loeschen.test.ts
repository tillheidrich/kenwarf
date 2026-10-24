import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { aufraeumen, benutzerSatz, gitLog, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

describe('loescheEndgueltig (Art. 17 DSGVO)', () => {
  it('entfernt Datei, Original und Vorschläge aus Arbeitsstand und Verlauf; Protokoll ohne Inhalt', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    const geheim = 'Herr Zacharias Quengelmeier wohnt in der Ulmenallee 7';
    const r = await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Kundennotiz Quengelmeier', inhalt: `${geheim}. Bitte nicht klingeln.`, sammlung: 'kunden', sichtbarkeit: 'betrieb' });
    expect(r.vorschlaege.length).toBe(1);
    await kern.entscheide(b.frei, r.vorschlaege[0]!.id, { aktion: 'freigeben' });
    // zusätzlich eine ganz andere Datei, die erhalten bleiben muss
    await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Hobelmesser', inhalt: 'Hobelmesser werden alle 40 Stunden gewechselt.', sammlung: 'werkstatt', sichtbarkeit: 'betrieb', kompilieren: false });
    const artikelPfad = r.vorschlaege[0]!.ziel;
    const git = simpleGit(dir);
    expect(await git.raw(['log', '--all', '-p'])).toContain('Quengelmeier');

    await expect(kern.loescheEndgueltig(b.frei, r.quelle.pfad, 'Auskunftsersuchen')).rejects.toMatchObject({ code: 'keine_rechte' });
    await expect(kern.loescheEndgueltig(b.admin, r.quelle.pfad, ' ')).rejects.toMatchObject({ code: 'ungueltig' });
    const q = await kern.loescheEndgueltig(b.admin, r.quelle.pfad, 'Löschantrag nach Art. 17 DSGVO vom 24.10.2026');
    expect(q.entfernt).toContain(r.quelle.pfad);
    const a = await kern.loescheEndgueltig(b.admin, artikelPfad, 'Löschantrag nach Art. 17 DSGVO vom 24.10.2026');
    expect(a.entfernt).toEqual([artikelPfad]);

    expect(existsSync(join(dir, r.quelle.pfad))).toBe(false);
    expect(existsSync(join(dir, artikelPfad))).toBe(false);
    // nichts mehr im Verlauf: weder Inhalte noch Titel, noch Objekte
    const alles = await git.raw(['log', '--all', '-p', '--format=%an %s %b']);
    expect(alles).not.toContain('Quengelmeier');
    expect(alles).not.toContain('Ulmenallee');
    const objekte = await git.raw(['rev-list', '--all', '--objects']);
    expect(objekte).not.toContain('quengelmeier');
    const blobs = await git.raw(['cat-file', '--batch-all-objects', '--batch']);
    expect(blobs).not.toContain('Ulmenallee');
    expect(blobs).not.toContain('Quengelmeier');
    // Protokoll ohne Inhalt
    const log = await gitLog(dir);
    expect(log[0]!.nachricht).toBe('Datei endgültig gelöscht');
    expect(log[0]!.text).toContain('Grund: Löschantrag nach Art. 17 DSGVO');
    expect(await readFile(join(dir, 'log.md'), 'utf8')).toContain('Datei endgültig gelöscht (Ada Admin');
    // Suche und Index
    expect(await kern.suche(b.admin, 'Ulmenallee')).toEqual([]);
    expect(await kern.suche(b.admin, 'Hobelmesser Stunden')).not.toEqual([]);
    expect(await readFile(join(dir, 'quellen/2026/hobelmesser.md'), 'utf8')).toContain('40 Stunden');
    await kern.schliesse();
  });
});

describe('loescheEndgueltig: ganze Kette, fremde Artikel bleiben, Bereinigung im Eingang (S1 M6)', () => {
  it('Quelle zweimal erfasst, löschen → beide Fassungen weg, fremder Artikel unverändert, Vorschlag im Eingang', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    const q1 = await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Lieferant Ziegler', inhalt: 'Ziegler liefert Eichenbohlen zu 95 Euro je Kubikmeter.', sammlung: 'einkauf', sichtbarkeit: 'betrieb', kompilieren: false });
    const q2 = await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Lieferant Ziegler', inhalt: 'Ziegler liefert Eichenbohlen zu 99 Euro je Kubikmeter.', sammlung: 'einkauf', sichtbarkeit: 'betrieb', kompilieren: false, ersetzt: q1.quelle.pfad } as never);
    expect(q2.quelle.kopf.ersetzt).toBe(q1.quelle.pfad);
    // fremder Artikel, der den Titel nennt und sich auf die Quelle stützt
    const text = `---\ntype: Artikel\ntitel: Einkauf\ngruppe: einkauf\nkurzfassung: Einkauf.\nstand: 2026-10-01\nverantwortlich: Ada\npruefen_bis: null\nsichtbarkeit: betrieb\nbesitzer: ${b.admin.id}\nfundstellen:\n  - id: f1\n    quelle: ${q2.quelle.pfad}\n    abschnitt: Lieferant Ziegler\n    zeilen: [1, 1]\nstatus: freigegeben\n---\n\nUnser Holz kommt vom „Lieferant Ziegler“.[^f1]\n`;
    const v = await kern.schlageVor(b.admin, { art: 'neu', ziel: 'wissen/einkauf/einkauf.md', alt: null, neu: text, grund: 'Einkauf' });
    await kern.entscheide(b.admin, v.id, { aktion: 'freigeben' });
    const vorher = await readFile(join(dir, 'wissen/einkauf/einkauf.md'), 'utf8');

    const r = await kern.loescheEndgueltig(b.admin, q2.quelle.pfad, 'Löschantrag');
    expect(r.entfernt).toEqual(expect.arrayContaining([q1.quelle.pfad, q2.quelle.pfad]));
    expect(existsSync(join(dir, q1.quelle.pfad))).toBe(false);
    expect(existsSync(join(dir, q2.quelle.pfad))).toBe(false);
    const git = simpleGit(dir);
    expect(await git.raw(['log', '--all', '-p'])).not.toContain('Eichenbohlen');
    expect(await readFile(join(dir, 'wissen/einkauf/einkauf.md'), 'utf8')).toBe(vorher);
    expect(r.bereinigung).toHaveLength(1);
    expect(r.bereinigung[0]!.ziel).toBe('wissen/einkauf/einkauf.md');
    expect(r.bereinigung[0]!.neu).not.toContain(q2.quelle.pfad);
    expect((await kern.eingang(b.admin, { alle: true })).map((x) => x.id)).toContain(r.bereinigung[0]!.id);
    expect(r.hinweise.join(' ')).toMatch(/12 Monaten/);
    await kern.schliesse();
  });
});
