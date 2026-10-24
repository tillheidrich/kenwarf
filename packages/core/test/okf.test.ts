import { afterAll, describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkdown } from '../src/util.js';
import { aufraeumen, oeffne, seedKern, tmp } from './helfer.js';

afterAll(() => aufraeumen());

async function alleDateien(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await alleDateien(dir, p)));
    else out.push(p);
  }
  return out.sort();
}

/** Vergleichbar machen: Zeitstempel der Freigabe (verified, stand) und Protokolle ausblenden. */
function ohneZeit(inhalt: string): string {
  const p = parseMarkdown(inhalt);
  const k = { ...p.kopf };
  delete k['verified'];
  delete k['stand'];
  delete k['erfasst_von']; // S1 M7: Import setzt den Importierenden
  return JSON.stringify(k) + '\n' + p.text;
}

describe('OKF v0.2', () => {
  it('Export ist konform: type überall, okf_version im Wurzel-index, OKF-Felder, Fußnoten-Quellen', async () => {
    const { kern, u } = await seedKern();
    const ziel = tmp('okf-');
    const r = await kern.exportiereOkf(ziel);
    expect(r.dateien).toBeGreaterThan(30);
    const dateien = await alleDateien(ziel);
    expect(dateien).toContain('index.md');
    expect(await readFile(join(ziel, 'index.md'), 'utf8')).toMatch(/^---\nokf_version: "0\.2"\n---/);
    for (const d of dateien.filter((x) => x.endsWith('.md') && !x.endsWith('index.md') && !x.endsWith('log.md') && !x.includes('.orig.'))) {
      const k = parseMarkdown(await readFile(join(ziel, d), 'utf8')).kopf;
      expect(typeof k['type'], d).toBe('string');
    }
    const fb = parseMarkdown(await readFile(join(ziel, 'wissen/betrieb/zahlen-und-fristen.md'), 'utf8')).kopf as Record<string, any>;
    expect(fb['title']).toBe('Zahlen und Fristen');
    expect(fb['status']).toBe('stable');
    expect(fb['kern_status']).toBe('freigegeben');
    expect(fb['stale_after']).toBe('2026-12-31T00:00:00Z');
    expect(fb['sources'][0]).toMatchObject({ id: 'f1', resource: '/quellen/2026/preisblatt-und-fristen-2026.md', title: 'Preisblatt und Fristen 2026' });
    // private Notiz nicht im Export
    expect(dateien).not.toContain('wissen/notizen/merkliste-malte.md');
    // Original der Quelle mit exportiert
    expect(dateien).toContain('quellen/2026/preisblatt-und-fristen-2026.orig.txt');
    await kern.schliesse();
    void u;
  });

  it('Rundlauf: Export → Import (nur Quellen + Vorschläge) → Freigabe → Export ergibt dieselben Dateien (außer Zeitstempeln)', async () => {
    const { kern } = await seedKern();
    const a = tmp('okf-a-');
    await kern.exportiereOkf(a);
    await kern.schliesse();

    const ziel = await oeffne(tmp('kern-import-'));
    const admin = await ziel.benutzer.anlegen('Import Admin', 'passwort-1', ['admin'], ['werkstatt', 'buero']);
    const imp = await ziel.importiereOkf(admin, a);
    // Import schreibt nie direkt ins Wissen
    expect(await ziel.listeWissen(admin)).toHaveLength(0);
    expect(imp.quellen.length).toBe(4);
    expect(imp.vorschlaege.length).toBeGreaterThan(20);
    // Vorschlag enthält exakt die ursprüngliche Datei
    const orig = await readFile(join(a, 'wissen/betrieb/zahlen-und-fristen.md'), 'utf8');
    const vz = imp.vorschlaege.find((v) => v.ziel === 'wissen/betrieb/zahlen-und-fristen.md')!;
    expect(parseMarkdown(vz.neu).kopf['fakten']).toEqual(parseMarkdown(orig).kopf['fakten']);
    for (const v of imp.vorschlaege) await ziel.entscheide(admin, v.id, { aktion: 'freigeben' });

    const b = tmp('okf-b-');
    await ziel.exportiereOkf(b);
    const da = (await alleDateien(a)).filter((x) => !x.endsWith('log.md'));
    const db = (await alleDateien(b)).filter((x) => !x.endsWith('log.md'));
    expect(db).toEqual(da);
    for (const d of da) {
      const x = await readFile(join(a, d), 'utf8');
      const y = await readFile(join(b, d), 'utf8');
      if (d.endsWith('.md')) expect(ohneZeit(y), d).toBe(ohneZeit(x));
      else expect(y, d).toBe(x);
    }
    // Fakten bleiben abfragbar
    expect((await ziel.fakten(admin, { gegenstand: 'Zahlungsziel' }))[0]?.wert).toBe(14);
    await ziel.schliesse();
  });

  it('fremdes OKF-Bündel wird Quelle + kompilierter Vorschlag, unbekannte Felder bleiben im Original', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const fremd = tmp('okf-fremd-');
    await mkdir(join(fremd, 'docs'), { recursive: true });
    await writeFile(join(fremd, 'index.md'), '---\nokf_version: "0.2"\n---\n# Fremd\n');
    await writeFile(join(fremd, 'docs/leimholz.md'), '---\ntype: Guide\ntitle: Leimholz lagern\nx_firma: 42\n---\n\n# Leimholz lagern\n\nLeimholz liegt flach auf Kanthölzern, nie stehend.\n');
    const k = await oeffne(tmp());
    const a = await k.benutzer.anlegen('Fremd Admin', 'passwort-1', ['admin']);
    const r = await k.importiere(a, { art: 'okf', pfad: fremd });
    expect(r.quellen).toHaveLength(1);
    expect(r.quellen[0]!.kopf.titel).toBe('Leimholz lagern');
    expect(r.vorschlaege).toHaveLength(1);
    const orig = await k.original(a, r.quellen[0]!.pfad);
    expect(await readFile(orig!.datei, 'utf8')).toContain('x_firma: 42');
    await k.schliesse();
  });
});
