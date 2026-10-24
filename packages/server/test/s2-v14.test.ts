/**
 * v1.4 Abschnitte 3.4, 3.7, 4.1, 5.1, 6.1, 7, 8, 9 (Server-Teil, Agent S2).
 * Läuft gegen die Attrappe mit den mit C1 abgestimmten Signaturen; die Integration mit echtem core steht in
 * core-integration.test.ts (übersprungen, solange core/dist fehlt).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { baueUmgebung, Client, type TestUmgebung } from './helfer.js';
import { erstelleApp, f12Hinweis, installiereEgress, bauAbruf, proxyAusUmgebung, FakeKern, type KernLike } from '../src/index.js';

const umgebungen: TestUmgebung[] = [];
async function umgebung(env: Record<string, string> = {}) { const u = await baueUmgebung(env); umgebungen.push(u); return u; }
afterEach(() => { while (umgebungen.length) umgebungen.pop()!.aufraeumen(); });
const BT = 'b'.repeat(40);
const intern = (u: TestUmgebung, pfad: string, init: RequestInit = {}) =>
  u.app.app.request(`http://kern.test${pfad}`, init, { incoming: { socket: { remoteAddress: '172.18.0.5' } } });
const fake = (u: TestUmgebung) => u.kern as unknown as FakeKern;
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function bisFertig<T>(f: () => Promise<T>, ok: (x: T) => boolean, ms = 3000): Promise<T> {
  const ende = Date.now() + ms;
  for (;;) { const x = await f(); if (ok(x) || Date.now() > ende) return x; await warte(20); }
}
/** Kern ohne bestimmte Methoden (für die 501-Wege). */
const ohne = (k: KernLike, namen: string[]): KernLike => new Proxy(k, { get: (t, p, r) => (namen.includes(String(p)) ? undefined : Reflect.get(t, p, r)) });
/** Frische Einrichtung: Zustand löschen und App neu bauen. */
function neuEinrichten(u: TestUmgebung, kern: KernLike = u.kern) {
  fs.rmSync(path.join(u.dir, '.kern/einrichtung.json'), { force: true });
  fs.rmSync(path.join(u.dir, 'wissen'), { recursive: true, force: true });
  fs.rmSync(path.join(u.dir, 'quellen'), { recursive: true, force: true });
  return erstelleApp({ kern, config: u.config });
}

describe('GET /api/ich und /api/einstellungen (Annahmen W2 1, 2, 4)', () => {
  it('ich: Benutzerfelder oben, Modus, Produkt, Kontingent; Login ebenso', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    const l = await (await a.login('admin')).json();
    expect(l.id).toBe(u.nutzer.admin.id);
    expect(l.benutzer.id).toBe(u.nutzer.admin.id);
    const i = await (await a.req('GET', '/api/ich')).json();
    expect(i).toMatchObject({ id: u.nutzer.admin.id, name: 'admin', modus: 'normal', produkt: { name: 'Kern' }, konto_verfuegbar: false });
    expect(i.kontingent).toEqual({ ki: null, speicher: null });
    expect(i.ki.status).toBe('ohne_ki');
  });

  it('einstellungen: ki-Status und Voreinstellungen; Managed nur Listeneinträge, keine lokale KI', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    await a.login('admin');
    const e = await (await a.req('GET', '/api/einstellungen')).json();
    expect(e.ki).toEqual({ status: 'ohne_ki', weg: null, voreinstellung: null, vorher: false });
    expect(e.voreinstellungen.map((v: { id: string }) => v.id)).toEqual(expect.arrayContaining(['mistral', 'ollama', 'anthropic']));
    expect(e.voreinstellungen.some((v: { id: string }) => v.id === 'hd_test')).toBe(false);
    expect(e.oauth.nur_bekannte_apps).toBe(false);
    expect(e.sammlungen[0]).toBe('allgemein');
    // Betriebs-Token nur als Hash in der Umgebung (KERN_BETRIEB_TOKEN_SHA256)
    const crypto = await import('node:crypto');
    const h = await umgebung({ KERN_BETRIEB_TOKEN_SHA256: crypto.createHash('sha256').update(BT).digest('hex') });
    expect((await intern(h, '/_betrieb/status', { headers: { authorization: `Bearer ${BT}` } })).status).toBe(200);
    expect((await intern(h, '/_betrieb/status', { headers: { authorization: 'Bearer falsch' } })).status).toBe(401);
    const m = await umgebung({ KERN_MODUS: 'managed' });
    const am = new Client(m.app.app);
    await am.login('admin');
    const em = await (await am.req('GET', '/api/einstellungen')).json();
    // Till 07:12: US-Modelle gleichwertig in der Managed-Liste, nur mit ehrlichem Datenfluss-Satz
    expect(em.voreinstellungen.map((v: { id: string }) => v.id).sort()).toEqual(['anthropic', 'google', 'ionos', 'mistral', 'openai']);
    expect(em.voreinstellungen.every((v: { managed_erlaubt: boolean; region: string }) => v.managed_erlaubt && v.region !== 'lokal')).toBe(true);
    const us = em.voreinstellungen.find((v: { id: string }) => v.id === 'anthropic');
    expect(us.datenfluss).toContain('Drittland');
    expect(us.datenfluss).not.toMatch(/warn|unsicher|gefahr|risiko/i);
    expect(em.voreinstellungen.find((v: { id: string }) => v.id === 'mistral').datenfluss).not.toContain('Drittland');
    expect(em.oauth.nur_bekannte_apps).toBe(true);
    // Leser sieht keine Adressen (N6)
    const l = new Client(m.app.app);
    await l.login('leser');
    expect((await (await l.req('GET', '/api/einstellungen')).json()).voreinstellungen.every((v: { url: string }) => v.url === '')).toBe(true);
  });

  it('Token-Anlage nennt den Datenfluss F12, Datenweg listet Apps', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    expect((await (await l.req('POST', '/api/ich/tokens', { json: {} })).json()).datenfluss).toBe(f12Hinweis('Kern'));
    expect((await (await l.req('GET', '/api/datenweg')).json()).apps).toEqual([]);
  });
});

