import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { baueUmgebung, Client, type TestUmgebung } from './helfer.js';

let u: TestUmgebung;
beforeAll(async () => { u = await baueUmgebung(); });
afterAll(() => u.aufraeumen());

describe('Grundlagen', () => {
  it('healthz ohne Login', async () => {
    const r = await u.app.app.request('/healthz');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true });
    // P2: healthz verrät weder KI-Anbieter noch Attrappe.
    expect(j.provider).toBeUndefined();
  });

  it('setzt Sicherheitsheader', async () => {
    const r = await u.app.app.request('/healthz');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('zeigt Hinweisseite ohne Web-Build', async () => {
    const r = await u.app.app.request('/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Weboberfläche ist noch nicht gebaut');
  });

  it('liefert Web-Build aus und fällt auf index.html zurück', async () => {
    const web = path.join(u.dir, 'web-dist');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Kern UI</title>');
    fs.writeFileSync(path.join(web, 'assets', 'a.js'), 'console.log(1)');
    const { erstelleApp } = await import('../src/index.js');
    const app = erstelleApp({ kern: u.kern, config: { ...u.config, webDist: web } }).app;
    // Seite kommt aus webDist; Titel und Meta tragen den konfigurierten Produktnamen (Standard „Kern“)
    const seite = await (await app.request('/eingang')).text();
    expect(seite).toContain('<!doctype html>');
    expect(seite).toContain('<title>Kern</title>');
    expect(seite).toContain('<meta name="kern-produkt" content="Kern">');
    const js = await app.request('/assets/a.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect((await app.request('/assets/fehlt.js')).status).toBe(404);
    expect((await app.request('/%2e%2e/%2e%2e/etc/passwd')).status).not.toBe(500);
    expect(await (await app.request('/..%2f..%2fetc%2fpasswd')).text()).not.toContain('root:');
  });
});

describe('Login, Logout, Sitzung', () => {
  it('ohne Sitzung 401', async () => {
    expect((await new Client(u.app.app).req('GET', '/api/ich')).status).toBe(401);
  });

  it('Login setzt sicheres Cookie, Logout beendet die Sitzung', async () => {
    const c = new Client(u.app.app);
    const r = await c.login('leser');
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    const alt = c.cookie;
    const ich = await c.req('GET', '/api/ich');
    expect(ich.status).toBe(200);
    expect((await ich.json()).benutzer.name).toBe('leser');
    expect((await c.req('POST', '/api/logout')).status).toBe(200);
    c.cookie = alt; // altes Cookie wiederverwenden
    expect((await c.req('GET', '/api/ich')).status).toBe(401);
  });

  it('falsches Passwort 401, gefälschtes Cookie 401', async () => {
    const c = new Client(u.app.app);
    expect((await c.login('leser', 'falsch-falsch')).status).toBe(401);
    c.cookie = 'kern_sitzung=abc.def';
    expect((await c.req('GET', '/api/ich')).status).toBe(401);
  });

  it('Ratenlimit nach 5 Fehlversuchen', async () => {
    const s = await (await import('./helfer.js')).baueUmgebung();
    const c = new Client(s.app.app);
    for (let i = 0; i < 5; i++) expect((await c.login('autor', 'falsch-falsch')).status).toBe(401);
    const r = await c.login('autor');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    s.aufraeumen();
  });

  it('Secure-Cookie mit __Host-Präfix, wenn KERN_SECURE_COOKIE=1', async () => {
    const s = await (await import('./helfer.js')).baueUmgebung({ KERN_SECURE_COOKIE: '1' });
    const r = await new Client(s.app.app).login('leser');
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^__Host-kern_sitzung=/);
    expect(sc).toMatch(/Secure/);
    expect(r.headers.get('strict-transport-security')).toBeTruthy();
    s.aufraeumen();
  });
});

describe('CSRF', () => {
  it('schreibende Anfrage ohne x-kern wird abgewiesen, auch Login', async () => {
    const c = new Client(u.app.app);
    expect((await c.req('POST', '/api/login', { json: { name: 'leser', passwort: 'x' }, csrf: false })).status).toBe(403);
    await c.login('frei');
    const r = await c.req('POST', '/api/frage', { json: { frage: 'Urlaub' }, csrf: false });
    expect(r.status).toBe(403);
    expect((await r.json()).fehler).toContain('x-kern');
  });
});

