import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { starteServer, MCP_TOOLS, type LaufenderServer } from '../src/index.js';
import { baueUmgebung, type TestUmgebung } from './helfer.js';

let u: TestUmgebung;
let s: LaufenderServer;
let tokenLeser = '';
let tokenAutor = '';

const PORT = Number(process.env.KERN_TEST_PORT ?? 4301);

beforeAll(async () => {
  u = await baueUmgebung();
  s = await starteServer({ config: { ...u.config, port: PORT, host: '127.0.0.1' }, kern: u.kern, leise: true });
  const alle = await u.kern.benutzer.liste();
  tokenLeser = s.app.erzeugeToken(alle.find((x) => x.id === u.nutzer.leser.id)!, { bezeichnung: 'Test' }).token;
  tokenAutor = s.app.erzeugeToken(alle.find((x) => x.id === u.nutzer.autor.id)!, { bezeichnung: 'Test', scopes: ['kern:lesen', 'kern:fragen', 'kern:vorschlagen'] }).token;
});
afterAll(async () => { await s.stop(); u.aufraeumen(); });

async function verbinde(token: string) {
  const c = new McpClient({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

describe('MCP über Streamable HTTP (echter Port)', () => {
  it('ohne Token 401 mit WWW-Authenticate', async () => {
    const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Bearer');
    const f = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer kern_falsch', 'content-type': 'application/json' }, body: '{}' });
    expect(f.status).toBe(401);
  });

  it('Werkzeugliste mit deutschen Beschreibungen und Schemas', async () => {
    const c = await verbinde(tokenLeser);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
    expect(tools.find((t) => t.name === 'kern_suche')!.inputSchema.required).toContain('anfrage');
    await c.close();
  });

  it('kern_suche, kern_lese, kern_frage, kern_fakten, kern_briefing, kern_eingang', async () => {
    const c = await verbinde(tokenLeser);
    const t = text(await c.callTool({ name: 'kern_suche', arguments: { anfrage: 'Urlaub' } }));
    expect(t[0].pfad).toBeTruthy();
    const a = text(await c.callTool({ name: 'kern_lese', arguments: { pfad: 'wissen/betrieb/urlaub.md' } }));
    expect(a.kopf.titel).toBe('Urlaubsregel');
    const q = text(await c.callTool({ name: 'kern_lese', arguments: { pfad: 'quellen/2026/handbuch.md' } }));
    expect(q.kopf.titel).toBe('Handbuch');
    const boese = await c.callTool({ name: 'kern_lese', arguments: { pfad: '../.kern/users.json' } });
    expect(boese.isError).toBe(true);
    const f = text(await c.callTool({ name: 'kern_frage', arguments: { frage: 'Wann Urlaub beantragen?' } }));
    expect(f.status).toBe('beantwortet');
    expect(f.belege.length).toBeGreaterThan(0);
    const fk = text(await c.callTool({ name: 'kern_fakten', arguments: { art: 'frist' } }));
    expect(fk[0].gegenstand).toContain('Urlaub');
    expect(text(await c.callTool({ name: 'kern_briefing', arguments: {} })).text).toBeTruthy();
    expect(Array.isArray(text(await c.callTool({ name: 'kern_eingang', arguments: {} })))).toBe(true);
    await c.close();
  });

  it('kern_vorschlag: Leser abgewiesen, Autor legt nur Vorschlag an', async () => {
    const leser = await verbinde(tokenLeser);
    // v1.4 6.1: fehlender Scope → HTTP 403 insufficient_scope; der SDK-Client meldet das als Fehler.
    await expect(leser.callTool({ name: 'kern_vorschlag', arguments: { art: 'neu', ziel: 'wissen/mcp/test.md', neu: '# Test', grund: 'Test über MCP' } })).rejects.toThrow();
    await leser.close();
    const autor = await verbinde(tokenAutor);
    const v = text(await autor.callTool({ name: 'kern_vorschlag', arguments: { art: 'neu', ziel: 'wissen/mcp/test.md', neu: '# Test', grund: 'Test über MCP' } }));
    expect(v.status).toBe('offen');
    expect(fs.existsSync(`${u.dir}/wissen/mcp/test.md`)).toBe(false);
    await autor.close();
  });

  it('REST über echten Port: healthz', async () => {
    const r = await fetch(`${s.url}/healthz`);
    expect((await r.json()).ok).toBe(true);
  });
});