describe('4.1 Einrichtung', () => {
  it('Ablauf ohne KI: Schritt ki → unterlagen → erste_frage → fertig, Zeit bis zur ersten belegten Antwort', async () => {
    const u = await umgebung();
    const app = neuEinrichten(u);
    const a = new Client(app.app);
    await a.login('admin');
    let e = await (await a.req('GET', '/api/einrichtung')).json();
    expect(e).toMatchObject({ schritt: 'ki', beispiel_geladen: false, test_ki_verfuegbar: false, erste_belegte_antwort: null, mcp_adresse: 'http://kern.test/mcp' });
    const r = await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'ohne' } })).json();
    expect(r.verbindung).toBe('ok');
    expect(r.ki).toMatchObject({ weg: 'ohne', status: 'ohne_ki' });
    e = await (await a.req('GET', '/api/einrichtung')).json();
    expect(e.schritt).toBe('unterlagen');
    expect((await a.req('POST', '/api/einrichtung/beispiel', { json: { aktion: 'laden' } })).status).toBe(200);
    e = await (await a.req('GET', '/api/einrichtung')).json();
    expect(e).toMatchObject({ schritt: 'erste_frage', beispiel_geladen: true });
    expect(e.vorschlagsfragen).toEqual(['Was steht zu „Urlaubsantrag“ drin?', 'Was steht zu „Werkzeugausgabe“ drin?']);
    const f = await (await a.req('POST', '/api/frage', { json: { frage: 'Urlaubsanträge eingereicht' } })).json();
    expect(f).toMatchObject({ status: 'beantwortet', ki_erzeugt: false, modell: null });
    e = await (await a.req('GET', '/api/einrichtung')).json();
    expect(e.erste_belegte_antwort.sekunden_seit_start).toBeGreaterThanOrEqual(0);
    expect(e.schritt).toBe('fertig');
    expect((await a.req('POST', '/api/einrichtung/beispiel', { json: { aktion: 'entfernen' } })).status).toBe(200);
    expect(fs.existsSync(path.join(u.dir, 'quellen/beispiel'))).toBe(false);
    await a.req('POST', '/api/einrichtung/fertig', { json: {} });
    expect((await (await a.req('GET', '/api/einrichtung')).json()).schritt).toBe('fertig');
    // nur admin
    const l = new Client(app.app);
    await l.login('leser');
    expect((await l.req('GET', '/api/einrichtung')).status).toBe(403);
  });

  it('Weg app: MCP-Adresse; Weg eigener Schlüssel mit lokalem OpenAI-kompatiblem Server, Fehler bei falschem Schlüssel', async () => {
    let auth = '';
    const ki = http.createServer((q, s) => { auth = String(q.headers.authorization ?? ''); s.statusCode = auth === 'Bearer richtig-123' ? 200 : 401; s.setHeader('content-type', 'application/json'); s.end('{"data":[]}'); });
    await new Promise<void>((r) => ki.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(ki.address() as { port: number }).port}/v1`;
    try {
      const u = await umgebung({ KERN_GEHEIMNIS_SCHLUESSEL: 'g'.repeat(40) });
      const a = new Client(u.app.app);
      await a.login('admin');
      const app = await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'app' } })).json();
      expect(app.mcp_adresse).toBe('http://kern.test/mcp');
      expect(app.meldung).toContain('OAuth');
      const falsch = await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'eigener_schluessel', url, chatModell: 'c', embedModell: 'e', schluessel: 'falsch-123' } })).json();
      expect(falsch.verbindung).toBe('fehler');
      expect(falsch.meldung).toContain('401');
      expect(falsch.meldung).not.toContain('falsch-123');
      const ok = await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'eigener_schluessel', url, chatModell: 'c', embedModell: 'e', schluessel: 'richtig-123' } })).json();
      expect(ok).toMatchObject({ verbindung: 'ok', sofort: true, ki: { weg: 'eigener_schluessel', status: 'ungeprueft', vorher: true } });
      expect(JSON.stringify(ok)).not.toContain('richtig-123');
      expect(fs.readFileSync(path.join(u.dir, 'kern.yaml'), 'utf8')).not.toContain('richtig-123');
      expect((fake(u).provider as { apiKey?: string }).apiKey).toBe('richtig-123'); // Laufzeitwechsel (setzeProvider)
      // 8.2 Rückweg
      const z = await (await a.req('POST', '/api/einstellungen/ki/zurueck', { json: {} })).json();
      expect(z.ki.weg).toBe('app');
    } finally { ki.close(); }
  });

  it('H2 im Assistenten: Managed ohne freie Adresse, Test-KI nie mit Kunden-URL, Test-KI ohne [S-1] nicht verfügbar', async () => {
    const u = await umgebung({ KERN_MODUS: 'managed' });
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'eigener_schluessel', url: 'https://boese.example/v1', chatModell: 'x', embedModell: 'y' } })).status).toBe(400);
    expect((await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'hd_test', url: 'https://boese.example/v1' } })).status).toBe(400);
    expect((await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'hd_test' } })).status).toBe(409);
    expect((await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'eigener_schluessel', voreinstellung: 'ollama' } })).status).toBe(400); // lokal nicht im Managed
  });

  it('Test-KI [S-1] nur mit Schalter und nie für Berufsgeheimnisträger', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'kern-anb-'));
    const datei = path.join(dir, 'anbieter.yaml');
    fs.writeFileSync(datei, 'anbieter:\n  - { id: hd_test, name: Test-KI, art: openai, url: "https://api.mistral.ai/v1", chatModell: mistral-small-latest, embedModell: mistral-embed }\n');
    try {
      const u = await umgebung({ KERN_MODUS: 'managed', KERN_ANBIETER_DATEI: datei, KERN_TEST_KI: '1' });
      const a = new Client(neuEinrichten(u).app);
      await a.login('admin');
      expect((await (await a.req('GET', '/api/einrichtung')).json()).test_ki_verfuegbar).toBe(true);
      const k = await umgebung({ KERN_MODUS: 'managed', KERN_ANBIETER_DATEI: datei, KERN_TEST_KI: '1', KERN_BERUFSGEHEIMNIS: '1' });
      const b = new Client(k.app.app);
      await b.login('admin');
      expect((await (await b.req('GET', '/api/einrichtung')).json()).test_ki_verfuegbar).toBe(false);
      const r = await b.req('PUT', '/api/einrichtung/ki', { json: { weg: 'hd_test' } });
      expect(r.status).toBe(409);
      expect((await r.json()).fehler).toContain('Berufsgeheimnis');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('ohne Beispielsammlung in core: 501 mit Hinweis', async () => {
    const u = await umgebung();
    const a = new Client(erstelleApp({ kern: ohne(u.kern, ['beispielLaden']), config: u.config }).app);
    await a.login('admin');
    const r = await a.req('POST', '/api/einrichtung/beispiel', { json: { aktion: 'laden' } });
    expect(r.status).toBe(501);
    expect((await r.json()).code).toBe('nicht_verfuegbar');
  });
});

describe('3.7 Egress über den Proxy aus der Umgebung', () => {
  /** Proxy mit CONNECT (wie undici ihn nutzt), tunnelt alles zu `ziel`. */
  async function proxy(ziel: http.Server) {
    const gesehen: string[] = [];
    const p = http.createServer((q, s) => { gesehen.push(`plain ${q.url}`); s.statusCode = 502; s.end(); });
    p.on('connect', (q, sock, head) => {
      gesehen.push(`CONNECT ${q.url}`);
      const t = net.connect((ziel.address() as { port: number }).port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); t.write(head); t.pipe(sock); sock.pipe(t); });
      t.on('error', () => sock.destroy());
    });
    await new Promise<void>((r) => p.listen(0, '127.0.0.1', () => r()));
    return { p, gesehen, url: `http://127.0.0.1:${(p.address() as { port: number }).port}` };
  }

  it('Konto-Brücke zum Leitstand geht über HTTPS_PROXY; NO_PROXY gilt; ohne Proxy direkt', async () => {
    const ls = http.createServer((q, s) => { s.setHeader('content-type', 'application/json'); s.end(JSON.stringify({ status: 'test', host: q.headers.host })); });
    await new Promise<void>((r) => ls.listen(0, '127.0.0.1', () => r()));
    const px = await proxy(ls);
    try {
      const u = await umgebung({ KERN_LEITSTAND_URL: 'http://leitstand.kern.invalid', KERN_KONTO_TOKEN: 'k', HTTP_PROXY: px.url, HTTPS_PROXY: px.url, NO_PROXY: '' });
      expect(u.config.proxy).toMatchObject({ httpsProxy: px.url });
      const a = new Client(u.app.app);
      await a.login('admin');
      const k = await (await a.req('GET', '/api/konto')).json();
      expect(k).toEqual({ status: 'test', host: 'leitstand.kern.invalid' });
      expect(px.gesehen).toEqual(['CONNECT leitstand.kern.invalid:80']);
      // NO_PROXY: direkt, nicht über den Proxy
      const abruf = bauAbruf(proxyAusUmgebung({ HTTPS_PROXY: px.url, NO_PROXY: '127.0.0.1' }));
      expect((await abruf(`http://127.0.0.1:${(ls.address() as { port: number }).port}/x`)).status).toBe(200);
      expect(px.gesehen.length).toBe(1);
      expect(proxyAusUmgebung({})).toBeNull();
    } finally { px.p.close(); ls.close(); }
  });

  it('Verbindungstest der KI läuft über den Proxy', async () => {
    const ki = http.createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"data":[]}'); });
    await new Promise<void>((r) => ki.listen(0, '127.0.0.1', () => r()));
    const px = await proxy(ki);
    try {
      // Kanal ".ki" hat Vorrang vor HTTPS_PROXY (deploy/egress: KERN_KI_PROXY, nur Erlaubnisliste)
      const u = await umgebung({ HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', KERN_KI_PROXY: px.url, NO_PROXY: '' });
      const a = new Client(u.app.app);
      await a.login('admin');
      const r = await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'eigener_schluessel', url: 'http://ki.kern.invalid/v1', chatModell: 'c', embedModell: 'e' } })).json();
      expect(r.verbindung).toBe('ok');
      expect(px.gesehen).toEqual(['CONNECT ki.kern.invalid:80']);
    } finally { px.p.close(); ki.close(); }
  });

  it('installiereEgress setzt den globalen Dispatcher: auch das eingebaute fetch (KI-Anbieter in core) geht über den Proxy', async () => {
    const ziel = http.createServer((q, s) => s.end(String(q.headers.host)));
    await new Promise<void>((r) => ziel.listen(0, '127.0.0.1', () => r()));
    const px = await proxy(ziel);
    const vorher = getGlobalDispatcher();
    try {
      expect(installiereEgress({})).toBe(false);
      expect(installiereEgress({ HTTPS_PROXY: px.url, HTTP_PROXY: px.url, NO_PROXY: '' })).toBe(true);
      const r = await fetch('http://anbieter.kern.invalid/v1/models', { signal: AbortSignal.timeout(5000) });
      expect(await r.text()).toBe('anbieter.kern.invalid');
      expect(px.gesehen).toEqual(['CONNECT anbieter.kern.invalid:80']);
    } finally { setGlobalDispatcher(vorher); px.p.close(); ziel.close(); }
  });
});