describe('Lesen, Suchen, Fragen', () => {
  let c: Client;
  beforeAll(async () => { c = new Client(u.app.app); await c.login('leser'); });

  it('Wissen auflisten und lesen', async () => {
    const liste = await (await c.req('GET', '/api/wissen')).json();
    expect(liste.map((a: { pfad: string }) => a.pfad)).toContain('wissen/betrieb/urlaub.md');
    const a = await c.req('GET', '/api/wissen/betrieb/urlaub.md');
    expect(a.status).toBe(200);
    expect((await a.json()).kopf.titel).toBe('Urlaubsregel');
    expect((await c.req('GET', '/api/wissen/wissen/betrieb/urlaub.md')).status).toBe(200);
    expect((await c.req('GET', '/api/wissen/betrieb/urlaub.md/verlauf')).status).toBe(200);
  });

  it('Pfad-Ausbruch ergibt 404', async () => {
    for (const p of ['/api/wissen/..%2f.kern%2fusers.json', '/api/wissen/betrieb/%2e%2e%2f%2e%2e%2f.kern%2fusers.json', '/api/wissen/..%2f.kern%2fusers.json',
      '/api/wissen/.git/config', '/api/quellen/..%2F..%2Fetc%2Fpasswd/original', '/api/wissen/betrieb%00/x', '/api/quellen/%E0%A4%A']) {
      const r = await c.req('GET', p);
      expect(r.status, p).toBe(404);
      expect(await r.text()).not.toContain('salt');
    }
    // "../" und "%2e%2e/" normalisiert schon der URL-Parser weg: landet nie in /api/wissen
    const n = await c.req('GET', '/api/wissen/%2e%2e/%2e%2e/.kern/users.json');
    expect(await n.text()).not.toContain('salt');
  });

  it('Quelle und Original', async () => {
    expect((await c.req('GET', '/api/quellen')).status).toBe(200);
    const q = await c.req('GET', '/api/quellen/2026/handbuch.md');
    expect(q.status).toBe(200);
    const o = await c.req('GET', '/api/quellen/2026/handbuch.md/original');
    expect(o.status).toBe(200);
    expect(o.headers.get('content-disposition')).toContain('attachment');
    expect(o.headers.get('content-security-policy')).toContain('sandbox');
    expect(await o.text()).toBe('Original-Handbuch');
  });

  it('suche und frage mit Belegen', async () => {
    const t = await (await c.req('GET', '/api/suche?q=Urlaub')).json();
    expect(t.length).toBeGreaterThan(0);
    expect((await c.req('GET', '/api/suche?q=')).status).toBe(400);
    const a = await (await c.req('POST', '/api/frage', { json: { frage: 'Wann Urlaub beantragen?' } })).json();
    expect(a.status).toBe('beantwortet');
    expect(a.punkte[0].belege.length).toBeGreaterThan(0);
    expect(a.belege[a.punkte[0].belege[0]].quelle).toBeTruthy();
    const n = await (await c.req('POST', '/api/frage', { json: { frage: 'Quantenchromodynamik' } })).json();
    expect(n.status).toBe('steht_nicht_drin');
    expect((await c.req('POST', '/api/frage', { json: {} })).status).toBe(400);
  });

  it('Fakten (v1.1), Briefing und fällig', async () => {
    const f = await (await c.req('GET', '/api/fakten?art=frist&gueltig_am=2026-10-24')).json();
    expect(f[0]).toMatchObject({ id: 'f1', wert: 21 });
    expect((await c.req('GET', '/api/fakten?gueltig_am=gestern')).status).toBe(400);
    expect((await c.req('GET', '/api/briefing')).status).toBe(200);
    const fa = await (await c.req('GET', '/api/faellig')).json();
    expect(fa.length).toBe(1);
  });
});

