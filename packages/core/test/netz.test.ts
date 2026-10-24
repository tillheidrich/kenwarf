import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { istGesperrt, sichererAbruf } from '../src/netz.js';
import { aufraeumen, benutzerSatz, oeffne, testServer } from './helfer.js';

let srv: Awaited<ReturnType<typeof testServer>>;
let port = 0;
beforeAll(async () => {
  srv = await testServer((req, _b, res) => {
    if (req.url === '/gross') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200_000));
    } else if (req.url?.startsWith('/weiter?')) {
      res.writeHead(302, { location: decodeURIComponent(req.url.slice(8)) });
      res.end();
    } else if (req.url === '/kette') {
      res.writeHead(302, { location: '/kette' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Ok</title></head><body><main><p>Hallo Welt.</p></main></body></html>');
    }
  });
  port = Number(new URL(srv.url).port);
});
afterAll(async () => {
  await srv.schliessen();
  aufraeumen();
});

const lokal = { erlaubeAdressen: ['127.0.0.1'], erlaubtePorts: 'alle' as const, proxy: null };

describe('Schutzschicht für Web-Abrufe (S1 H1)', () => {
  it('sperrt Loopback, private, Link-Local, Metadaten, ULA und IPv6-Verpackungen', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '224.0.0.1', 'kein-ip'])
      expect(istGesperrt(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '93.184.216.34', '2a01:4f8::1', '2606:4700:4700::1111']) expect(istGesperrt(ip), ip).toBe(false);
  });

  it('lehnt interne Ziele ab, auch per Name, mit Port und nach Weiterleitung', async () => {
    await expect(sichererAbruf(`${srv.url}/`, { proxy: null, erlaubtePorts: 'alle' })).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf('http://169.254.169.254/latest/meta-data/', { proxy: null })).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf('http://[::1]/', { proxy: null })).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf('http://10.0.0.5/', { proxy: null })).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf('http://intern.example/', { proxy: null, aufloesen: async () => ['93.184.216.34', '10.0.0.7'] })).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf('http://public.example:8080/', { proxy: null, aufloesen: async () => ['93.184.216.34'] })).rejects.toMatchObject({ grund: 'port' });
    await expect(sichererAbruf('ftp://x.example/', { proxy: null })).rejects.toMatchObject({ grund: 'adresse' });
    await expect(sichererAbruf('http://a:b@x.example/', { proxy: null })).rejects.toMatchObject({ grund: 'adresse' });
    // Weiterleitung vom erlaubten Server auf intern
    for (const ziel of ['http://169.254.169.254/', 'http://10.0.0.1/', 'http://[::1]:80/', `http://127.0.0.2:${port}/`])
      await expect(sichererAbruf(`${srv.url}/weiter?${encodeURIComponent(ziel)}`, lokal), ziel).rejects.toMatchObject({ grund: 'gesperrt' });
    await expect(sichererAbruf(`${srv.url}/kette`, lokal)).rejects.toMatchObject({ grund: 'weiterleitung' });
  });

  it('erlaubter Abruf, Größengrenze beim Lesen', async () => {
    const r = await sichererAbruf(`${srv.url}/seite`, lokal);
    expect(r.status).toBe(200);
    expect(r.text()).toContain('Hallo Welt');
    await expect(sichererAbruf(`${srv.url}/gross`, { ...lokal, maxBytes: 100_000 })).rejects.toMatchObject({ grund: 'zu_gross' });
    const w = await sichererAbruf(`${srv.url}/weiter?${encodeURIComponent('/seite')}`, lokal);
    expect(w.url).toBe(`${srv.url}/seite`);
  });

  it('geht über den Egress-Proxy, wenn HTTP(S)_PROXY gesetzt ist; eigene Prüfungen gelten weiter', async () => {
    const gesehen: string[] = [];
    // Egress-Proxy wie squid: CONNECT-Tunnel; dahinter antwortet der Test selbst als Zielserver
    const ziel: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('über den Proxy');
    });
    const proxy: Server = createServer((req, res) => {
      gesehen.push(req.url ?? '');
      ziel.emit('request', req, res);
    });
    proxy.on('connect', (req, sock) => {
      gesehen.push(req.url ?? '');
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      ziel.emit('connection', sock);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const pport = (proxy.address() as { port: number }).port;
    try {
      const opt = { proxy: { httpProxy: `http://127.0.0.1:${pport}` } };
      // Name löst lokal nicht auf (abgeschottetes Netz): der Proxy entscheidet
      const r = await sichererAbruf('http://kern-test.invalid/seite', opt);
      expect(r.text()).toBe('über den Proxy');
      expect(gesehen[0]).toMatch(/kern-test\.invalid/);
      // interne Ziele sperrt Kern selbst, bevor der Proxy gefragt wird
      await expect(sichererAbruf('http://169.254.169.254/', opt)).rejects.toMatchObject({ grund: 'gesperrt' });
      await expect(sichererAbruf('http://intern.example/', { ...opt, aufloesen: async () => ['192.168.0.10'] })).rejects.toMatchObject({ grund: 'gesperrt' });
      expect(gesehen).toHaveLength(1);
      // Umgebungsvariable wird gelesen, wenn nichts übergeben ist
      const alt = { h: process.env['HTTP_PROXY'], hs: process.env['HTTPS_PROXY'], n: process.env['NO_PROXY'] };
      process.env['HTTP_PROXY'] = `http://127.0.0.1:${pport}`;
      delete process.env['NO_PROXY'];
      try {
        expect((await sichererAbruf('http://kern-test2.invalid/')).text()).toBe('über den Proxy');
      } finally {
        for (const [k, v] of [['HTTP_PROXY', alt.h], ['HTTPS_PROXY', alt.hs], ['NO_PROXY', alt.n]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    } finally {
      await new Promise((r) => proxy.close(r));
    }
  });

  it('fuegeHinzu und Quellenbeobachtung nutzen die Schutzschicht', async () => {
    const kern = await oeffne(undefined, { netz: { proxy: null, erlaubtePorts: 'alle' } });
    const b = await benutzerSatz(kern);
    await expect(kern.fuegeHinzu(b.autor, { art: 'web', url: `${srv.url}/seite`, sammlung: 'x', sichtbarkeit: 'betrieb', kompilieren: false })).rejects.toMatchObject({ code: 'ungueltig', grund: 'gesperrt' });
    await kern.schliesse();
  });
});