describe('7.1 Export', () => {
  it('ZIP: 202, Stand, signierter Link nur für den Auslösenden, Download', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    await a.login('admin');
    const s = await a.req('POST', '/api/export', { json: { art: 'zip' } });
    expect(s.status).toBe(202);
    const { id } = await s.json();
    const st = await bisFertig(async () => (await a.req('GET', `/api/export/${id}`)).json(), (x) => x.status !== 'laeuft');
    expect(st).toMatchObject({ status: 'fertig', art: 'zip' });
    expect(st.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(st.link).toMatch(/^api\/export\/x_[a-f0-9]+\/datei\?sig=/);
    const d = await a.req('GET', `/${st.link}`);
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await d.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
    expect((await a.req('GET', `/api/export/${id}/datei?sig=falsch`)).status).toBe(404);
    const f = new Client(u.app.app);
    await f.login('frei');
    expect((await f.req('GET', `/api/export/${id}`)).status).toBe(404);
    expect((await f.req('GET', `/${st.link}`)).status).toBe(404);
    // Protokoll: Export ohne Inhalte
    const prot = fs.readdirSync(path.join(u.dir, '.kern/protokoll')).map((n) => fs.readFileSync(path.join(u.dir, '.kern/protokoll', n), 'utf8')).join('');
    expect(prot).toContain('"ereignis":"export"');
  });

  it('Umzugspaket nur Admin mit Passphrase ab 12 Zeichen; Export geht auch in nur_lesen', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('POST', '/api/export', { json: { art: 'umzugspaket' } })).status).toBe(400);
    expect((await a.req('POST', '/api/export', { json: { art: 'umzugspaket', passphrase: 'kurz' } })).status).toBe(400);
    const l = new Client(u.app.app);
    await l.login('leser');
    expect((await l.req('POST', '/api/export', { json: { art: 'umzugspaket', passphrase: 'x'.repeat(12) } })).status).toBe(403);
    await intern(u, '/_betrieb/modus', { method: 'POST', headers: { authorization: `Bearer ${BT}`, 'content-type': 'application/json' }, body: JSON.stringify({ modus: 'nur_lesen' }) });
    const r = await a.req('POST', '/api/export', { json: { art: 'umzugspaket', passphrase: 'x'.repeat(12) } });
    expect(r.status).toBe(202);
    const st = await bisFertig(async () => (await a.req('GET', `/api/export/${(await r.clone().json()).id}`)).json(), (x) => x.status !== 'laeuft');
    expect(st.status).toBe('fertig');
    expect((await l.req('POST', '/api/export', { json: { art: 'zip' } })).status).toBe(202); // Leser: nur eigene ich-Dateien (core)
  });

  it('/_betrieb/export: Leitstand löst aus, bekommt keinen Link; Admin sieht den Auftrag', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    const h = { authorization: `Bearer ${BT}`, 'content-type': 'application/json' };
    const r = await intern(u, '/_betrieb/export', { method: 'POST', headers: h, body: JSON.stringify({ art: 'zip' }) });
    expect(r.status).toBe(200); // wartet (P2-Client braucht bytes und sha256 sofort)
    const pj = await r.json();
    expect(pj.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pj).not.toHaveProperty('link');
    const { id } = pj;
    const asyn = await intern(u, '/_betrieb/export', { method: 'POST', headers: h, body: JSON.stringify({ art: 'umzugspaket', warten: false }) });
    expect(asyn.status).toBe(202);
    expect((await asyn.json()).passphrase.length).toBeGreaterThanOrEqual(24);
    const st = await bisFertig(async () => (await intern(u, `/_betrieb/export/${id}`, { headers: h })).json(), (x) => x.status !== 'laeuft');
    expect(st.status).toBe('fertig');
    expect(JSON.stringify(st)).not.toMatch(/link|sig=|\.zip/);
    const a = new Client(u.app.app);
    await a.login('admin');
    const liste = await (await a.req('GET', '/api/export')).json();
    const eintrag = liste.find((x: { id: string }) => x.id === id);
    expect(eintrag).toMatchObject({ id, ausgeloest_von: 'betrieb' });
    expect(eintrag.link).toBeTruthy();
    const l = new Client(u.app.app);
    await l.login('leser');
    expect(await (await l.req('GET', '/api/export')).json()).toEqual([]);
  });

  it('ohne core-Export: ZIP 501, OKF über exportiereOkf', async () => {
    const u = await umgebung();
    const a = new Client(erstelleApp({ kern: ohne(u.kern, ['exportiere']), config: u.config }).app);
    await a.login('admin');
    expect((await a.req('POST', '/api/export', { json: { art: 'zip' } })).status).toBe(501);
    const r = await a.req('POST', '/api/export', { json: { art: 'okf' } });
    expect(r.status).toBe(202);
    const st = await bisFertig(async () => (await a.req('GET', `/api/export/${(await r.clone().json()).id}`)).json(), (x) => x.status !== 'laeuft');
    expect(st.status).toBe('fertig');
  });
});