describe('Rechte, Hinzufügen, Eingang', () => {
  it('Leser darf nicht hinzufügen, nicht vorschlagen, nicht freigeben, nicht prüfen', async () => {
    const c = new Client(u.app.app);
    await c.login('leser');
    expect((await c.req('POST', '/api/hinzufuegen', { json: { art: 'text', inhalt: 'x', sammlung: 'a' } })).status).toBe(403);
    expect((await c.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel: 'wissen/a/b.md', neu: 'x', grund: 'weil' } })).status).toBe(403);
    expect((await c.req('POST', '/api/eingang/abc', { json: { aktion: 'freigeben' } })).status).toBe(403);
    expect((await c.req('POST', '/api/pruefen')).status).toBe(403);
    expect((await c.req('GET', '/api/benutzer')).status).toBe(403);
    expect((await c.req('PUT', '/api/einstellungen', { json: { betrieb: 'X' } })).status).toBe(403);
  });

  it('Upload per multipart erzeugt Quelle, Original und Vorschlag; Freigeber gibt frei', async () => {
    const autor = new Client(u.app.app);
    await autor.login('autor');
    const fd = new FormData();
    fd.set('datei', new File(['# Lager\n\nDas Lager schließt um 16 Uhr.'], 'lager.md', { type: 'text/markdown' }));
    fd.set('sammlung', 'betrieb');
    fd.set('sichtbarkeit', 'betrieb');
    fd.set('titel', 'Lagerzeiten');
    const r = await autor.req('POST', '/api/hinzufuegen', { body: fd });
    expect(r.status).toBe(201);
    const { quelle, vorschlaege } = await r.json();
    expect(quelle.pfad).toMatch(/^quellen\/\d{4}\/lagerzeiten\.md$/);
    expect(vorschlaege).toHaveLength(1);
    expect(fs.existsSync(path.join(u.dir, '.kern/upload')) ? fs.readdirSync(path.join(u.dir, '.kern/upload')) : []).toHaveLength(0);
    const orig = await autor.req('GET', `/api/${quelle.pfad.replace(/^quellen/, 'quellen')}/original`);
    expect(orig.status).toBe(200);

    // Autor sieht seinen Vorschlag, darf ihn aber nicht freigeben
    expect((await autor.req('POST', `/api/eingang/${vorschlaege[0].id}`, { json: { aktion: 'freigeben' } })).status).toBe(403);

    const frei = new Client(u.app.app);
    await frei.login('frei');
    const eingang = await (await frei.req('GET', '/api/eingang')).json();
    expect(eingang.some((v: { id: string }) => v.id === vorschlaege[0].id)).toBe(true);
    const e = await frei.req('POST', `/api/eingang/${vorschlaege[0].id}`, { json: { aktion: 'freigeben', begruendung: 'passt' } });
    expect(e.status).toBe(200);
    expect((await e.json()).status).toBe('freigegeben');
    expect(fs.existsSync(path.join(u.dir, vorschlaege[0].ziel))).toBe(true);
    // zweites Mal: Konflikt
    expect((await frei.req('POST', `/api/eingang/${vorschlaege[0].id}`, { json: { aktion: 'freigeben' } })).status).toBe(409);
  });

  it('Text hinzufügen per JSON, Vorschlag ablehnen', async () => {
    const autor = new Client(u.app.app);
    await autor.login('autor');
    const r = await autor.req('POST', '/api/hinzufuegen', { json: { art: 'notiz', titel: 'Notiz', inhalt: 'Kaffee ist im Schrank.', sammlung: 'kueche' } });
    expect(r.status).toBe(201);
    const v = (await r.json()).vorschlaege[0];
    const frei = new Client(u.app.app);
    await frei.login('frei');
    const e = await frei.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'ablehnen', begruendung: 'unwichtig' } });
    expect((await e.json()).status).toBe('abgelehnt');
    expect(fs.existsSync(path.join(u.dir, v.ziel))).toBe(false);
  });

  it('Upload über dem Größenlimit ergibt 413', async () => {
    const s = await (await import('./helfer.js')).baueUmgebung({ KERN_MAX_UPLOAD_MB: '1' });
    const c = new Client(s.app.app);
    await c.login('autor');
    const fd = new FormData();
    fd.set('datei', new File([new Uint8Array(1024 * 1024 + 10)], 'gross.pdf'));
    fd.set('sammlung', 'a');
    expect((await c.req('POST', '/api/hinzufuegen', { body: fd })).status).toBe(413);
    s.aufraeumen();
  });

  it('Vorschlag per API: Ziel außerhalb wissen/ wird abgewiesen', async () => {
    const c = new Client(u.app.app);
    await c.login('autor');
    expect((await c.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel: '../.kern/users.json', neu: 'x', grund: 'boese' } })).status).toBe(400);
    const ok = await c.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel: 'wissen/a/b.md', neu: '# B', grund: 'neu angelegt' } });
    expect(ok.status).toBe(201);
    expect(fs.existsSync(path.join(u.dir, 'wissen/a/b.md'))).toBe(false);
  });

  it('Sichtbarkeit fremdes Team ist für Autor verboten', async () => {
    const c = new Client(u.app.app);
    await c.login('autor');
    expect((await c.req('POST', '/api/hinzufuegen', { json: { art: 'text', inhalt: 'x', sammlung: 'a', sichtbarkeit: 'team:chef' } })).status).toBe(403);
  });
});

