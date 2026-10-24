/** Abnahmetests v1.4 Abschnitt 2 (Server-Teil) und 3.2/3.4 (Betrieb, Modus). */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { baueUmgebung, Client, type TestUmgebung } from './helfer.js';
import { erstelleApp, ladeKonfiguration, type User } from '../src/index.js';
import { istInternesNetz } from '../src/betrieb.js';
import { kuerzeIp } from '../src/protokoll.js';

const umgebungen: TestUmgebung[] = [];
async function umgebung(env: Record<string, string> = {}) { const u = await baueUmgebung(env); umgebungen.push(u); return u; }
afterEach(() => { while (umgebungen.length) umgebungen.pop()!.aufraeumen(); });
const BT = 'b'.repeat(40);
const userVon = async (u: TestUmgebung, r: keyof TestUmgebung['nutzer']): Promise<User> => (await u.kern.benutzer.liste()).find((x) => x.id === u.nutzer[r].id)!;
/** Anfrage wie aus dem internen Docker-Netz (Socket-Adresse über env.incoming). */
const intern = (u: TestUmgebung, pfad: string, init: RequestInit = {}, ip = '172.18.0.5') =>
  u.app.app.request(`http://kern.test${pfad}`, init, { incoming: { socket: { remoteAddress: ip } } });

describe('D-L5 Sicherheitsprotokoll', () => {
  it('Anmeldung, Fehlversuch, Passwort, Zugang erzeugen je genau eine Zeile; Frage und Suche keine', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser', 'falsch-falsch');
    await l.login('leser');
    await l.req('POST', '/api/ich/tokens', { json: {} });
    await l.req('POST', '/api/frage', { json: { frage: 'Urlaub?' } });
    await l.req('GET', '/api/suche?q=Urlaub');
    const dateien = fs.readdirSync(path.join(u.dir, '.kern/protokoll'));
    expect(dateien[0]).toMatch(/^sicherheit-\d{4}-\d{2}\.jsonl$/);
    const zeilen = fs.readFileSync(path.join(u.dir, '.kern/protokoll', dateien[0]!), 'utf8').trim().split('\n').map((z) => JSON.parse(z));
    expect(zeilen.map((z) => z.ereignis)).toEqual(['fehlversuch', 'anmeldung', 'zugang_erzeugt']);
    const roh = JSON.stringify(zeilen);
    expect(roh).not.toContain('Urlaub');
    expect(roh).not.toContain('leser'); // nur IDs, keine Namen beim Fehlversuch
    // nur admin liest
    expect((await l.req('GET', '/api/sicherheitsprotokoll')).status).toBe(403);
    const a = new Client(u.app.app);
    await a.login('admin');
    const p = await (await a.req('GET', '/api/sicherheitsprotokoll')).json();
    expect(p.length).toBe(4);
  });

  it('IP wird gekürzt', () => {
    expect(kuerzeIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(kuerzeIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
  });
});

describe('M3 und N7: Ablauf Pflicht, Sitzungen begrenzt und dauerhaft', () => {
  it('Zugang ohne Ablauf → 400, über 365 Tage → 400', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    expect((await l.req('POST', '/api/ich/tokens', { json: { gueltigTage: null } })).status).toBe(400);
    expect((await l.req('POST', '/api/ich/tokens', { json: { gueltigTage: 366 } })).status).toBe(400);
    expect(() => u.app.zugang.erzeuge({ id: 'x', name: 'x', rollen: ['leser'], teams: [] }, { art: 'mcp', gueltigSek: null })).toThrow();
  });

  it('21. Sitzung beendet die älteste', async () => {
    const u = await umgebung({ KERN_MAX_SITZUNGEN: '3' });
    const c = [new Client(u.app.app), new Client(u.app.app), new Client(u.app.app), new Client(u.app.app)];
    for (const x of c) { await x.login('autor'); await new Promise((r) => setTimeout(r, 5)); }
    expect((await c[0]!.req('GET', '/api/ich')).status).toBe(401);
    for (const x of c.slice(1)) expect((await x.req('GET', '/api/ich')).status).toBe(200);
  });

  it('Sitzung überlebt einen Neustart der App, wenn der Speicher dauerhaft ist (core); Ersatz: Tokens dauerhaft', async () => {
    const u = await umgebung();
    const { token } = u.app.erzeugeToken(await userVon(u, 'leser'));
    const neu = erstelleApp({ kern: u.kern, config: u.config });
    const r = await neu.app.request('http://kern.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    expect(r.status).toBe(200);
  });
});

describe('D-L13 Kennzeichnung KI', () => {
  it('REST- und MCP-Antwort tragen ki_erzeugt und modell', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    const a = await (await l.req('POST', '/api/frage', { json: { frage: 'Wann Urlaub beantragen?' } })).json();
    expect(a.ki_erzeugt).toBe(true);
    expect(a.modell.name).toBeTruthy();
    const { token } = u.app.erzeugeToken(await userVon(u, 'leser'));
    const m = await (await u.app.app.request('http://kern.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kern_frage', arguments: { frage: 'Urlaub?' } } }) })).json();
    expect(m.result.structuredContent.ki_erzeugt).toBe(true);
    expect(JSON.parse(m.result.content[0].text).modell).toBeTruthy();
  });
});