describe('Import kern-zip (Umzug/Export einspielen)', () => {
  it('nur Admin; Datei wird übergeben und danach entfernt', async () => {
    const u = await umgebung();
    const datei = () => { const f = new FormData(); f.set('art', 'kern-zip'); f.set('datei', new File([Buffer.from('PK\u0003\u0004test')], 'kern-export.zip')); return f; };
    const au = new Client(u.app.app);
    await au.login('autor');
    expect((await au.req('POST', '/api/importieren', { body: datei() })).status).toBe(403);
    const a = new Client(u.app.app);
    await a.login('admin');
    const r = await a.req('POST', '/api/importieren', { body: datei() });
    expect(r.status).toBe(201);
    expect((await r.json()).hinweise.join(' ')).toContain('freigebt');
    expect(fake(u).letzterImport).toMatchObject({ art: 'kern-zip', existiert: true });
    expect(fake(u).letzterImport!.pfad.endsWith('kern-export.zip')).toBe(true);
    expect(fs.existsSync(fake(u).letzterImport!.pfad)).toBe(false);
    expect((await a.req('POST', '/api/importieren', { json: { art: 'gibtsnicht' } })).status).toBe(400);
  });
});

describe('3.4 KI-Kontingent', () => {
  const grenzen = (u: TestUmgebung, g: object) => intern(u, '/_betrieb/grenzen', { method: 'POST', headers: { authorization: `Bearer ${BT}`, 'content-type': 'application/json' }, body: JSON.stringify(g) });

  it('Verbrauch im Status; ab 80 % Hinweis, ab 100 % 429 kontingent, Suche läuft weiter, kein Nachkauf', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    await grenzen(u, { ki_kontingent_cent_monat: 500 });
    fake(u).verbrauchCent.monat = 420;
    const st = await (await intern(u, '/_betrieb/status', { headers: { authorization: `Bearer ${BT}` } })).json();
    expect(st.ki_verbrauch_cent_monat).toBe(420);
    expect(st.ki_kontingent_cent_monat).toBe(500);
    const l = new Client(u.app.app);
    await l.login('leser');
    let i = await (await l.req('GET', '/api/ich')).json();
    expect(i.kontingent.ki).toMatchObject({ stufe: 'hinweis', anteil: 0.84 });
    expect((await l.req('POST', '/api/frage', { json: { frage: 'Urlaub?' } })).status).toBe(200);
    fake(u).verbrauchCent.monat = 500;
    const r = await l.req('POST', '/api/frage', { json: { frage: 'Urlaub?' } });
    expect(r.status).toBe(429);
    const j = await r.json();
    expect(j).toMatchObject({ code: 'kontingent', grund: 'ki' });
    expect(j.fehler).toContain('Suche, Wissen und Export laufen weiter');
    expect(j.fehler).toContain('nichts automatisch nachgekauft');
    expect(j.fehler).not.toMatch(/nur noch|jetzt kaufen|angebot|rabatt/i);
    i = await (await l.req('GET', '/api/ich')).json();
    expect(i.kontingent.ki.stufe).toBe('aufgebraucht');
    expect((await l.req('GET', '/api/suche?q=Urlaub')).status).toBe(200);
    // MCP: kern_frage ebenfalls gesperrt, kern_suche nicht
    const { token } = u.app.erzeugeToken((await u.kern.benutzer.liste()).find((x) => x.name === 'leser')!);
    const mcp = (name: string, args: object) => u.app.app.request('http://kern.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const mf = await (await mcp('kern_frage', { frage: 'Urlaub?' })).json();
    expect(mf.result.isError).toBe(true);
    expect(mf.result.content[0].text).toContain('429');
    const ms = await (await mcp('kern_suche', { anfrage: 'Urlaub' })).json();
    expect(ms.result.isError).toBeFalsy();
  });

  it('Tagesdeckel: 429 mit Retry-After; Speicher voll: Uploads 429, Hinweis ab 90 %', async () => {
    const u = await umgebung({ KERN_BETRIEB_TOKEN: BT });
    await grenzen(u, { ki_tagesdeckel_cent: 50 });
    fake(u).verbrauchCent.heute = 50;
    const l = new Client(u.app.app);
    await l.login('autor');
    const r = await l.req('POST', '/api/frage', { json: { frage: 'Urlaub?' } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await r.json()).grund).toBe('ki_tag');
    await grenzen(u, { speicher_max_bytes: 10 });
    const i = await (await l.req('GET', '/api/ich')).json();
    expect(i.kontingent.speicher.stufe).toBe('voll');
    expect((await l.req('POST', '/api/hinzufuegen', { json: { inhalt: 'x', titel: 't' } })).status).toBe(429);
  });
});

