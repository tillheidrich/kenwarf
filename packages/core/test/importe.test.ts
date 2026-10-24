import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { aufraeumen, oeffne, testServer, tmp } from './helfer.js';

let kern: Kern;
let a: User;
beforeAll(async () => {
  kern = await oeffne(tmp());
  a = await kern.benutzer.anlegen('Imp Admin', 'passwort-1', ['admin']);
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

async function ordner(dateien: Record<string, string>): Promise<string> {
  const d = tmp('import-');
  for (const [p, s] of Object.entries(dateien)) {
    await mkdir(join(d, p, '..'), { recursive: true });
    await writeFile(join(d, p), s);
  }
  return d;
}

describe('importiere', () => {
  it('obsidian: [[Links]] werden Text, Anhänge übersprungen, immer Quellen + Vorschläge', async () => {
    const d = await ordner({
      'Werkstatt/Bandsäge.md': '---\ntags: [maschine]\n---\n# Bandsäge\n\nSägeband wechseln siehe [[Wartung#Bänder|Wartungsplan]] und [[Ersatzteile]].\n',
      'Wartung.md': '# Wartung\n\nJeden Freitag Späne absaugen.\n',
      'bild.png': 'PNG',
      '.obsidian/app.json': '{}',
    });
    const r = await kern.importiere(a, { art: 'obsidian', pfad: d });
    expect(r.quellen.map((q) => q.kopf.titel).sort()).toEqual(['Bandsäge', 'Wartung']);
    const b = r.quellen.find((q) => q.kopf.titel === 'Bandsäge')!;
    expect(b.text).toContain('siehe Wartungsplan und Ersatzteile.');
    expect(b.kopf.sammlung).toBe('import-obsidian');
    expect(r.uebersprungen).toContain('bild.png');
    expect(r.vorschlaege.length).toBe(2);
    expect(await kern.listeWissen(a)).toHaveLength(0);
  });

  it('notion: Kennungen am Dateinamen entfernt', async () => {
    const d = await ordner({ 'Handbuch 0123456789abcdef0123456789abcdef.md': '# Handbuch\n\nDas Büro öffnet um 7 Uhr.\n' });
    const r = await kern.importiere(a, { art: 'notion', pfad: d, kompilieren: false });
    expect(r.quellen[0]!.kopf.titel).toBe('Handbuch');
    expect(r.quellen[0]!.kopf.herkunft).toBe('Handbuch.md');
  });

  it('confluence: HTML-Export, index.html übersprungen', async () => {
    const d = await ordner({ 'index.html': '<html><body>Übersicht</body></html>', 'Montage_123.html': '<html><head><title>Montage | Wiki</title></head><body><h1>Montage</h1><p>Zargen am Vortag lackieren.</p></body></html>' });
    const r = await kern.importiere(a, { art: 'confluence', pfad: d, kompilieren: false });
    expect(r.quellen).toHaveLength(1);
    expect(r.quellen[0]!.text).toContain('Zargen am Vortag lackieren.');
    expect(r.uebersprungen).toContain('index.html');
  });

  it('markdown/outline: einfacher Ordner', async () => {
    const d = await ordner({ 'a/eins.md': '# Eins\n\nText eins für den Outline-Import.\n' });
    const r = await kern.importiere(a, { art: 'outline', pfad: d, kompilieren: false });
    expect(r.quellen[0]!.kopf.sammlung).toBe('import-outline');
  });
});

describe('beobachteQuellen', () => {
  it('neue Fassung bei Änderung, unverändert ohne Änderung, robots.txt und Sperren werden gemeldet, nicht umgangen', async () => {
    let fassung = 1;
    const srv = await testServer((req, _b, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('User-agent: *\nDisallow: /privat\n');
      }
      if (req.url === '/gesperrt') {
        res.writeHead(403);
        return res.end('nein');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><head><title>Lieferbedingungen</title></head><body><main><h1>Lieferbedingungen</h1><p>${'Lieferzeit für Beschläge beträgt derzeit '.repeat(3)}${req.url === '/liefer' && fassung === 2 ? 'vier' : 'zwei'} Wochen (${req.url}).</p></main></body></html>`);
    });
    try {
      const k = await oeffne(tmp());
      const u = await k.benutzer.anlegen('Beob Autor', 'passwort-1', ['autor']);
      const q1 = await k.fuegeHinzu(u, { art: 'web', url: `${srv.url}/liefer`, sammlung: 'lieferanten', sichtbarkeit: 'betrieb', beobachten: true, kompilieren: false });
      const q2 = await k.fuegeHinzu(u, { art: 'web', url: `${srv.url}/gesperrt-erst-spaeter`, sammlung: 'lieferanten', sichtbarkeit: 'betrieb', beobachten: true, kompilieren: false });
      // Quelle unter /privat (robots) künstlich anlegen: Kopf direkt setzen
      const { readFile } = await import('node:fs/promises');
      const p3 = join(k.dir, 'quellen/2026/privat.md');
      await writeFile(p3, (await readFile(join(k.dir, q2.quelle.pfad), 'utf8')).replace(`${srv.url}/gesperrt-erst-spaeter`, `${srv.url}/privat/seite`).replace(/titel: .*/, 'titel: Privat'));
      const p4 = join(k.dir, 'quellen/2026/gesperrt.md');
      await writeFile(p4, (await readFile(join(k.dir, q2.quelle.pfad), 'utf8')).replace(`${srv.url}/gesperrt-erst-spaeter`, `${srv.url}/gesperrt`).replace(/titel: .*/, 'titel: Gesperrt'));
      await k.uebernimmAenderungen();

      fassung = 2;
      const r = await k.beobachteQuellen();
      expect(r.geprueft).toBe(4);
      expect(r.neu).toHaveLength(1);
      expect(r.neu[0]!.quelle.kopf.ersetzt).toBe(q1.quelle.pfad);
      expect(r.neu[0]!.quelle.text).toContain('vier Wochen');
      expect(r.neu[0]!.vorschlaege.length).toBe(1);
      expect(r.unveraendert).toContain(q2.quelle.pfad);
      const na = Object.fromEntries(r.nicht_abrufbar.map((x) => [x.pfad, x.grund]));
      expect(na['quellen/2026/privat.md']).toMatch(/robots\.txt/);
      expect(na['quellen/2026/gesperrt.md']).toMatch(/sperrt den Abruf \(403\)/);
      expect(await k.beobachtungsIntervallMs()).toBe(24 * 3600_000);
      await k.schliesse();
    } finally {
      await srv.schliessen();
    }
  });
});

describe('datenweg', () => {
  it('mock: nichts verlässt den Rechner', () => {
    const d = kern.datenweg();
    expect(d.chat.anbieter).toBe('mock');
    expect(d.vektoren).toBe(false);
    expect(d.embeddings).toBeNull();
    expect(d.hinweis).toMatch(/keine Daten/);
  });
  it('Mistral (EU) und Ollama lokal', async () => {
    const k = await oeffne(tmp(), { provider: { art: 'openai', url: 'https://api.mistral.ai/v1', apiKey: 'x', chatModell: 'mistral-large-latest', embedModell: 'mistral-embed' }, providerInstanz: undefined } as never);
    const d = k.datenweg();
    expect(d.chat).toMatchObject({ anbieter: 'openai-kompatibel', region: 'EU (Mistral AI, Frankreich)', modell: 'mistral-large-latest' });
    expect(d.embeddings?.modell).toBe('mistral-embed');
    expect(d.daten.join(' ')).toMatch(/Indizieren/);
    await k.schliesse().catch(() => undefined);
  });
});
