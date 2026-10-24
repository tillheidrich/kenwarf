/**
 * S3 gegen das echte @kern/core (E1, Commit 4714f25): Nachtrag und Sammelfreigabe (U10), Agenten-Zugänge mit Profil
 * und Reichweite (8.4), Gedächtnis-Adapter über MCP (8.5), abgelaufene Notizen, Prüfbank, Kontextbilanz und
 * Kontextpaket am echten core (8.1, 8.3, 9), Anhänge jeden Typs (U1) und Quellenkopf beim Hinzufügen (U8).
 * Übersprungen, solange packages/core/dist fehlt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { erstelleApp, ladeKonfiguration, leseKernYaml, schreibeKernYaml, type KernLike, type User } from '../src/index.js';
import { Client } from './helfer.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const coreDist = path.resolve(hier, '../../core/dist/index.js');
const coreDa = fs.existsSync(coreDist) && process.env.KERN_OHNE_CORE !== '1';
const PW = 'integration-passwort';
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const ARTIKEL = (titel: string, text: string, sichtbarkeit = 'betrieb') => `---
titel: ${titel}
gruppe: betrieb
kurzfassung: ${JSON.stringify(text.slice(0, 60))}
stand: 2026-10-01
verantwortlich: Chefin
pruefen_bis: 2027-10-01
sichtbarkeit: ${sichtbarkeit}
fundstellen: []
status: freigegeben
---
## ${titel}

${text}
`;

describe.skipIf(!coreDa)('S3: E1-Funktionen über REST, MCP und CLI-Helfer am echten core', () => {
  let dir: string;
  let kern: KernLike;
  let k: ReturnType<typeof erstelleApp>;
  const u: Record<string, User> = {};
  const c: Record<string, Client> = {};

  async function mcp(token: string, name: string, args: Record<string, unknown>) {
    const r = await k.app.request('http://kern.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: r.status, body: await r.json() as { result?: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { message: string } } };
  }
  async function token(cl: Client, b: Record<string, unknown>) {
    const r = await cl.req('POST', '/api/ich/tokens', { json: b });
    return { status: r.status, body: await r.json() };
  }
  /** Artikel über Vorschlag + Freigabe anlegen (echter Weg mit git). */
  async function artikel(ziel: string, titel: string, text: string, sichtbarkeit = 'betrieb') {
    const v = await kern.schlageVor(u.chef!, { art: 'neu', ziel, alt: null, neu: ARTIKEL(titel, text, sichtbarkeit), grund: 'Testaufbau' });
    const e = await kern.entscheide(u.chef!, v.id, { aktion: 'freigeben' });
    expect(e.status).toBe('freigegeben');
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-s3-'));
    const config = ladeKonfiguration({ dataDir: dir, env: { KERN_SECRET: 'z'.repeat(40), KERN_WEB_DIST: path.join(dir, 'x') } });
    const mod = (await import(coreDist)) as { Kern: { open(c: unknown): Promise<KernLike> } };
    kern = await mod.Kern.open(config.kern);
    for (const [n, r, t] of [['chef', ['admin'], []], ['frei', ['freigeber'], []], ['autor', ['autor'], ['buero']], ['leser', ['leser'], []]] as const) {
      u[n] = await kern.benutzer.anlegen(n, PW, [...r], [...t]);
    }
    k = erstelleApp({ kern, config });
    for (const n of Object.keys(u)) { c[n] = new Client(k.app); expect((await c[n]!.login(n, PW)).status).toBe(200); }
    await artikel('wissen/betrieb/urlaub.md', 'Urlaub', 'Urlaub wird drei Wochen vorher im Büro beantragt.');
    await artikel('wissen/betrieb/geheim.md', 'Autorennotiz', 'Nur für den Autor: Lagerschlüssel liegt im Tresor.', 'ich');
  }, 60_000);
  afterAll(async () => { await kern?.schliesse?.().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });

  it('U10 Nachtrag: REST hängt an, Leser 403, Vorschlag mit fremdem Anfang 400, Freigabe ergänzt den Artikel', async () => {
    expect((await c.leser!.req('POST', '/api/nachtrag', { json: { ziel: 'wissen/betrieb/urlaub.md', text: 'x', grund: 'Test' } })).status).toBe(403);
    expect((await c.autor!.req('POST', '/api/nachtrag', { json: { ziel: 'wissen/betrieb/urlaub.md', text: 'x', grund: 'Test' }, csrf: false })).status).toBe(403);
    const r = await c.autor!.req('POST', '/api/nachtrag', { json: { ziel: 'wissen/betrieb/urlaub.md', text: 'Ausnahme: im Dezember zwei Wochen.', grund: 'Neue Regel' } });
    const v = await r.json();
    expect(r.status, JSON.stringify(v)).toBe(201);
    expect(v.art).toBe('nachtrag');
    const falsch = await c.autor!.req('POST', '/api/vorschlag', { json: { art: 'nachtrag', ziel: 'wissen/betrieb/urlaub.md', neu: 'ganz anderer Text', grund: 'Test' } });
    expect(falsch.status).toBe(400);
    const e = await c.frei!.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } });
    expect(e.status, await e.clone().text()).toBe(200);
    const a = await (await c.leser!.req('GET', '/api/wissen/betrieb/urlaub.md')).json();
    expect(a.text).toContain('drei Wochen');
    expect(a.text).toContain('im Dezember zwei Wochen');
  });

  it('U10 Sammelfreigabe: Leser 403, ohne Filter 400, Freigeber ohne Regeln, Admin mit Regeln, CSRF Pflicht', async () => {
    const grund = 'Outline-Import Lauf 7';
    for (const [ziel, titel] of [['wissen/import/a.md', 'A'], ['wissen/import/b.md', 'B'], ['wissen/_regeln/import.md', 'Regel']] as const) {
      expect((await c.autor!.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel, neu: ARTIKEL(titel, `Text ${titel} aus dem Import.`), grund } })).status).toBe(201);
    }
    expect((await c.leser!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund } })).status).toBe(403);
    expect((await c.autor!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund } })).status).toBe(403);
    expect((await c.frei!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund }, csrf: false })).status).toBe(403);
    expect((await c.frei!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben' } })).status).toBe(400);
    const r = await c.frei!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund } });
    const b = await r.json();
    expect(r.status, JSON.stringify(b)).toBe(200);
    expect(b.gefunden).toBe(3);
    expect(b.freigegeben).toBe(2);
    expect(b.fehler).toHaveLength(1);
    expect(b.fehler[0].meldung).toContain('Admin');
    expect(fs.existsSync(path.join(dir, 'wissen/import/a.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'wissen/_regeln/import.md'))).toBe(false);
    const ad = await (await c.chef!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund } })).json();
    expect(ad.freigegeben).toBe(1);
    expect(fs.existsSync(path.join(dir, 'wissen/_regeln/import.md'))).toBe(true);
  });

  it('8.4 Agenten-Tokens: Profil passt zur Rolle, Scopes fest je Profil', async () => {
    expect((await token(c.leser!, { agent: 'Claude', profil: 'autor' })).status).toBe(403);
    expect((await token(c.leser!, { profil: 'leser' })).status).toBe(400);
    expect((await token(c.autor!, { agent: 'Claude', profil: 'leser', scopes: ['kern:lesen', 'kern:vorschlagen'] })).status).toBe(400);
    const l = await token(c.leser!, { agent: 'Claude' });
    expect(l.status).toBe(201);
    expect(l.body.eintrag.scopes.sort()).toEqual(['kern:fragen', 'kern:lesen']);
    expect(l.body.eintrag.agent).toBe('Claude');
    const a = await token(c.autor!, { agent: 'Claude', profil: 'autor', reichweite: 'team' });
    expect(a.status).toBe(201);
    expect(a.body.eintrag.scopes).toContain('kern:vorschlagen');
    expect(a.body.eintrag.reichweite).toBe('team');
  });

  it('8.5 kern_gedaechtnis: Agent leser darf nicht schreiben, Agent autor erzeugt Vorschläge und Notizen, Fehler als is_error', async () => {
    const leserAgent = (await token(c.autor!, { agent: 'Claude', profil: 'leser' })).body.token as string;
    const w = await mcp(leserAgent, 'kern_gedaechtnis', { command: 'create', path: '/memories/wissen/betrieb/neu.md', file_text: '# Neu\n\nText.' });
    expect(w.body.result?.isError).toBe(true);
    const n = await mcp(leserAgent, 'kern_gedaechtnis', { command: 'create', path: '/memories/notizen/a.md', file_text: 'x' });
    expect(n.body.result?.isError).toBe(true);
    expect(fs.existsSync(path.join(dir, 'wissen/betrieb/neu.md'))).toBe(false);
    const sicht = await mcp(leserAgent, 'kern_gedaechtnis', { command: 'view', path: '/memories/wissen' });
    expect(sicht.body.result?.isError).toBeFalsy();
    expect(sicht.body.result!.content[0]!.text).toContain('urlaub.md');

    const autorAgent = (await token(c.autor!, { agent: 'Claude', profil: 'autor' })).body.token as string;
    const v = await mcp(autorAgent, 'kern_gedaechtnis', { command: 'create', path: '/memories/wissen/betrieb/neu.md', file_text: '# Neu\n\nDer Agent hat das gelernt.' });
    expect(v.body.result?.isError, v.body.result?.content[0]?.text).toBeFalsy();
    expect(fs.existsSync(path.join(dir, 'wissen/betrieb/neu.md'))).toBe(false);
    const ids = (v.body.result?.structuredContent?.vorschlaege ?? []) as string[];
    expect(ids.length).toBe(1);
    const eing = await (await c.autor!.req('GET', '/api/eingang')).json() as { id: string; von: string }[];
    expect(eing.find((x) => x.id === ids[0])?.von).toBe(`agent/Claude@${u.autor!.id}`);
    const no = await mcp(autorAgent, 'kern_gedaechtnis', { command: 'create', path: '/memories/notizen/lauf.md', file_text: 'Zwischenstand Zebraformel' });
    expect(no.body.result?.isError, no.body.result?.content[0]?.text).toBeFalsy();
    expect(fs.readdirSync(path.join(dir, 'nutzer')).length).toBe(1);
    const such = await (await c.autor!.req('GET', '/api/suche?q=Zebraformel')).json() as unknown[];
    expect(such).toHaveLength(0);
    // ok:false → is_error, Pfadausbruch abgewiesen
    const f1 = await mcp(autorAgent, 'kern_gedaechtnis', { command: 'str_replace', path: '/memories/notizen/lauf.md', old_str: 'gibt es nicht', new_str: 'x' });
    expect(f1.body.result?.isError).toBe(true);
    expect(f1.body.result!.content[0]!.text).toContain('No replacement');
    const f2 = await mcp(autorAgent, 'kern_gedaechtnis', { command: 'view', path: '/memories/../.kern/users.json' });
    expect(f2.body.result?.isError).toBe(true);
    // Agent gibt nie frei: weder Einzel- noch Sammelfreigabe über MCP, auch wenn der Mensch Freigeber ist
    const freiAgent = (await token(c.frei!, { agent: 'Claude', profil: 'autor' })).body.token as string;
    const s = await mcp(freiAgent, 'kern_sammelfreigabe', { aktion: 'freigeben', ids });
    expect(s.status).toBe(403); // v1.4.2: Agenten bekommen kern:freigeben nie
    expect(fs.existsSync(path.join(dir, 'wissen/betrieb/neu.md'))).toBe(false);
  });

  it('U10 kern_sammelfreigabe ohne kern:freigeben 403; Nachtrag über kern_vorschlag mit Agent-Absender', async () => {
    const autorAgent = (await token(c.autor!, { agent: 'Codex', profil: 'autor' })).body.token as string;
    const n = await mcp(autorAgent, 'kern_vorschlag', { art: 'nachtrag', ziel: 'wissen/betrieb/urlaub.md', neu: 'Hinweis von Codex.', grund: 'Ergänzung' });
    expect(n.body.result?.isError, n.body.result?.content[0]?.text).toBeFalsy();
    const v = JSON.parse(n.body.result!.content[0]!.text);
    expect(v.art).toBe('nachtrag');
    expect(v.von).toBe(`agent/Codex@${u.autor!.id}`);
    const leserTok = (await token(c.leser!, { scopes: ['kern:lesen'] })).body.token as string;
    expect((await mcp(leserTok, 'kern_sammelfreigabe', { aktion: 'freigeben', ids: [v.id] })).status).toBe(403);
    // v1.4.2: ohne kern:freigeben kein Freigeben über MCP, auch nicht für Freigeber (positiver Weg: s3-freigeben.test.ts)
    const freiTok = (await token(c.frei!, { scopes: ['kern:lesen', 'kern:vorschlagen'] })).body.token as string;
    expect((await mcp(freiTok, 'kern_sammelfreigabe', { aktion: 'freigeben', von: `agent/Codex@${u.autor!.id}` })).status).toBe(403);
    expect(fs.readFileSync(path.join(dir, 'wissen/betrieb/urlaub.md'), 'utf8')).not.toContain('Hinweis von Codex.');
  });

  it('6.3 Reichweite des Zugangs gilt für Suche, Lesen, Kontextpaket und Gedächtnis', async () => {
    const ich = (await token(c.chef!, { agent: 'Lokal', profil: 'leser', reichweite: 'ich' })).body.token as string;
    const lese = await mcp(ich, 'kern_lese', { pfad: 'wissen/betrieb/urlaub.md' });
    expect(lese.body.result?.isError).toBe(true);
    const suche = JSON.parse((await mcp(ich, 'kern_suche', { anfrage: 'Urlaub', reichweite: 'betrieb' })).body.result!.content[0]!.text) as { pfad: string }[];
    expect(suche.some((t) => t.pfad === 'wissen/betrieb/urlaub.md')).toBe(false);
    const paket = JSON.parse((await mcp(ich, 'kern_kontext', { frage: 'Urlaub beantragen' })).body.result!.content[0]!.text) as { abschnitte: { pfad: string }[] };
    expect(paket.abschnitte.some((a) => a.pfad === 'wissen/betrieb/urlaub.md')).toBe(false);
    const sicht = (await mcp(ich, 'kern_gedaechtnis', { command: 'view', path: '/memories/wissen' })).body.result!.content[0]!.text;
    expect(sicht).not.toContain('urlaub.md');
    const voll = (await token(c.chef!, { agent: 'Lokal', profil: 'leser' })).body.token as string;
    expect((await mcp(voll, 'kern_lese', { pfad: 'wissen/betrieb/urlaub.md' })).body.result?.isError).toBeFalsy();
  });

  it('8.5 abgelaufene Notizen: nur die eigenen, löschen mit Rolle autor', async () => {
    const leer = await (await c.chef!.req('GET', '/api/ich/notizen/abgelaufen')).json();
    expect(leer.pfade).toEqual([]);
    expect((await (await c.autor!.req('GET', '/api/ich/notizen/abgelaufen')).json()).pfade).toEqual([]);
    const y = leseKernYaml(dir) as Record<string, unknown>;
    schreibeKernYaml(dir, { ...y, notizen: { ablauf_tage: -1 } } as never);
    const ab = await (await c.autor!.req('GET', '/api/ich/notizen/abgelaufen')).json();
    expect(ab.pfade).toEqual(['/memories/notizen/lauf.md']);
    expect((await (await c.leser!.req('GET', '/api/ich/notizen/abgelaufen')).json()).pfade).toEqual([]);
    expect((await c.leser!.req('POST', '/api/ich/notizen/abgelaufen/loeschen', { json: {} })).status).toBe(403);
    const l = await (await c.autor!.req('POST', '/api/ich/notizen/abgelaufen/loeschen', { json: { pfade: ['/memories/notizen/lauf.md', '/memories/notizen/fremd.md'] } })).json();
    expect(l.geloescht).toEqual(['/memories/notizen/lauf.md']);
    expect(l.nicht_abgelaufen).toEqual(['/memories/notizen/fremd.md']);
    expect((await (await c.autor!.req('GET', '/api/ich/notizen/abgelaufen')).json()).pfade).toEqual([]);
    schreibeKernYaml(dir, { ...(leseKernYaml(dir) as Record<string, unknown>), notizen: { ablauf_tage: 90 } } as never);
  });

  it('8.1, 8.3, 9 am echten core: Prüfbank-Lauf, Schätzung, Kontextbilanz, Kontextpaket mit Rechten', async () => {
    expect((await c.leser!.req('POST', '/api/pruefbank/lauf', { json: { satz: 'oeffentlich' } })).status).toBe(403);
    const s = await c.chef!.req('GET', '/api/pruefbank/schaetzung?satz=oeffentlich');
    expect(s.status, await s.clone().text()).toBe(200);
    expect((await s.json()).fragen).toBeGreaterThan(0);
    const r = await c.chef!.req('POST', '/api/pruefbank/lauf', { json: { satz: 'oeffentlich' } });
    expect(r.status).toBe(202);
    const { id } = await r.json();
    let l: Record<string, unknown> = {};
    for (let i = 0; i < 600; i++) {
      const x = await c.chef!.req('GET', `/api/pruefbank/${id}`);
      l = await x.json();
      if (x.status !== 202) break;
      await warte(100);
    }
    expect(l.status, JSON.stringify(l).slice(0, 300)).toBe('fertig');
    expect((l.kennzahlen as { belegtreue: number }).belegtreue).toBe(1);
    expect((l.kennzahlen as { lecks: number }).lecks).toBe(0);
    const liste = await (await c.chef!.req('GET', '/api/pruefbank')).json();
    expect(liste.laeufe.length).toBeGreaterThan(0);
    expect(typeof liste.vergleich).toBe('string');

    expect((await c.leser!.req('GET', '/api/kontextbilanz')).status).toBe(403);
    const kb = await c.frei!.req('GET', '/api/kontextbilanz');
    expect(kb.status, await kb.clone().text()).toBe(200);
    const kbj = await kb.json();
    expect(kbj.bestand.artikel).toBeGreaterThan(0);
    expect(kbj.pruefbank.letzterLauf).not.toBeNull();

    const p = await c.leser!.req('GET', '/api/kontextpaket?frage=Urlaub%20beantragen&budget=600');
    const pj = await p.json();
    expect(p.status, JSON.stringify(pj)).toBe(200);
    expect(pj.tokens).toBeLessThanOrEqual(600);
    expect(pj.abschnitte.some((a: { pfad: string }) => a.pfad === 'wissen/betrieb/urlaub.md')).toBe(true);
    expect(pj.abschnitte.some((a: { pfad: string }) => a.pfad === 'wissen/betrieb/geheim.md')).toBe(false);
    expect((await c.leser!.req('GET', '/api/kontextpaket?frage=x&reichweite=alles')).status).toBe(400);
  }, 120_000);

  it('U1 Anhänge: jeder Typ, Inhalt passt zur Endung, Grenze aus kern.yaml, Download nur mit Rechten', async () => {
    const hoch = async (cl: Client, name: string, inhalt: Uint8Array | string, extra: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.set('datei', new File([inhalt], name));
      fd.set('sammlung', 'anhaenge');
      for (const [a, b] of Object.entries(extra)) fd.set(a, b);
      const r = await cl.req('POST', '/api/hinzufuegen', { body: fd });
      return { status: r.status, body: await r.json() };
    };
    const bild = await hoch(c.autor!, 'logo.png', PNG);
    expect(bild.status, JSON.stringify(bild.body)).toBe(201);
    expect(bild.body.quelle.kopf.anhang).toBe(true);
    expect(bild.body.quelle.kopf.anhang_typ).toBe('bild');
    const o = await c.leser!.req('GET', `/api/${bild.body.quelle.pfad}/original`);
    expect(o.status).toBe(200);
    expect(o.headers.get('content-type')).toBe('image/png');
    expect(o.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await o.arrayBuffer()).equals(PNG)).toBe(true);
    const bin = await hoch(c.autor!, 'werkzeug.step', Buffer.from([0, 1, 2, 3, 250, 251]));
    expect(bin.status, JSON.stringify(bin.body)).toBe(201);
    expect(bin.body.quelle.kopf.anhang_typ).toBe('datei');
    const falsch = await hoch(c.autor!, 'rechnung.pdf', 'kein PDF, nur Text');
    expect(falsch.status).toBe(415);
    expect(falsch.body.code).toBe('typ_passt_nicht');
    expect((await hoch(c.autor!, 'text.md', Buffer.from([35, 0, 0, 1]))).status).toBe(415);
    // Team-Anhang: der Leser ist nicht im Team und bekommt ihn nicht
    const team = await hoch(c.autor!, 'plan.png', Buffer.concat([PNG, Buffer.from([1])]), { sichtbarkeit: 'team:buero' });
    expect(team.body.quelle.kopf.sichtbarkeit).toBe('team:buero');
    expect(team.status).toBe(201);
    expect((await c.leser!.req('GET', `/api/${team.body.quelle.pfad}/original`)).status).toBe(404);
    expect((await c.autor!.req('GET', `/api/${team.body.quelle.pfad}/original`)).status).toBe(200);
    // Grenze aus kern.yaml
    const y = leseKernYaml(dir) as Record<string, unknown>;
    schreibeKernYaml(dir, { ...y, anhaenge: { max_mb: 0.001 } } as never);
    const gross = await hoch(c.autor!, 'gross.bin', Buffer.alloc(4096, 7));
    expect(gross.status).toBe(413);
    expect(gross.body.code).toBe('zu_gross');
    schreibeKernYaml(dir, { ...(leseKernYaml(dir) as Record<string, unknown>), anhaenge: { max_mb: 25 } } as never);
  });

  it('U8 Quellenkopf: herkunft, extern_id (ersetzt gleiche ID), zusatz ohne Pflichtfelder', async () => {
    const neu = async (inhalt: string, zusatz: unknown) => {
      const r = await c.autor!.req('POST', '/api/hinzufuegen', { json: { art: 'text', titel: 'Outline Seite', inhalt, sammlung: 'outline', herkunft: 'https://wiki.example/doc/seite-abc', extern_id: 'abc', zusatz } });
      return { status: r.status, body: await r.json() };
    };
    const a = await neu('Erste Fassung der Seite.', { outline_id: 'abc', titel: 'überschrieben?' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.quelle.kopf.herkunft).toBe('https://wiki.example/doc/seite-abc');
    expect(a.body.quelle.kopf.extern_id).toBe('abc');
    expect(a.body.quelle.kopf.outline_id).toBe('abc');
    expect(a.body.quelle.kopf.titel).toBe('Outline Seite');
    const b = await neu('Zweite Fassung der Seite.', { outline_id: 'abc' });
    expect(b.status).toBe(201);
    expect(b.body.quelle.kopf.ersetzt).toBe(a.body.quelle.pfad);
    const fd = new FormData();
    fd.set('art', 'text'); fd.set('inhalt', 'x y z'); fd.set('zusatz', '{kein json');
    expect((await c.autor!.req('POST', '/api/hinzufuegen', { body: fd })).status).toBe(400);
    expect((await neu('z', { gross: 'x'.repeat(9000) })).status).toBe(400);
  });
});