describe('8.1, 8.2 Prüfbank und Prüfstatus', () => {
  it('Lauf 202, danach GET mit Kurzform, Läufen und Vergleich; bestanden → geprueft, unter Schwelle → unter_schwelle', async () => {
    const u = await umgebung({ KERN_PROVIDER: 'ollama' });
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('GET', '/api/pruefbank')).status).toBe(404);
    const r = await a.req('POST', '/api/pruefbank/lauf', { json: {} });
    expect(r.status).toBe(202);
    const { id } = await r.json();
    const fertig = await bisFertig(async () => (await a.req('GET', `/api/pruefbank/${id}`)).json(), (x) => x.status === 'fertig');
    expect(fertig.bestanden).toBe(true);
    const g = await (await a.req('GET', '/api/pruefbank')).json();
    expect(g).toMatchObject({ status: 'fertig', belegtreue: 1, lecks: 0, injektion: 1, bestanden: true });
    expect(g.laeufe.length).toBe(1);
    await bisFertig(async () => (await a.req('GET', '/api/einstellungen')).json(), (x) => x.ki.status === 'geprueft');
    expect((await (await a.req('GET', '/api/einstellungen')).json()).ki.status).toBe('geprueft');
    fake(u).pruefbankFaellt = true;
    const r2 = await (await a.req('POST', '/api/pruefbank/lauf', { json: { satz: 'betrieb' } })).json();
    await bisFertig(async () => (await a.req('GET', `/api/pruefbank/${r2.id}`)).json(), (x) => x.status === 'fertig');
    expect((await bisFertig(async () => (await a.req('GET', '/api/einstellungen')).json(), (x) => x.ki.status === 'unter_schwelle')).ki.status).toBe('unter_schwelle');
    const l = new Client(u.app.app);
    await l.login('frei');
    expect((await l.req('POST', '/api/pruefbank/lauf', { json: {} })).status).toBe(403);
  });

  it('ohne Prüfbank in core: POST 501, GET 404', async () => {
    const u = await umgebung();
    const a = new Client(erstelleApp({ kern: ohne(u.kern, ['pruefbank', 'pruefbankLaeufe']), config: u.config }).app);
    await a.login('admin');
    expect((await a.req('POST', '/api/pruefbank/lauf', { json: {} })).status).toBe(501);
    expect((await a.req('GET', '/api/pruefbank')).status).toBe(404);
  });
});

