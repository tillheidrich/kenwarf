import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { aufraeumen, benutzerSatz, minimalDocx, minimalPdf, oeffne, testServer, tmp } from './helfer.js';

let kern: Kern;
let autor: User;
let dir: string;
const dateien = tmp('kern-dateien-');

beforeAll(async () => {
  dir = tmp();
  kern = await oeffne(dir);
  autor = (await benutzerSatz(kern)).autor;
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

const opt = { sammlung: 'test', sichtbarkeit: 'betrieb' as const, kompilieren: false };

describe('Ingest je Format', () => {
  it('Markdown: Titel aus Kopf, Original daneben, Hash', async () => {
    const p = join(dateien, 'notiz.md');
    await writeFile(p, '---\ntitel: Lackraum Regeln\n---\n\n# Lackraum\n\nTür zu, Lüftung an.\n');
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(r.quelle.kopf.titel).toBe('Lackraum Regeln');
    expect(r.quelle.kopf.type).toBe('Quelle');
    expect(r.quelle.text).toContain('Tür zu, Lüftung an.');
    expect(r.quelle.kopf.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.quelle.pfad).toMatch(/^quellen\/2026\/lackraum-regeln\.md$/);
    expect(existsSync(join(dir, 'quellen/2026/lackraum-regeln.orig.md'))).toBe(true);
    expect((await kern.original(autor, r.quelle.pfad))?.name).toBe('notiz.md');
  });

  it('Text: direkt', async () => {
    const r = await kern.fuegeHinzu(autor, { art: 'text', inhalt: 'Der Hubwagen steht hinten links.', ...opt });
    expect(r.quelle.kopf.art).toBe('text');
    expect(r.quelle.kopf.titel).toBe('Der Hubwagen steht hinten links.');
  });

  it('TXT-Datei', async () => {
    const p = join(dateien, 'liste.txt');
    await writeFile(p, 'Schleifpapier Körnung 120 nachbestellen.');
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(r.quelle.text.trim()).toBe('Schleifpapier Körnung 120 nachbestellen.');
  });

  it('HTML → Markdown (Überschriften, Listen, Tabellen)', async () => {
    const p = join(dateien, 'seite.html');
    await writeFile(p, '<html><head><title>Hausregeln</title><script>alert(1)</script></head><body><h1>Hausregeln</h1><p>Erster Absatz mit <strong>fett</strong>.</p><ul><li>Punkt eins</li><li>Punkt zwei</li></ul><table><tr><th>Wer</th><th>Was</th></tr><tr><td>Malte</td><td>Material</td></tr></table></body></html>');
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(r.quelle.kopf.titel).toBe('Hausregeln');
    expect(r.quelle.text).toContain('# Hausregeln');
    expect(r.quelle.text).toContain('**fett**');
    expect(r.quelle.text).toMatch(/- Punkt eins/);
    expect(r.quelle.text).toContain('| Malte | Material |');
    expect(r.quelle.text).not.toContain('alert');
  });

  it('PDF → Text mit Seitenüberschriften', async () => {
    const p = join(dateien, 'merkblatt.pdf');
    await writeFile(p, minimalPdf(['Absauganlage jeden Freitag leeren.', 'Filter monatlich wechseln.'], 'Merkblatt Absaugung'));
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(r.quelle.kopf.titel).toBe('Merkblatt Absaugung');
    expect(r.quelle.text).toContain('## Seite 1');
    expect(r.quelle.text).toContain('Absauganlage jeden Freitag leeren.');
    expect(r.quelle.text).toContain('Filter monatlich wechseln.');
    expect(existsSync(join(dir, r.quelle.pfad.replace('.md', '.orig.pdf')))).toBe(true);
    const treffer = await kern.suche(autor, 'Absauganlage Freitag');
    expect(treffer[0]?.pfad).toBe(r.quelle.pfad);
  });

  it('DOCX → Markdown', async () => {
    const p = join(dateien, 'anweisung.docx');
    await writeFile(p, await minimalDocx('Kantenanleimer', ['Vor dem Start 10 Minuten aufheizen.', 'Leimbecken abends leeren.']));
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(r.quelle.kopf.titel).toBe('Kantenanleimer');
    expect(r.quelle.text).toContain('# Kantenanleimer');
    expect(r.quelle.text).toContain('Leimbecken abends leeren.');
  });

  it('Upload unter Zufallsnamen: Endung und Titel aus dateiName', async () => {
    const p = join(dateien, 'upload-abc123');
    await writeFile(p, '# Pausenraum\n\nKaffeemaschine wird freitags entkalkt.\n');
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, dateiName: 'pausenraum.md', ...opt });
    expect(r.quelle.kopf.herkunft).toBe('pausenraum.md');
    expect(r.quelle.text).toContain('entkalkt');
  });

  it('Web-URL: Readability + Turndown, Original-HTML daneben', async () => {
    const srv = await testServer((_req, _b, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Pflege von Eichenholz</title></head><body><nav>Menü Start Kontakt</nav><main><article><h1>Pflege von Eichenholz</h1><p>${'Eiche wird mit Hartwachsöl gepflegt, zweimal im Jahr dünn auftragen. '.repeat(4)}</p><p>Überschüssiges Öl nach 20 Minuten abnehmen.</p></article></main><footer>Impressum</footer></body></html>`);
    });
    try {
      const r = await kern.fuegeHinzu(autor, { art: 'web', url: `${srv.url}/eiche`, ...opt });
      expect(r.quelle.kopf.art).toBe('web');
      expect(r.quelle.kopf.herkunft).toBe(`${srv.url}/eiche`);
      expect(r.quelle.kopf.titel).toBe('Pflege von Eichenholz');
      expect(r.quelle.text).toContain('Hartwachsöl');
      expect(r.quelle.text).not.toContain('Impressum');
      expect(existsSync(join(dir, r.quelle.pfad.replace('.md', '.orig.html')))).toBe(true);
    } finally {
      await srv.schliessen();
    }
  });

  it('Audio ohne whisper: „wartet auf Transkript“, keine Vorschläge', async () => {
    const p = join(dateien, 'sprachnotiz.m4a');
    await writeFile(p, Buffer.from([0, 1, 2, 3]));
    const r = await kern.fuegeHinzu(autor, { art: 'audio', dateiPfad: p, sammlung: 'test', sichtbarkeit: 'betrieb' });
    expect(r.quelle.kopf['transkript']).toBe('wartet');
    expect(r.quelle.text).toContain('Wartet auf Transkript');
    expect(r.vorschlaege).toEqual([]);
  });

  it('Audio mit konfiguriertem whisper-Programm', async () => {
    const skript = join(dateien, 'fake-whisper.sh');
    await writeFile(skript, '#!/bin/sh\necho "[00:00:00.000 --> 00:00:02.000]  Die Bandsäge ist ab Montag wieder frei."\n');
    await chmod(skript, 0o755);
    const k2 = await oeffne(tmp(), { whisper: { pfad: skript } });
    const a = await k2.benutzer.anlegen('Audio Autor', 'passwort-1', ['autor']);
    const p = join(dateien, 'bandsaege.wav');
    await writeFile(p, Buffer.from([9, 9, 9]));
    const r = await k2.fuegeHinzu(a, { art: 'audio', dateiPfad: p, ...opt });
    expect(r.quelle.kopf['transkript']).toBe('fertig');
    expect(r.quelle.text.trim()).toBe('Die Bandsäge ist ab Montag wieder frei.');
    await k2.schliesse();
  });

  it('gleicher Inhalt zweimal → keine Doppelung', async () => {
    const a = await kern.fuegeHinzu(autor, { art: 'text', inhalt: 'Einmaliger Inhalt 4711.', ...opt });
    const b = await kern.fuegeHinzu(autor, { art: 'text', inhalt: 'Einmaliger Inhalt 4711.', ...opt });
    expect(b.doppelt).toBe(true);
    expect(b.quelle.pfad).toBe(a.quelle.pfad);
  });

  it('neue Fassung derselben Datei ersetzt die alte in der Suche', async () => {
    const p = join(dateien, 'preise.txt');
    await writeFile(p, 'Furnierplatte Eiche kostet 80 Euro.');
    const alt = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    await writeFile(p, 'Furnierplatte Eiche kostet 95 Euro.');
    const neu = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt });
    expect(neu.quelle.kopf.ersetzt).toBe(alt.quelle.pfad);
    const t = await kern.suche(autor, 'Furnierplatte Eiche');
    expect(t.map((x) => x.pfad)).toContain(neu.quelle.pfad);
    expect(t.map((x) => x.pfad)).not.toContain(alt.quelle.pfad);
    // Datei der alten Fassung bleibt erhalten (Beständigkeit)
    expect(await readFile(join(dir, alt.quelle.pfad), 'utf8')).toContain('80 Euro');
    expect((await kern.listeQuellen(autor)).map((q) => q.pfad)).not.toContain(alt.quelle.pfad);
  });

  it('v1.4.1 U1: jeder andere Typ wird Anhang ohne Textauszug (Original daneben, kein Vorschlag aus Binärdaten)', async () => {
    const p = join(dateien, 'skizze.PNG');
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const r = await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: p, ...opt, kompilieren: false });
    expect(r.quelle.kopf).toMatchObject({ anhang: true, anhang_typ: 'bild', bytes: 8, herkunft: 'skizze.PNG' });
    expect(r.quelle.text).toMatch(/^Bild ohne Textauszug: skizze\.png/);
    expect(await readFile(join(dir, r.quelle.pfad.replace(/\.md$/, '.orig.png')))).toHaveLength(8);
    const z = join(dateien, 'archiv.zip');
    await writeFile(z, 'PK');
    expect((await kern.fuegeHinzu(autor, { art: 'datei', dateiPfad: z, ...opt, kompilieren: false })).quelle.kopf).toMatchObject({ anhang: true, anhang_typ: 'datei' });
  });

  it('leser darf nichts hinzufügen', async () => {
    const leser = await kern.benutzer.anlegen('Nur Lesen', 'passwort-1', ['leser']);
    await expect(kern.fuegeHinzu(leser, { art: 'text', inhalt: 'x y z', ...opt })).rejects.toMatchObject({ code: 'keine_rechte' });
  });
});
