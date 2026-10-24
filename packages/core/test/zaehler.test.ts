import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchKi, kiDispatcher, proxyDispatcher } from '../src/netz.js';
import { aufraeumen, benutzerSatz, oeffne } from './helfer.js';

afterAll(() => aufraeumen());

describe('v1.4 3.4: Verbrauchszähler und Nutzung ohne Personenbezug', () => {
  it('zählt KI-Aufrufe mit Preis je Tag und Monat, Ereignisse ohne Inhalte', async () => {
    const kern = await oeffne(undefined, { kiPreis: { ein: 100_000, aus: 300_000 } });
    const b = await benutzerSatz(kern);
    expect((await kern.verbrauch()).aufrufe_heute).toBe(0);
    await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Hobel', inhalt: 'Hobelmesser werden alle 40 Stunden gewechselt.', sammlung: 'w', sichtbarkeit: 'betrieb', kompilieren: false });
    await kern.frage(b.leser, 'Wann werden Hobelmesser gewechselt?');
    const v = await kern.verbrauch();
    expect(v.monat).toBe('2026-10');
    expect(v.aufrufe_heute).toBeGreaterThanOrEqual(1);
    expect(v.tokens_monat.ein).toBeGreaterThan(0);
    expect(v.cent_heute).toBeGreaterThan(0);
    expect(v.cent_monat).toBe(v.cent_heute);
    expect(v.preis_bekannt).toBe(true);
    expect(kern.zaehler.ereignisse('2026-10-01', '2026-10-31')['antwort_belegt']).toBe(1);
    // Schema enthält keine Personen, Fragen oder Pfade
    expect(kern.zaehler.spalten().join(' ')).not.toMatch(/user|nutzer|benutzer|frage|pfad|titel/);
    const n = await kern.nutzung();
    expect(n).toMatchObject({ artikel: 0, quellen: 1, nutzer: 5 });
    expect(n.speicher_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(n)).not.toContain('Hobel');
    await kern.schliesse();
  });

  it('gemeinsamer Proxy-Dispatcher: nur mit Proxy, nie für Loopback, NO_PROXY gilt', () => {
    const p = { httpProxy: 'http://proxy:3128', httpsProxy: 'http://proxy:3128', noProxy: 'intern.example' };
    expect(proxyDispatcher('https://api.mistral.ai/v1', null)).toBeUndefined();
    expect(proxyDispatcher('https://api.mistral.ai/v1', p)).toBeDefined();
    expect(proxyDispatcher('http://127.0.0.1:11434', p)).toBeUndefined();
    expect(proxyDispatcher('http://localhost:11434', p)).toBeUndefined();
    expect(proxyDispatcher('https://ki.intern.example/v1', p)).toBeUndefined();
  });

  it('KI-Abrufe bevorzugen KERN_KI_PROXY (Kanal .ki) mit Zugangsdaten, sonst HTTP(S)_PROXY', async () => {
    expect(kiDispatcher('http://127.0.0.1:11434', 'http://a.ki:t@proxy:3128')).toBeUndefined();
    expect(kiDispatcher('https://api.mistral.ai/v1', 'http://a.ki:t@proxy:3128')).toBeDefined();
    const gesehen: { url: string; auth: string }[] = [];
    const proxy: Server = createServer((req, res) => { gesehen.push({ url: req.url ?? '', auth: String(req.headers['proxy-authorization'] ?? '') }); res.end('{}'); });
    proxy.on('connect', (req, sock) => { gesehen.push({ url: req.url ?? '', auth: String(req.headers['proxy-authorization'] ?? '') }); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const port = (proxy.address() as { port: number }).port;
    const alt = process.env['KERN_KI_PROXY'];
    process.env['KERN_KI_PROXY'] = `http://inst1.ki:geheim@127.0.0.1:${port}`;
    try {
      await fetchKi('http://ki-anbieter.invalid/v1/chat/completions', { method: 'POST', body: '{}' }).then((r) => r.text()).catch(() => '');
      expect(gesehen[0]?.url).toMatch(/ki-anbieter\.invalid/);
      expect(gesehen[0]?.auth).toBe(`Basic ${Buffer.from('inst1.ki:geheim').toString('base64')}`);
    } finally {
      if (alt === undefined) delete process.env['KERN_KI_PROXY']; else process.env['KERN_KI_PROXY'] = alt;
      await new Promise((r) => proxy.close(r));
    }
  });
});