describe('9 Kontextbilanz, 7.3 Ausstiegsprobe, 8.3 Kontextpaket', () => {
  it('Kontextbilanz für Freigeber und Admin, nicht für Leser; 501 ohne core', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    expect((await l.req('GET', '/api/kontextbilanz')).status).toBe(403);
    const f = new Client(u.app.app);
    await f.login('frei');
    expect((await (await f.req('GET', '/api/kontextbilanz')).json()).bestand.artikel).toBe(1);
    const o = new Client(erstelleApp({ kern: ohne(u.kern, ['kontextbilanz']), config: u.config }).app);
    await o.login('admin');
    expect((await o.req('GET', '/api/kontextbilanz')).status).toBe(501);
  });

  it('Ausstiegsprobe: POST 202, GET liest das letzte Ergebnis aus pruefung/ausstieg/', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('GET', '/api/ausstiegsprobe')).status).toBe(404);
    expect((await a.req('POST', '/api/ausstiegsprobe', { json: {} })).status).toBe(202);
    const p = await bisFertig(async () => a.req('GET', '/api/ausstiegsprobe'), (x) => x.status === 200);
    expect((await p.json()).bestanden).toBe(true);
  });

  it('Kontextpaket REST und MCP kern_kontext, Budget eingehalten, kein KI-Text', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    const p = await (await l.req('GET', '/api/kontextpaket?frage=Urlaub&budget=200')).json();
    expect(p.ki_erzeugt).toBe(false);
    expect(p.tokens).toBeLessThanOrEqual(200);
    expect(p.abschnitte.length).toBeGreaterThan(0);
    expect((await l.req('GET', '/api/kontextpaket')).status).toBe(400);
  });
});

