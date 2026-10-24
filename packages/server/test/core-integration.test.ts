/**
 * Integration gegen das echte @kern/core. Wird übersprungen, solange core nicht gebaut ist
 * (packages/core/dist fehlt). Prüft den Weg REST → core → Dateien/git → REST.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erstelleApp, ladeKonfiguration, type KernLike } from '../src/index.js';
import { Client } from './helfer.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(hier, '../../core/dist/index.js');
const coreSrc = path.resolve(hier, '../../core/src/kern.ts'); // enthält die Klasse Kern
// Bevorzugt den Build; ohne Build die Quellen (vitest übersetzt TypeScript selbst).
const coreEintrag = fs.existsSync(coreDist) ? coreDist : fs.existsSync(coreSrc) ? coreSrc : null;
const coreDa = coreEintrag !== null && process.env.KERN_OHNE_CORE !== '1';
const PW = 'integration-passwort';

describe.skipIf(!coreDa)('Integration mit echtem @kern/core', () => {
  let dir: string;
  let kern: KernLike;
  let app: ReturnType<typeof erstelleApp>['app'];
  let kernApp: ReturnType<typeof erstelleApp>;
  let kernRef: KernLike;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-int-'));
    const config = ladeKonfiguration({ dataDir: dir, env: { KERN_SECRET: 'z'.repeat(40), KERN_WEB_DIST: path.join(dir, 'x') } });
    const mod = (await import(coreEintrag!)) as { Kern: { open(c: unknown): Promise<KernLike> } };
    kern = await mod.Kern.open(config.kern);
    for (const [n, r] of [['chef', ['admin']], ['frei', ['freigeber']], ['autor', ['autor']], ['leser', ['leser']]] as const) {
      ids[n] = (await kern.benutzer.anlegen(n, PW, [...r])).id;
    }
    kernApp = erstelleApp({ kern, config });
    ({ app } = kernApp);
    kernRef = kern;
  }, 60000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('Login, Hinzufügen, Freigeben, Lesen, Verlauf, Fragen', async () => {
    const autor = new Client(app);
    expect((await autor.login('autor', PW)).status).toBe(200);
    const fd = new FormData();
    fd.set('datei', new File(['# Urlaub\n\nUrlaub wird drei Wochen vorher im Büro beantragt.\n'], 'urlaub.md'));
    fd.set('sammlung', 'betrieb');
    fd.set('sichtbarkeit', 'betrieb');
    fd.set('titel', 'Urlaubsregel');
    const r = await autor.req('POST', '/api/hinzufuegen', { body: fd });
    const body = await r.json();
    expect(r.status, JSON.stringify(body)).toBe(201);
    expect(body.quelle.pfad).toMatch(/^quellen\//);

    const q = await autor.req('GET', `/api/${body.quelle.pfad}`.replace('/api/quellen/', '/api/quellen/'));
    expect(q.status).toBe(200);

    const frei = new Client(app);
    await frei.login('frei', PW);
    const eingang = await (await frei.req('GET', '/api/eingang')).json();
    expect(Array.isArray(eingang)).toBe(true);
    expect(eingang.length).toBeGreaterThan(0);
    {
      const v = eingang[0];
      const leser = new Client(app);
      await leser.login('leser', PW);
      expect((await leser.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } })).status).toBe(403);
      const e = await frei.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben', begruendung: 'Integrationstest' } });
      const eb = await e.json();
      expect(e.status, JSON.stringify(eb)).toBe(200);
      expect(eb.status).toBe('freigegeben');
      const pfad = String(v.ziel).replace(/^wissen\//, '');
      const a = await leser.req('GET', `/api/wissen/${pfad}`);
      expect(a.status).toBe(200);
      const verlauf = await (await leser.req('GET', `/api/wissen/${pfad}/verlauf`)).json();
      expect(verlauf.length).toBeGreaterThan(0);
    }
    const antwort = await (await autor.req('POST', '/api/frage', { json: { frage: 'Wie lange vorher Urlaub beantragen?' } })).json();
    expect(['beantwortet', 'steht_nicht_drin']).toContain(antwort.status);
    expect(antwort.status).toBe('beantwortet');
    expect(antwort.belege.length).toBeGreaterThan(0);
    expect((await autor.req('GET', '/api/suche?q=Urlaub')).status).toBe(200);
    expect((await autor.req('GET', '/api/briefing')).status).toBe(200);
    expect((await autor.req('GET', '/api/faellig')).status).toBe(200);
    expect((await autor.req('GET', '/api/fakten')).status).toBe(200);
    const chef = new Client(app);
    await chef.login('chef', PW);
    const pr = await chef.req('POST', '/api/pruefen');
    expect(pr.status).toBe(200);
    expect(Array.isArray(await pr.json())).toBe(true);
    const es = await chef.req('PUT', '/api/einstellungen', { json: { betrieb: 'Integration GmbH' } });
    expect(es.status, await es.clone().text()).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'kern.yaml'), 'utf8')).toContain('Integration GmbH');
    expect((await chef.req('GET', '/api/datenweg')).status).toBe(200);
    const orig = await autor.req('GET', `/api/${body.quelle.pfad}/original`);
    expect(orig.status).toBe(200);
    expect(await orig.text()).toContain('drei Wochen');
    // MCP gegen echtes core (zustandslos, direkter tools/call)
    const leserU = (await kernRef.benutzer.liste()).find((x) => x.id === ids.leser)!;
    const tok = kernApp.erzeugeToken(leserU, { bezeichnung: 'int' }).token;
    const mcp = await app.request('http://kern.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kern_frage', arguments: { frage: 'Wie lange vorher Urlaub beantragen?' } } }),
    });
    expect(mcp.status).toBe(200);
    const mj = await mcp.json();
    expect(JSON.parse(mj.result.content[0].text).status).toBe('beantwortet');
    // v1.2: reservierter Name
    expect((await autor.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel: 'wissen/betrieb/index.md', neu: '# x', grund: 'Test' } })).status).toBe(400);
    expect((await autor.req('GET', '/api/wissen/..%2f.kern%2fusers.json')).status).toBe(404);
    expect((await autor.req('GET', '/api/wissen/gibt/es/nicht.md')).status).toBe(404);
  }, 60000);
});
