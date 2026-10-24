/**
 * S2 gegen das echte @kern/core (C1, Commits fd33686 und 20d3a7d): 5-Minuten-Weg, Export, kern-zip-Import,
 * Verbrauch, Ausstiegsprobe. Übersprungen, solange packages/core/dist fehlt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erstelleApp, ladeKonfiguration, starteServer, type KernLike } from '../src/index.js';
import { Client } from './helfer.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(hier, '../../core/dist/index.js');
const coreDa = fs.existsSync(coreDist) && process.env.KERN_OHNE_CORE !== '1';
const PW = 'integration-passwort';
const BT = 't'.repeat(40);
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function bisFertig<T>(f: () => Promise<T>, ok: (x: T) => boolean, ms = 30_000): Promise<T> {
  const ende = Date.now() + ms;
  for (;;) { const x = await f(); if (ok(x) || Date.now() > ende) return x; await warte(100); }
}

describe.skipIf(!coreDa)('S2 mit echtem core', () => {
  const ordner: string[] = [];
  const kerne: KernLike[] = [];
  async function instanz() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-s2-'));
    ordner.push(dir);
    const config = ladeKonfiguration({ dataDir: dir, env: { KERN_SECRET: 'z'.repeat(40), KERN_WEB_DIST: path.join(dir, 'x'), KERN_BETRIEB_TOKEN: BT } });
    const mod = (await import(coreDist)) as { Kern: { open(c: unknown): Promise<KernLike> } };
    const kern = await mod.Kern.open(config.kern);
    kerne.push(kern);
    await kern.benutzer.anlegen('chef', PW, ['admin']);
    const k = erstelleApp({ kern, config });
    const a = new Client(k.app);
    await a.login('chef', PW);
    return { dir, kern, app: k.app, a };
  }
  let erste: Awaited<ReturnType<typeof instanz>>;
  beforeAll(async () => { erste = await instanz(); }, 60_000);
  afterAll(async () => {
    for (const k of kerne) await k.schliesse?.().catch(() => {});
    for (const d of ordner) fs.rmSync(d, { recursive: true, force: true });
  });

  it('5-Minuten-Weg: Schritt ki, Weg ohne, Beispiel laden, Vorschlagsfrage, belegte Antwort ohne KI', async () => {
    const { a } = erste;
    let e = await (await a.req('GET', '/api/einrichtung')).json();
    expect(e.schritt).toBe('ki');
    expect((await (await a.req('PUT', '/api/einrichtung/ki', { json: { weg: 'ohne' } })).json()).verbindung).toBe('ok');
    const b = await a.req('POST', '/api/einrichtung/beispiel', { json: { aktion: 'laden' } });
    expect(b.status, await b.clone().text()).toBe(200);
    e = await b.json();
    expect(e.beispiel_geladen).toBe(true);
    expect(e.vorschlagsfragen.length).toBeGreaterThan(0);
    expect(e.vorschlagsfragen.length).toBeLessThanOrEqual(3);
    const f = await (await a.req('POST', '/api/frage', { json: { frage: 'Wann muss ich einen Urlaubsantrag einreichen?' } })).json();
    expect(f.ki_erzeugt).toBe(false);
    e = await (await a.req('GET', '/api/einrichtung')).json();
    if (f.status === 'beantwortet') expect(e.erste_belegte_antwort).not.toBeNull();
  }, 60_000);

  it('Export zip, okf, umzugspaket über REST; Download; Verbrauch im Status', async () => {
    const { a, app } = erste;
    for (const [art, extra] of [['zip', {}], ['okf', {}], ['umzugspaket', { passphrase: 'eine-lange-passphrase' }]] as const) {
      const r = await a.req('POST', '/api/export', { json: { art, ...extra } });
      expect(r.status, `${art}: ${await r.clone().text()}`).toBe(202);
      const { id } = await r.json();
      const st = await bisFertig(async () => (await a.req('GET', `/api/export/${id}`)).json(), (x) => x.status !== 'laeuft');
      expect(st.status, `${art}: ${st.fehler ?? ''}`).toBe('fertig');
      expect(st.bytes).toBeGreaterThan(0);
      const d = await a.req('GET', `/${st.link}`);
      expect(d.status).toBe(200);
      expect(Buffer.from(await d.arrayBuffer()).length).toBe(st.bytes);
    }
    const s = await (await app.request('http://kern.test/_betrieb/status', { headers: { authorization: `Bearer ${BT}` } }, { incoming: { socket: { remoteAddress: '10.0.0.2' } } })).json();
    expect(typeof s.ki_verbrauch_cent_monat).toBe('number');
  }, 120_000);

  it('kern-zip aus Instanz 1 in Instanz 2 einspielen', async () => {
    const { a } = erste;
    const r = await (await a.req('POST', '/api/export', { json: { art: 'zip' } })).json();
    const st = await bisFertig(async () => (await a.req('GET', `/api/export/${r.id}`)).json(), (x) => x.status !== 'laeuft');
    const zip = Buffer.from(await (await a.req('GET', `/${st.link}`)).arrayBuffer());
    const zweite = await instanz();
    const f = new FormData();
    f.set('art', 'kern-zip');
    f.set('datei', new File([zip], 'kern-export.zip'));
    const imp = await zweite.a.req('POST', '/api/importieren', { body: f });
    expect(imp.status, await imp.clone().text()).toBe(201);
    expect((await imp.json()).quellen).toBeGreaterThan(0);
  }, 120_000);

  it('Stufenwechsel: /_betrieb/export umzugspaket mit bytes, sha256, Datei und erzeugter Passphrase; Ziel packt beim Start aus und prüft', async () => {
    const { app } = erste;
    const intern = { incoming: { socket: { remoteAddress: '10.0.0.2' } } };
    const r = await app.request('http://kern.test/_betrieb/export', { method: 'POST', headers: { authorization: `Bearer ${BT}`, 'content-type': 'application/json' }, body: JSON.stringify({ art: 'umzugspaket' }) }, intern);
    expect(r.status, await r.clone().text()).toBe(200);
    const j = await r.json();
    expect(j.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(j.bytes).toBeGreaterThan(0);
    expect(j.passphrase.length).toBeGreaterThanOrEqual(24);
    expect(fs.existsSync(j.datei)).toBe(true);
    const ziel = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-s2-ziel-'));
    ordner.push(ziel);
    const env = { KERN_SECRET: 'y'.repeat(40), KERN_WEB_DIST: path.join(ziel, 'x'), KERN_BETRIEB_TOKEN: BT, KERN_IMPORT_PAKET: j.datei, KERN_IMPORT_PASSPHRASE: j.passphrase, HOST: '127.0.0.1' };
    const s = await starteServer({ config: ladeKonfiguration({ dataDir: ziel, port: 0, env }), beobachten: false, leise: true });
    try {
      const b = await (await s.app.app.request('http://kern.test/_betrieb/pruefbericht', { headers: { authorization: `Bearer ${BT}` } }, intern)).json();
      expect(b).toMatchObject({ format: 'kern-pruefbericht/1', pruefsummen_ok: true, head_gleich: true });
      expect(b.pruefbericht_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(b)).not.toMatch(/quellen\/|wissen\//);
      const a = new Client(s.app.app);
      expect((await a.login('chef', PW)).status).toBe(200);
    } finally { await s.stop(); }
  }, 120_000);

  it('Ausstiegsprobe über REST', async () => {
    const { a } = erste;
    const r = await a.req('POST', '/api/ausstiegsprobe', { json: {} });
    expect(r.status, await r.clone().text()).toBe(202);
    const p = await bisFertig(async () => a.req('GET', '/api/ausstiegsprobe'), (x) => x.status !== 202, 90_000);
    expect(p.status).toBe(200);
    const j = await p.json();
    expect(typeof j.bestanden).toBe('boolean');
  }, 120_000);
});