describe('6.1 MCP: Version 2026-07-28 fällt sauber auf 2025-11-25 zurück, neue Werkzeuge und Ressourcen', () => {
  const rufe = (u: TestUmgebung, token: string, body: object, kopf: Record<string, string> = {}) => u.app.app.request('http://kern.test/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...kopf }, body: JSON.stringify(body),
  });
  it('initialize mit 2026-07-28 → 2025-11-25; Header 2026-07-28 ohne initialize → 400 mit unterstützten Versionen; server/discover → -32601', async () => {
    const u = await umgebung();
    const { token } = u.app.erzeugeToken((await u.kern.benutzer.liste()).find((x) => x.name === 'leser')!);
    const init = await rufe(u, token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, { 'mcp-protocol-version': '2026-07-28' });
    expect(init.status).toBe(200);
    expect((await init.json()).result.protocolVersion).toBe('2025-11-25');
    const alt = await rufe(u, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
    expect(alt.status).toBe(400);
    const aj = await alt.json();
    expect(aj.error.data.supportedVersions).toContain('2025-11-25');
    expect(aj.error.data.empfohlen).toBe('2025-11-25');
    const d = await (await rufe(u, token, { jsonrpc: '2.0', id: 3, method: 'server/discover', params: {} })).json();
    expect(d.error.code).toBe(-32601);
    expect(d.error.data.supportedVersions).toContain('2025-06-18');
    const neu = await rufe(u, token, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-11-25' });
    const namen = (await neu.json()).result.tools.map((t: { name: string }) => t.name);
    expect(namen).toEqual(expect.arrayContaining(['kern_kontext', 'kern_wegweiser']));
  });

  it('kern_wegweiser, Ressourcen index.md und REGELN.md', async () => {
    const u = await umgebung();
    const { token } = u.app.erzeugeToken((await u.kern.benutzer.liste()).find((x) => x.name === 'leser')!);
    const w = await (await rufe(u, token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kern_wegweiser', arguments: {} } })).json();
    expect(w.result.content[0].text).toContain('Urlaubsregel');
    const r = await (await rufe(u, token, { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} })).json();
    expect(r.result.resources.map((x: { uri: string }) => x.uri)).toEqual(['kern://index.md', 'kern://wissen/_regeln/REGELN.md']);
    const i = await (await rufe(u, token, { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'kern://index.md' } })).json();
    expect(i.result.contents[0].text).toContain('Index');
    const k = await (await rufe(u, token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kern_kontext', arguments: { thema: 'Urlaub' } } })).json();
    expect(k.result.structuredContent.ki_erzeugt).toBe(false);
  });
});