describe('Admin: Einstellungen, Benutzer, Tokens, Prüfen', () => {
  let a: Client;
  beforeAll(async () => { a = new Client(u.app.app); await a.login('admin'); });

  it('Einstellungen lesen und ändern, API-Schlüssel abgewiesen', async () => {
    const g = await (await a.req('GET', '/api/einstellungen')).json();
    expect(g.provider.art).toBe('mock');
    const p = await a.req('PUT', '/api/einstellungen', { json: { betrieb: 'Dachdeckerei Test', teams: ['buero'] } });
    expect(p.status).toBe(200);
    expect(fs.readFileSync(path.join(u.dir, 'kern.yaml'), 'utf8')).toContain('Dachdeckerei Test');
    expect((await a.req('PUT', '/api/einstellungen', { json: { provider: { art: 'openai', apiKey: 'sk-geheim' } } })).status).toBe(400);
  });

  it('Benutzer anlegen, doppelt 409, kurzes Passwort 400', async () => {
    expect((await a.req('POST', '/api/benutzer', { json: { name: 'neu', passwort: 'lang-genug-123', rollen: ['leser'] } })).status).toBe(201);
    expect((await a.req('POST', '/api/benutzer', { json: { name: 'neu', passwort: 'lang-genug-123', rollen: ['leser'] } })).status).toBe(409);
    expect((await a.req('POST', '/api/benutzer', { json: { name: 'kurz', passwort: 'kurz' } })).status).toBe(400);
    const liste = await (await a.req('GET', '/api/benutzer')).json();
    expect(liste.find((x: { name: string }) => x.name === 'neu')).toBeTruthy();
    expect(JSON.stringify(liste)).not.toMatch(/hash|salt/);
  });

  it('M2: Admin darf keine Tokens für andere anlegen, nur widerrufen; jeder für sich selbst', async () => {
    // Regression S1 R3: Admin legte Token für die Leserin an (201) und las damit deren Daten.
    expect((await a.req('POST', `/api/benutzer/${u.nutzer.leser.id}/tokens`, { json: { bezeichnung: 'Claude' } })).status).toBe(404);
    const l = new Client(u.app.app);
    await l.login('leser');
    const r = await l.req('POST', `/api/benutzer/${u.nutzer.leser.id}/tokens`, { json: { bezeichnung: 'Claude' } });
    expect(r.status).toBe(201);
    const { token, eintrag } = await r.json();
    expect(token).toMatch(/^kern_/);
    expect(eintrag.scopes).toEqual(['kern:lesen', 'kern:fragen']);
    expect(eintrag.laeuftAb).toBeTruthy();
    expect(fs.readFileSync(path.join(u.dir, '.kern/zugang-ersatz.json'), 'utf8')).not.toContain(token);
    expect((await l.req('GET', `/api/benutzer/${u.nutzer.leser.id}/tokens`)).status).toBe(200);
    expect((await l.req('GET', `/api/benutzer/${u.nutzer.admin.id}/tokens`)).status).toBe(403);
    // Leser darf kern:verwalten nicht anfordern
    expect((await l.req('POST', '/api/ich/tokens', { json: { scopes: ['kern:verwalten'] } })).status).toBe(403);
    // Admin sieht und widerruft
    const liste = await (await a.req('GET', `/api/benutzer/${u.nutzer.leser.id}/tokens`)).json();
    expect(liste.map((x: { id: string }) => x.id)).toContain(eintrag.id);
    expect((await a.req('DELETE', `/api/benutzer/${u.nutzer.leser.id}/tokens/${eintrag.id}`)).status).toBe(200);
    expect((await l.req('DELETE', `/api/benutzer/${u.nutzer.leser.id}/tokens/${eintrag.id}`)).status).toBe(404);
  });

  it('POST /api/pruefen liefert Befunde', async () => {
    const b = await (await a.req('POST', '/api/pruefen')).json();
    expect(b.some((x: { art: string }) => x.art === 'pruefung_faellig')).toBe(true);
  });

  it('unbekannter Endpunkt 404', async () => {
    expect((await a.req('GET', '/api/gibtsnicht')).status).toBe(404);
  });
});
