/**
 * v1.4 6.1/6.2: OAuth 2.1 für MCP gegen das echte core (Zugangsspeicher mit OAuth).
 * Ablauf wie Claude (Callback https://claude.ai/api/mcp/auth_callback) und ChatGPT (CIMD).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { erstelleApp, f12Hinweis, ladeKonfiguration, type KernLike } from '../src/index.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(hier, '../../core/dist/index.js');
const coreDa = fs.existsSync(coreDist) && process.env.KERN_OHNE_CORE !== '1';
const PW = 'oauth-passwort-123';
const BASIS = 'https://kunde.example.de';
const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';
const CIMD = 'https://chatgpt.com/.well-known/mcp-client.json';
const CHATGPT_CB = 'https://chatgpt.com/connector_platform_oauth_redirect';

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

describe.skipIf(!coreDa)('OAuth 2.1 Autorisierungsserver (echtes core)', () => {
  let dir: string;
  let kern: KernLike;
  let app: ReturnType<typeof erstelleApp>['app'];
  let cimdAbrufe = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-oauth-'));
    const config = ladeKonfiguration({ dataDir: dir, env: { KERN_SECRET: 'o'.repeat(40), KERN_PUBLIC_URL: BASIS, KERN_WEB_DIST: path.join(dir, 'x') } });
    const mod = (await import(coreDist)) as { Kern: { open(c: unknown): Promise<KernLike> } };
    kern = await mod.Kern.open(config.kern);
    await kern.benutzer.anlegen('autor', PW, ['autor']);
    await kern.benutzer.anlegen('leser', PW, ['leser']);
    ({ app } = erstelleApp({
      kern, config,
      abruf: async (url) => {
        cimdAbrufe++;
        const doc = url === CIMD ? { client_id: CIMD, client_name: 'ChatGPT', redirect_uris: [CHATGPT_CB], token_endpoint_auth_method: 'none' } : { client_id: 'falsch' };
        return { status: 200, typ: 'application/json', text: () => JSON.stringify(doc) };
      },
    }));
  }, 60000);
  afterAll(async () => { await kern.schliesse?.(); fs.rmSync(dir, { recursive: true, force: true }); });

  const req = (p: string, init: RequestInit = {}) => app.request(`${BASIS}${p}`, { redirect: 'manual', ...init });
  let cookie = '';
  const mitCookie = (h: Record<string, string> = {}) => ({ ...h, ...(cookie ? { cookie } : {}) });

  /** Kompletter Browser-Ablauf bis zum Code. */
  async function autorisiere(o: { clientId: string; redirect: string; scope?: string; name?: string; resource?: string }) {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, redirect_uri: o.redirect, code_challenge: challenge, code_challenge_method: 'S256', scope: o.scope ?? 'kern:lesen kern:fragen', state: 'zustand123', resource: o.resource ?? `${BASIS}/mcp` });
    cookie = '';
    let r = await req(`/oauth/authorize?${q}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Anmelden');
    const login = new URLSearchParams({ ...Object.fromEntries(q), name: o.name ?? 'autor', passwort: PW });
    r = await req('/oauth/anmelden', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASIS }, body: login });
    expect(r.status, await r.clone().text()).toBe(303);
    cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    r = await req(r.headers.get('location')!, { headers: mitCookie() });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('geht an den Anbieter dieses Programms'); // F12-Pflichthinweis
    // wortgleich mit web F12Hinweis, Produktname aus produkt.name; Zustimmung erst nach dem Hinweis (Formular danach)
    expect(html).toContain(f12Hinweis('Kern'));
    expect(html.indexOf('id="f12"')).toBeLessThan(html.indexOf('<form'));
    expect(html).toContain(new URL(o.redirect).hostname);
    expect(r.headers.get('content-security-policy')).toContain(`form-action 'self' ${new URL(o.redirect).origin}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    r = await req('/oauth/authorize', { method: 'POST', headers: mitCookie({ 'content-type': 'application/x-www-form-urlencoded', origin: BASIS }), body: new URLSearchParams({ ...Object.fromEntries(q), csrf, entscheidung: 'erlauben' }) });
    expect(r.status).toBe(302);
    const ziel = new URL(r.headers.get('location')!);
    return { ziel, verifier };
  }

  const token = (f: Record<string, string>) => req('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f) });
  const mcp = (t: string, name = 'kern_eingang') => req('/mcp', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: name === 'kern_suche' ? { anfrage: 'x' } : {} } }) });

  it('Discovery: PRM nennt die Instanz als Autorisierungsserver, AS-Metadaten nach RFC 8414 mit CIMD, S256, none, iss', async () => {
    const prm = await (await req('/.well-known/oauth-protected-resource/mcp')).json();
    expect(prm.authorization_servers).toEqual([BASIS]);
    expect(prm.resource).toBe(`${BASIS}/mcp`);
    const as = await (await req('/.well-known/oauth-authorization-server')).json();
    expect(as).toMatchObject({
      issuer: BASIS, authorization_endpoint: `${BASIS}/oauth/authorize`, token_endpoint: `${BASIS}/oauth/token`,
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    });
    expect(as.scopes_supported).not.toContain('kern:verwalten');
    const r = await req('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${BASIS}/.well-known/oauth-protected-resource/mcp", scope="kern:lesen kern:fragen"`);
  });

  it('Claude-Weg (DCR): Registrierung, Zustimmung, Code mit iss, Token, MCP, Rotation, Wiederverwendung widerruft die Familie', async () => {
    const reg = await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_CB], token_endpoint_auth_method: 'none' }) });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const { ziel, verifier } = await autorisiere({ clientId: client_id, redirect: CLAUDE_CB });
    expect(`${ziel.origin}${ziel.pathname}`).toBe(CLAUDE_CB);
    expect(ziel.searchParams.get('state')).toBe('zustand123');
    expect(ziel.searchParams.get('iss')).toBe(BASIS);
    const code = ziel.searchParams.get('code')!;
    // falscher Verifier → invalid_grant, und der Code ist danach verbraucht
    const falsch = await token({ grant_type: 'authorization_code', code, client_id, redirect_uri: CLAUDE_CB, code_verifier: pkce().verifier, resource: `${BASIS}/mcp` });
    expect((await falsch.json()).error).toBe('invalid_grant');
    // neuer Durchlauf, richtig
    const z2 = await autorisiere({ clientId: client_id, redirect: CLAUDE_CB });
    const t = await token({ grant_type: 'authorization_code', code: z2.ziel.searchParams.get('code')!, client_id, redirect_uri: CLAUDE_CB, code_verifier: z2.verifier, resource: `${BASIS}/mcp` });
    expect(t.status).toBe(200);
    const tj = await t.json();
    expect(tj.token_type).toBe('Bearer');
    expect(tj.expires_in).toBeLessThanOrEqual(3600);
    expect(tj.scope).toBe('kern:lesen kern:fragen');
    expect((await mcp(tj.access_token)).status).toBe(200);
    // Code ein zweites Mal → abgelehnt
    expect((await token({ grant_type: 'authorization_code', code: z2.ziel.searchParams.get('code')!, client_id, redirect_uri: CLAUDE_CB, code_verifier: z2.verifier, resource: `${BASIS}/mcp` })).status).toBe(400);
    // schrittweise Rechte: vorschlagen fehlt → 403 insufficient_scope
    const v = await mcp(tj.access_token, 'kern_vorschlag');
    expect(v.status).toBe(403);
    expect(v.headers.get('www-authenticate')).toContain('scope="kern:lesen kern:fragen kern:vorschlagen"');
    // Rotation
    const e1 = await (await token({ grant_type: 'refresh_token', refresh_token: tj.refresh_token, client_id })).json();
    expect(e1.access_token).toBeTruthy();
    expect(e1.refresh_token).not.toBe(tj.refresh_token);
    // alte Erneuerung erneut → Familie widerrufen
    expect((await (await token({ grant_type: 'refresh_token', refresh_token: tj.refresh_token, client_id })).json()).error).toBe('invalid_grant');
    expect((await mcp(e1.access_token)).status).toBe(401);
  });

  it('ChatGPT-Weg (CIMD): client_id ist eine HTTPS-URL, Dokument wird geprüft', async () => {
    const vorher = cimdAbrufe;
    const { ziel, verifier } = await autorisiere({ clientId: CIMD, redirect: CHATGPT_CB });
    expect(cimdAbrufe).toBeGreaterThan(vorher);
    const t = await (await token({ grant_type: 'authorization_code', code: ziel.searchParams.get('code')!, client_id: CIMD, redirect_uri: CHATGPT_CB, code_verifier: verifier, resource: `${BASIS}/mcp` })).json();
    expect((await mcp(t.access_token, 'kern_suche')).status).toBe(200);
    // Verbundene Apps: sichtbar und widerrufbar
    const apps = await (await req('/api/ich/apps', { headers: mitCookie() })).json();
    expect(apps.map((a: { clientId: string }) => a.clientId)).toContain(CIMD);
    expect((await req(`/api/ich/apps/${encodeURIComponent(CIMD)}`, { method: 'DELETE', headers: mitCookie({ 'x-kern': '1' }) })).status).toBe(200);
    expect((await mcp(t.access_token)).status).toBe(401);
    // falsches Dokument (client_id passt nicht) → Fehlerseite, keine Umleitung
    const q = new URLSearchParams({ response_type: 'code', client_id: 'https://boese.example/client.json', redirect_uri: 'https://boese.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: `${BASIS}/mcp` });
    const r = await req(`/oauth/authorize?${q}`);
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
  });

  it('Fehlerfälle: falsche redirect_uri ohne Umleitung, ohne PKCE und mit fremder resource per Umleitung mit error und iss', async () => {
    const { client_id } = await (await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'X', redirect_uris: [CLAUDE_CB] }) })).json();
    const basis = { response_type: 'code', client_id, redirect_uri: CLAUDE_CB, code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: `${BASIS}/mcp`, state: 's' };
    expect((await req(`/oauth/authorize?${new URLSearchParams({ ...basis, redirect_uri: 'https://boese.example/cb' })}`)).status).toBe(400);
    const ohnePkce = await req(`/oauth/authorize?${new URLSearchParams({ ...basis, code_challenge_method: 'plain' })}`);
    expect(ohnePkce.status).toBe(302);
    const l = new URL(ohnePkce.headers.get('location')!);
    expect(l.searchParams.get('error')).toBe('invalid_request');
    expect(l.searchParams.get('iss')).toBe(BASIS);
    const fremd = new URL((await req(`/oauth/authorize?${new URLSearchParams({ ...basis, resource: 'https://anderer.example/mcp' })}`)).headers.get('location')!);
    expect(fremd.searchParams.get('error')).toBe('invalid_target');
    // kern:verwalten nie über OAuth
    const v = new URL((await req(`/oauth/authorize?${new URLSearchParams({ ...basis, scope: 'kern:verwalten' })}`)).headers.get('location')!);
    expect(v.searchParams.get('error')).toBe('invalid_scope');
    // DCR mit unsicherer redirect_uri → 400
    expect((await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://boese.example/cb'] }) })).status).toBe(400);
    // Formular ohne gültiges csrf → 403
    expect((await req('/oauth/authorize', { method: 'POST', headers: mitCookie({ 'content-type': 'application/x-www-form-urlencoded', origin: BASIS }), body: new URLSearchParams({ ...basis, csrf: 'x', entscheidung: 'erlauben' }) })).status).toBe(403);
  });

  it('Leser bekommt mit angefragtem kern:vorschlagen keinen Schreibweg', async () => {
    const { client_id } = await (await req('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Y', redirect_uris: [CLAUDE_CB] }) })).json();
    const { ziel, verifier } = await autorisiere({ clientId: client_id, redirect: CLAUDE_CB, scope: 'kern:lesen kern:vorschlagen', name: 'leser' });
    const t = await (await token({ grant_type: 'authorization_code', code: ziel.searchParams.get('code')!, client_id, redirect_uri: CLAUDE_CB, code_verifier: verifier, resource: `${BASIS}/mcp` })).json();
    expect(t.scope).toBe('kern:lesen');
    const v = await mcp(t.access_token, 'kern_vorschlag');
    expect(v.status).toBe(403);
    expect(v.headers.get('www-authenticate')).toContain('Rolle');
  });
});

describe.skipIf(!coreDa)('6.2 „Nur bekannte Apps“ im Managed-Betrieb standardmäßig an', () => {
  it('DCR mit unbekannter App → 400, Claude → 201; im kern.yaml abschaltbar', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-oauth-m-'));
    const env = { KERN_SECRET: 'm'.repeat(40), KERN_PUBLIC_URL: BASIS, KERN_WEB_DIST: path.join(dir, 'x'), KERN_MODUS: 'managed' };
    const config = ladeKonfiguration({ dataDir: dir, env });
    const mod = (await import(coreDist)) as { Kern: { open(c: unknown): Promise<KernLike> } };
    const kern = await mod.Kern.open(config.kern);
    try {
      const { app } = erstelleApp({ kern, config });
      const reg = (uri: string) => app.request(`${BASIS}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'X', redirect_uris: [uri] }) });
      expect((await reg('https://unbekannt.example/cb')).status).toBe(400);
      expect((await reg(CLAUDE_CB)).status).toBe(201);
      fs.writeFileSync(path.join(dir, 'kern.yaml'), 'oauth:\n  nur_bekannte_apps: false\n');
      expect((await reg('https://unbekannt.example/cb')).status).toBe(201);
    } finally { await kern.schliesse?.(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