describe('O-1, 3.2, 3.4: /_betrieb/* und Modus', () => {
  it('ohne KERN_BETRIEB_TOKEN gibt es /_betrieb nicht; von außen oder über den Proxy 404; falsches Token 401', async () => {
    const ohne = await umgebung();
    expect((await intern(ohne, '/_betrieb/status')).status).toBe(404);
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    expect((await intern(u, '/_betrieb/status', { headers: { authorization: `Bearer ${BT}` } }, '203.0.113.9')).status).toBe(404);
    expect((await intern(u, '/_betrieb/status', { headers: { authorization: `Bearer ${BT}`, 'x-forwarded-for': '1.2.3.4' } })).status).toBe(404);
    expect((await intern(u, '/_betrieb/status', { headers: { authorization: 'Bearer falsch' } })).status).toBe(401);
    const s = await intern(u, '/_betrieb/status', { headers: { authorization: `Bearer ${BT}` } });
    expect(s.status).toBe(200);
    const j = await s.json();
    expect(j).toMatchObject({ modus: 'normal', nutzer: 4, artikel: 1, quellen: 1 });
    // nur Zahlen: keine Titel, keine Benutzernamen
    expect(JSON.stringify(j)).not.toMatch(/Urlaub|Handbuch|admin"|leser/);
    // Betriebs-Token öffnet keine /api- oder /mcp-Route
    expect((await intern(u, '/api/ich', { headers: { authorization: `Bearer ${BT}` } })).status).toBe(401);
    expect((await intern(u, '/mcp', { method: 'POST', headers: { authorization: `Bearer ${BT}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });

  it('nur_lesen: Schreiben 423, Anmelden und Fragen (ohne KI) gehen; pausiert: nur Hinweis', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    const auth = { authorization: `Bearer ${BT}`, 'content-type': 'application/json' };
    expect((await intern(u, '/_betrieb/modus', { method: 'POST', headers: auth, body: JSON.stringify({ modus: 'nur_lesen' }) })).status).toBe(200);
    const a = new Client(u.app.app);
    expect((await a.login('autor')).status).toBe(200);
    const v = await a.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel: 'wissen/x.md', neu: '# x', grund: 'Test' } });
    expect(v.status).toBe(423);
    expect((await v.json()).code).toBe('nur_lesen');
    const f = await (await a.req('POST', '/api/frage', { json: { frage: 'Urlaub' } })).json();
    expect(f.ki_erzeugt).toBe(false);
    expect((await a.req('GET', '/api/wissen')).status).toBe(200);
    expect((await intern(u, '/_betrieb/modus', { method: 'POST', headers: auth, body: JSON.stringify({ modus: 'pausiert' }) })).status).toBe(200);
    expect((await a.req('GET', '/api/wissen')).status).toBe(503);
    expect((await u.app.app.request('http://kern.test/healthz')).status).toBe(200);
    // Zustand überlebt einen Neustart
    const neu = erstelleApp({ kern: u.kern, config: u.config });
    expect((await neu.app.request('http://kern.test/api/wissen')).status).toBe(503);
  });

  it('Grenzen: nutzer_max → 409, Einladung mit Einmalpasswort und Pflicht zum Wechsel', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    const auth = { authorization: `Bearer ${BT}`, 'content-type': 'application/json' };
    const e = await intern(u, '/_betrieb/einladung', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'chefin' }) });
    expect(e.status).toBe(201);
    const { einmalPasswort, benutzer_id } = await e.json();
    expect(benutzer_id).toBeTruthy();
    const n = new Client(u.app.app);
    expect((await (await n.login('chefin', einmalPasswort)).json()).mussPasswortAendern).toBe(true);
    expect((await intern(u, '/_betrieb/grenzen', { method: 'POST', headers: auth, body: JSON.stringify({ nutzer_max: 5 }) })).status).toBe(200);
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('POST', '/api/benutzer', { json: { name: 'sechs', passwort: 'lang-genug-123' } })).status).toBe(409);
    expect((await intern(u, '/_betrieb/einladung', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'sieben' }) })).status).toBe(409);
  });

  it('internes Netz erkennen', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.18.0.2', '192.168.1.1', '::1', '::ffff:10.0.0.1', 'fd00::1']) expect(istInternesNetz(ip)).toBe(true);
    for (const ip of ['203.0.113.5', '8.8.8.8', '2001:db8::1', undefined]) expect(istInternesNetz(ip)).toBe(false);
  });
});

describe('v1.4 Umgebungsnamen', () => {
  it('KERN_MANAGED=1 und KERN_TRUST_PROXY_HOPS', async () => {
    const u = await umgebung();
    const c = ladeKonfiguration({ dataDir: u.dir, env: { KERN_SECRET: 'x'.repeat(40), KERN_MANAGED: '1', KERN_TRUST_PROXY_HOPS: '2' } });
    expect(c.modus).toBe('managed');
    expect(c.proxyHops).toBe(2);
    expect(c.secureCookie).toBe(true);
  });
});

describe('5.2 KI-Schlüssel und 3.5 Konto-Brücke', () => {
  const GS = 'g'.repeat(40);
  it('Schlüssel nur schreiben, verschlüsselt, Managed nur Listen-Anbieter, wirkt nach Neustart nur an der Listenadresse', async () => {
    const u = await umgebung({ KERN_MODUS: 'managed', KERN_GEHEIMNIS_SCHLUESSEL: GS, KERN_PUBLIC_URL: 'https://k.example' });
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('PUT', '/api/einstellungen/ki-schluessel', { json: { anbieter: 'boese', schluessel: 'sk-1234567890' } })).status).toBe(400);
    const r = await a.req('PUT', '/api/einstellungen/ki-schluessel', { json: { anbieter: 'mistral', schluessel: 'sk-geheim-1234567890' } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain('sk-geheim');
    expect(fs.readFileSync(path.join(u.dir, '.kern/geheimnisse.json'), 'utf8')).not.toContain('sk-geheim');
    const e = await (await a.req('GET', '/api/einstellungen')).json();
    expect(e.ki_schluessel_gespeichert).toEqual(['mistral']);
    expect(JSON.stringify(e)).not.toContain('sk-geheim');
    await a.req('PUT', '/api/einstellungen', { json: { provider: { anbieter: 'mistral' } } });
    const neu = ladeKonfiguration({ dataDir: u.dir, env: { KERN_SECRET: 'x'.repeat(40), KERN_MODUS: 'managed', KERN_GEHEIMNIS_SCHLUESSEL: GS } });
    expect((neu.kern.provider as { apiKey: string; url: string }).apiKey).toBe('sk-geheim-1234567890');
    expect((neu.kern.provider as { url: string }).url).toBe('https://api.mistral.ai/v1');
    // falscher Geheimnis-Schlüssel → nichts entschlüsselbar
    const falsch = ladeKonfiguration({ dataDir: u.dir, env: { KERN_SECRET: 'x'.repeat(40), KERN_MODUS: 'managed', KERN_GEHEIMNIS_SCHLUESSEL: 'h'.repeat(40) } });
    expect((falsch.kern.provider as { apiKey: string }).apiKey).toBe('');
    const l = new Client(u.app.app);
    await l.login('leser');
    expect((await l.req('PUT', '/api/einstellungen/ki-schluessel', { json: { anbieter: 'mistral', schluessel: 'sk-1234567890' } })).status).toBe(403);
  });

  it('ohne KERN_GEHEIMNIS_SCHLUESSEL → 409; ohne Leitstand /api/konto → 404', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('PUT', '/api/einstellungen/ki-schluessel', { json: { anbieter: 'eigen', schluessel: 'sk-1234567890' } })).status).toBe(409);
    expect((await a.req('GET', '/api/konto')).status).toBe(404);
  });

  it('Konto-Brücke reicht an /v1/konto weiter, mit Konto-Token und Idempotency-Key', async () => {
    const http = await import('node:http');
    const gesehen: { pfad?: string; auth?: string; idem?: string } = {};
    const ls = http.createServer((q, s) => { gesehen.pfad = q.url; gesehen.auth = q.headers.authorization; gesehen.idem = q.headers['idempotency-key'] as string; s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ status: 'test', kuendigung_zum: null })); });
    await new Promise<void>((r) => ls.listen(0, '127.0.0.1', () => r()));
    const port = (ls.address() as { port: number }).port;
    try {
      const u = await umgebung({ KERN_LEITSTAND_URL: `http://127.0.0.1:${port}`, KERN_KONTO_TOKEN: 'konto-token-123' });
      const a = new Client(u.app.app);
      await a.login('admin');
      expect((await (await a.req('GET', '/api/konto')).json()).status).toBe('test');
      expect(gesehen.auth).toBe('Bearer konto-token-123');
      expect((await a.req('POST', '/api/konto/kuendigen', { json: {} })).status).toBe(200);
      expect(gesehen.pfad).toBe('/v1/konto/kuendigen');
      expect(gesehen.idem).toBeTruthy();
      expect((await a.req('POST', '/api/konto/irgendwas', { json: {} })).status).toBe(404);
      const l = new Client(u.app.app);
      await l.login('leser');
      expect((await l.req('GET', '/api/konto')).status).toBe(403);
    } finally { ls.close(); }
  });
});
