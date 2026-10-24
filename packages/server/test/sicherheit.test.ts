/**
 * Regressionstests zu den S1-Befunden (kern/team2/s1_review/BEFUNDE.md, 24.10.2026).
 * Jeder Block nimmt die Reproduktion aus repro/ auf und erwartet jetzt die Abwehr.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { baueUmgebung, Client, PASSWORT, type TestUmgebung } from './helfer.js';
import { bauProvider, herkunftsIp, ladeKonfiguration, STANDARD_ANBIETER, type User } from '../src/index.js';
import { ohnePfade } from '../src/fehler.js';
import { zusammenfassung } from '../src/planer.js';

const umgebungen: TestUmgebung[] = [];
async function umgebung(env: Record<string, string> = {}) {
  const u = await baueUmgebung(env);
  umgebungen.push(u);
  return u;
}
afterEach(() => { while (umgebungen.length) umgebungen.pop()!.aufraeumen(); });

const SECRET = 'S'.repeat(40);
async function userVon(u: TestUmgebung, rolle: keyof TestUmgebung['nutzer']): Promise<User> {
  return (await u.kern.benutzer.liste()).find((x) => x.id === u.nutzer[rolle].id)!;
}
function mcp(u: TestUmgebung, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return u.app.app.request('http://kern.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
}
const toolCall = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('H2: KI-Endpunkt und Schlüsselvariable', () => {
  it('apiKeyEnv: KERN_SECRET über die API → 400 (Repro R2)', async () => {
    const u = await umgebung();
    const a = new Client(u.app.app);
    await a.login('admin');
    const r = await a.req('PUT', '/api/einstellungen', { json: { provider: { art: 'openai', url: 'http://127.0.0.1:4306/abgreifen', chatModell: 'x', embedModell: 'y', apiKeyEnv: 'KERN_SECRET' } } });
    expect(r.status).toBe(400);
    // erlaubter Name geht, mit Warnung zum freien Endpunkt (Selbstbetrieb)
    const ok = await a.req('PUT', '/api/einstellungen', { json: { provider: { art: 'openai', url: 'https://ki.example.org/v1', chatModell: 'x', embedModell: 'y', apiKeyEnv: 'KERN_PROVIDER_KEY_EIGEN' } } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).warnungen.join(' ')).toContain('ki.example.org');
  });

  it('kern.yaml mit apiKeyEnv: KERN_SECRET → Geheimnis wird nie als Schlüssel gelesen', async () => {
    const w: string[] = [];
    const p = bauProvider({ art: 'openai', url: 'http://boese.example/v1', chatModell: 'x', embedModell: 'y', apiKeyEnv: 'KERN_SECRET' }, { KERN_SECRET: SECRET }, w);
    expect(p.art).toBe('openai');
    expect((p as { apiKey: string }).apiKey).toBe('');
    expect(w.join(' ')).toContain('nicht erlaubt');
    // Repro R2 über ladeKonfiguration
    const u = await umgebung();
    fs.writeFileSync(path.join(u.dir, 'kern.yaml'), YAML.stringify({ provider: { art: 'openai', url: 'http://127.0.0.1:4306/abgreifen', chatModell: 'x', embedModell: 'y', apiKeyEnv: 'KERN_SECRET' } }));
    const neu = ladeKonfiguration({ dataDir: u.dir, env: { KERN_SECRET: SECRET } });
    expect((neu.kern.provider as { apiKey?: string }).apiKey).not.toBe(SECRET);
  });

  it('Managed: freie URL → 400, nur Anbieter aus der Liste; HD-Schlüssel nur an die Listenadresse', async () => {
    const u = await umgebung({ KERN_MODUS: 'managed', KERN_PUBLIC_URL: 'https://kunde.example.de' });
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('PUT', '/api/einstellungen', { json: { provider: { art: 'openai', url: 'https://boese.example/v1', chatModell: 'x', embedModell: 'y' } } })).status).toBe(400);
    expect((await a.req('PUT', '/api/einstellungen', { json: { provider: { anbieter: 'gibtsnicht' } } })).status).toBe(400);
    const ok = await a.req('PUT', '/api/einstellungen', { json: { provider: { anbieter: 'mistral' } } });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.managed).toBe(true);
    expect(j.anbieterListe.map((x: { id: string }) => x.id)).toContain('mistral');
    // Konfiguration nach Neustart: URL aus der Liste, Schlüssel aus der Listenvariable
    const y = YAML.parse(fs.readFileSync(path.join(u.dir, 'kern.yaml'), 'utf8'));
    y.provider.url = 'https://boese.example/v1'; // von Hand eingeschleust
    y.provider.apiKeyEnv = 'KERN_PROVIDER_KEY_MISTRAL';
    fs.writeFileSync(path.join(u.dir, 'kern.yaml'), YAML.stringify(y));
    const neu = ladeKonfiguration({ dataDir: u.dir, env: { KERN_SECRET: SECRET, KERN_MODUS: 'managed', KERN_PROVIDER_KEY_MISTRAL: 'hd-schluessel' } });
    const p = neu.kern.provider as { art: string; url: string; apiKey: string };
    expect(p.url).toBe(STANDARD_ANBIETER.find((x) => x.id === 'mistral')!.url);
    expect(p.apiKey).toBe('hd-schluessel');
    expect(neu.warnungen.join(' ')).toContain('ignoriert');
  });

  it('Managed: freie URL in kern.yaml ohne Anbieter → mock', () => {
    const w: string[] = [];
    const p = bauProvider({ art: 'openai', url: 'https://boese.example/v1', chatModell: 'x', embedModell: 'y' }, { KERN_PROVIDER_KEY: 'hd' }, w, { modus: 'managed', anbieter: STANDARD_ANBIETER });
    expect(p.art).toBe('mock');
  });
});

describe('H3: Login-Bremse hinter Proxy', () => {
  it('wechselndes X-Forwarded-For umgeht die Sperre nicht (Repro xff.mjs)', async () => {
    const u = await umgebung({ KERN_TRUST_PROXY: '1' });
    const status: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await u.app.app.request('http://kern.test/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1', 'x-forwarded-for': `10.9.${i}.1, 203.0.113.5` },
        body: JSON.stringify({ name: 'admin', passwort: `falsch${i}` }),
      });
      status.push(r.status);
    }
    expect(status.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(status.slice(5).every((s) => s === 429)).toBe(true);
  });

  it('Sperre je Konto greift auch bei völlig wechselnden Adressen; Admin kann entsperren', async () => {
    const u = await umgebung({ KERN_TRUST_PROXY: '2' });
    for (let i = 0; i < 6; i++) {
      await u.app.app.request('http://kern.test/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1', 'x-forwarded-for': `198.51.100.${i}, 192.0.2.${i}` },
        body: JSON.stringify({ name: 'leser', passwort: 'falsch' }),
      });
    }
    const l = new Client(u.app.app);
    expect((await l.login('leser')).status).toBe(429);
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('POST', `/api/benutzer/${u.nutzer.leser.id}/entsperren`)).status).toBe(200);
    expect((await l.login('leser')).status).toBe(200);
  });

  it('herkunftsIp nimmt den Eintrag des eigenen Proxys (rechter Rand, n Hops)', () => {
    expect(herkunftsIp('10.0.0.2', '6.6.6.6, 203.0.113.5', 1)).toBe('203.0.113.5');
    expect(herkunftsIp('10.0.0.2', '6.6.6.6, 203.0.113.5, 10.0.0.9', 2)).toBe('203.0.113.5');
    expect(herkunftsIp('10.0.0.2', '6.6.6.6', 0)).toBe('10.0.0.2');
    expect(herkunftsIp('10.0.0.2', '203.0.113.5', 2)).toBe('10.0.0.2');
    expect(herkunftsIp('10.0.0.2', 'kein-ip, <x>', 1)).toBe('10.0.0.2');
  });
});

describe('M1: Body-Grenzen', () => {
  it('2 MB an /api/login vor der Anmeldung → 413 (Repro dos.mjs)', async () => {
    const u = await umgebung();
    const r = await u.app.app.request('http://kern.test/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1' },
      body: JSON.stringify({ name: 'x', passwort: 'p', f: 'A'.repeat(2 * 1024 * 1024) }),
    });
    expect(r.status).toBe(413);
  });

  it('auch ohne Content-Length (gestreamt) → 413; JSON allgemein über 1 MB → 413', async () => {
    const u = await umgebung();
    const strom = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('A'.repeat(1024))); c.close(); } });
    const r = await u.app.app.request('http://kern.test/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1' }, body: strom, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await a.req('POST', '/api/frage', { json: { frage: 'x', f: 'A'.repeat(1100 * 1024) } })).status).toBe(413);
    expect((await mcp(u, 'kern_x', { f: 'A'.repeat(1100 * 1024) })).status).toBe(413);
  });
});

describe('M3: Passwort, Sitzungen, Tokens', () => {
  it('Passwortwechsel beendet alte Sitzung und altes Token (Repro R4)', async () => {
    const u = await umgebung();
    const l1 = new Client(u.app.app);
    const l2 = new Client(u.app.app);
    await l1.login('leser');
    await l2.login('leser');
    const { token } = await (await l1.req('POST', '/api/ich/tokens', { json: { bezeichnung: 'x' } })).json();
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(200);
    expect((await l1.req('POST', '/api/ich/passwort', { json: { alt: 'falsch-falsch', neu: 'ganz-neues-passwort-123' } })).status).toBe(403);
    expect((await l1.req('POST', '/api/ich/passwort', { json: { alt: PASSWORT, neu: 'kurz' } })).status).toBe(400);
    expect((await l1.req('POST', '/api/ich/passwort', { json: { alt: PASSWORT, neu: 'ganz-neues-passwort-123' } })).status).toBe(200);
    expect((await l1.req('GET', '/api/ich')).status).toBe(200); // neue Sitzung für dieses Gerät
    expect((await l2.req('GET', '/api/ich')).status).toBe(401);
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(401);
  });

  it('Passwortwechsel direkt in core (benutzer.aendere) beendet ebenfalls Sitzung und Token', async () => {
    const u = await umgebung();
    const l = new Client(u.app.app);
    await l.login('leser');
    const { token } = await (await l.req('POST', '/api/ich/tokens', { json: {} })).json();
    await u.kern.benutzer.aendere!(u.nutzer.leser.id, { passwort: 'ganz-neues-passwort-123' });
    expect((await l.req('GET', '/api/ich')).status).toBe(401);
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(401);
  });

  it('überall abmelden, Geräte einzeln, Admin-Reset mit Pflicht zum Wechsel', async () => {
    const u = await umgebung();
    const l1 = new Client(u.app.app);
    const l2 = new Client(u.app.app);
    await l1.login('autor');
    await l2.login('autor');
    const geraete = await (await l1.req('GET', '/api/ich/geraete')).json();
    expect(geraete.length).toBe(2);
    expect(geraete.filter((g: { aktuell: boolean }) => g.aktuell).length).toBe(1);
    const fremd = geraete.find((g: { aktuell: boolean }) => !g.aktuell);
    expect((await l1.req('DELETE', `/api/ich/geraete/${fremd.id}`)).status).toBe(200);
    expect((await l2.req('GET', '/api/ich')).status).toBe(401);
    await l2.login('autor');
    const r = await l1.req('POST', '/api/ich/abmelden-ueberall');
    expect(r.status).toBe(200);
    expect((await l1.req('GET', '/api/ich')).status).toBe(401);
    expect((await l2.req('GET', '/api/ich')).status).toBe(401);

    const a = new Client(u.app.app);
    await a.login('admin');
    await l2.login('autor');
    const z = await a.req('POST', `/api/benutzer/${u.nutzer.autor.id}/passwort-zuruecksetzen`);
    expect(z.status).toBe(200);
    const { einmalPasswort } = await z.json();
    expect((await l2.req('GET', '/api/ich')).status).toBe(401);
    const n = new Client(u.app.app);
    expect((await (await n.login('autor', einmalPasswort)).json()).mussPasswortAendern).toBe(true);
    const gesperrt = await n.req('GET', '/api/wissen');
    expect(gesperrt.status).toBe(403);
    expect((await gesperrt.json()).code).toBe('passwort_aendern');
    expect((await n.req('POST', '/api/ich/passwort', { json: { alt: einmalPasswort, neu: 'eigenes-neues-passwort' } })).status).toBe(200);
    expect((await n.req('GET', '/api/wissen')).status).toBe(200);
    // Nicht-Admin darf nicht zurücksetzen
    expect((await n.req('POST', `/api/benutzer/${u.nutzer.leser.id}/passwort-zuruecksetzen`)).status).toBe(403);
  });

  it('abgelaufenes Token → 401', async () => {
    const u = await umgebung();
    const leser = await userVon(u, 'leser');
    const { token } = u.app.zugang.erzeuge(leser, { art: 'mcp', gueltigSek: -1 });
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(401);
  });
});

describe('M5: MCP Origin, Scope, Limits, OAuth-Metadaten', () => {
  it('fremder Origin → 403, eigener Origin und ohne Origin erlaubt (Repro R3)', async () => {
    const u = await umgebung({ KERN_MCP_ORIGINS: 'https://app.erlaubt.example' });
    const { token } = u.app.erzeugeToken(await userVon(u, 'leser'));
    expect((await mcp(u, token, toolCall('kern_eingang'), { origin: 'http://boese.example' })).status).toBe(403);
    expect((await mcp(u, token, toolCall('kern_eingang'), { origin: 'null' })).status).toBe(403);
    expect((await mcp(u, token, toolCall('kern_eingang'), { origin: 'http://kern.test' })).status).toBe(200);
    expect((await mcp(u, token, toolCall('kern_eingang'), { origin: 'https://app.erlaubt.example' })).status).toBe(200);
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(200);
  });

  it('401 mit resource_metadata; Protected Resource Metadata (RFC 9728) ohne Login', async () => {
    const u = await umgebung({ KERN_PUBLIC_URL: 'https://kunde.example.de' });
    const r = await mcp(u, null, toolCall('kern_eingang'));
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://kunde.example.de/.well-known/oauth-protected-resource/mcp"');
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const m = await u.app.app.request(`http://kern.test${p}`);
      expect(m.status).toBe(200);
      const j = await m.json();
      expect(j.resource).toBe('https://kunde.example.de/mcp');
      expect(j.scopes_supported).toContain('kern:lesen');
      expect(j.bearer_methods_supported).toEqual(['header']);
    }
    // andere Discovery-Pfade nie als HTML-Oberfläche
    const fremd = await u.app.app.request('http://kern.test/.well-known/oauth-authorization-server');
    expect(fremd.status).toBe(404);
    expect(fremd.headers.get('content-type')).toContain('application/json');
  });

  it('Scope: Token nur kern:lesen → 403 insufficient_scope (HTTP), Leser ohne Erweiterungsangebot', async () => {
    const u = await umgebung();
    const { token } = u.app.erzeugeToken(await userVon(u, 'autor'), { scopes: ['kern:lesen'] });
    const f = await mcp(u, token, toolCall('kern_frage', { frage: 'Urlaub?' }));
    expect(f.status).toBe(403);
    expect(f.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(f.headers.get('www-authenticate')).toContain('scope="kern:lesen kern:fragen"');
    const v = await mcp(u, token, toolCall('kern_vorschlag', { art: 'neu', ziel: 'wissen/x.md', neu: '# x', grund: 'Test' }));
    expect(v.status).toBe(403);
    expect(v.headers.get('www-authenticate')).toContain('kern:vorschlagen');
    const s = await (await mcp(u, token, toolCall('kern_suche', { anfrage: 'Urlaub' }))).json();
    expect(s.result.isError).toBeFalsy();
    // Leser: kein Angebot zur Erweiterung
    const l = u.app.erzeugeToken(await userVon(u, 'leser'), { scopes: ['kern:lesen'] });
    const lv = await mcp(u, l.token, toolCall('kern_vorschlag', { art: 'neu', ziel: 'wissen/x.md', neu: '# x', grund: 'Test' }));
    expect(lv.status).toBe(403);
    expect(lv.headers.get('www-authenticate')).toContain('scope="kern:lesen"');
    expect(lv.headers.get('www-authenticate')).toContain('Rolle');
  });

  it('Zielgruppe: Token für eine andere Ressource → 401', async () => {
    const u = await umgebung();
    const { token } = u.app.zugang.erzeuge(await userVon(u, 'leser'), { art: 'oauth_zugriff', zielgruppe: 'https://anderer.example/mcp' });
    expect((await mcp(u, token, toolCall('kern_eingang'))).status).toBe(401);
  });

  it('Ratenlimit für Fragen (REST und MCP gemeinsam) → 429 (Repro R6)', async () => {
    const u = await umgebung({ KERN_LIMIT_FRAGEN_MINUTE: '5' });
    const l = new Client(u.app.app);
    await l.login('leser');
    const st: number[] = [];
    for (let i = 0; i < 5; i++) st.push((await l.req('POST', '/api/frage', { json: { frage: `Urlaub ${i}?` } })).status);
    expect(st.every((s) => s === 200)).toBe(true);
    const r = await l.req('POST', '/api/frage', { json: { frage: 'noch eine?' } });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    const { token } = u.app.erzeugeToken(await userVon(u, 'leser'));
    const m = await (await mcp(u, token, toolCall('kern_frage', { frage: 'Urlaub?' }))).json();
    expect(m.result.isError).toBe(true);
    expect(m.result.content[0].text).toContain('429');
  });

  it('Ratenlimit je Token → 429', async () => {
    const u = await umgebung({ KERN_LIMIT_MCP_MINUTE: '3' });
    const { token } = u.app.erzeugeToken(await userVon(u, 'leser'));
    const st: number[] = [];
    for (let i = 0; i < 4; i++) st.push((await mcp(u, token, toolCall('kern_eingang', {}, i))).status);
    expect(st).toEqual([200, 200, 200, 429]);
  });
});

describe('P2: Cookies, HSTS, Sichtbarkeit, Protokolle', () => {
  it('HSTS und Secure-Cookie, sobald der eigene Proxy HTTPS meldet, ohne NODE_ENV', async () => {
    const u = await umgebung({ KERN_TRUST_PROXY: '1' });
    const r = await u.app.app.request('http://kern.test/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ name: 'admin', passwort: PASSWORT }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('strict-transport-security')).toContain('max-age=');
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-kern_sitzung=.*Secure/i);
    // ohne vertrauten Proxy zählt der Header nicht
    const v = await umgebung();
    const r2 = await v.app.app.request('http://kern.test/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    expect(r2.headers.get('strict-transport-security')).toBeNull();
    // Managed: immer sicher
    expect(ladeKonfiguration({ dataDir: v.dir, env: { KERN_SECRET: SECRET, KERN_MODUS: 'managed' } }).secureCookie).toBe(true);
    expect(ladeKonfiguration({ dataDir: v.dir, env: { KERN_SECRET: SECRET, KERN_PUBLIC_URL: 'https://x.example' } }).secureCookie).toBe(true);
  });

  it('KI-Endpunkt nur für Admins sichtbar (Einstellungen und Datenweg)', async () => {
    const u = await umgebung({ KERN_PROVIDER: 'ollama', KERN_PROVIDER_URL: 'http://intern-gpu.lan:11434' });
    const l = new Client(u.app.app);
    await l.login('leser');
    const e = await (await l.req('GET', '/api/einstellungen')).json();
    expect(e.provider.art).toBe('ollama');
    expect(e.provider.url).toBeNull();
    expect(JSON.stringify(await (await l.req('GET', '/api/datenweg')).json())).not.toContain('intern-gpu');
    const a = new Client(u.app.app);
    await a.login('admin');
    expect((await (await a.req('GET', '/api/einstellungen')).json()).provider.url).toContain('intern-gpu');
  });

  it('keine Pfade in Fehlermeldungen, keine Titel im Planer-Log', () => {
    expect(ohnePfade("ENOENT: Pfad ungültig '/srv/kunde/kern-data/quellen/2026/geheim.md'")).not.toContain('/srv');
    expect(ohnePfade('ungültig C:\\Daten\\kunde\\x.md')).not.toContain('Daten');
    const z = zusammenfassung({ geaendert: [{ titel: 'Geheimer Titel', url: 'https://intern.example/x' }], fehler: 0 });
    expect(z).toBe('geaendert: 1, fehler: 0');
  });
});
