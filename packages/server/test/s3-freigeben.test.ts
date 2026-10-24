/**
 * Contract v1.4.2: Scope `kern:freigeben`. Nur eigene Tokens von Freigebern/Admins, ausdrücklich gewählt, Standard aus;
 * nie für Agenten, nie über OAuth; `kern_sammelfreigabe` verlangt genau diesen Scope; Regeln nur über die Weboberfläche.
 * Läuft mit der Attrappe (Ersatz-Tokenspeicher), weil der Tokenspeicher von core den Scope noch nicht kennt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErsatzZugang, type User } from '../src/index.js';
import { scopeErlaubt } from '../src/oauth.js';
import { baueUmgebung, Client, type TestUmgebung } from './helfer.js';

const ART = (t: string) => `---\ntitel: ${t}\ngruppe: x\nkurzfassung: k\nstand: 2026-10-01\nverantwortlich: v\npruefen_bis: null\nsichtbarkeit: betrieb\nbesitzer: niemand\nfundstellen: []\nstatus: freigegeben\n---\n## ${t}\n\nText ${t}.\n`;

describe('v1.4.2 kern:freigeben', () => {
  let t: TestUmgebung;
  const c: Record<string, Client> = {};
  const u: Record<string, User> = {};
  beforeAll(async () => {
    t = await baueUmgebung();
    for (const n of ['admin', 'freigeber', 'autor', 'leser'] as const) {
      const name = n === 'freigeber' ? 'frei' : n;
      c[n] = new Client(t.app.app);
      await c[n]!.login(name);
      u[n] = (await t.kern.benutzer.liste()).find((x) => x.name === name)!;
    }
  });
  afterAll(() => t.aufraeumen());

  async function mcp(token: string, name: string, args: Record<string, unknown>) {
    const r = await t.app.app.request('http://kern.test/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return { status: r.status, kopf: r.headers.get('www-authenticate') ?? '', body: await r.json() as { result?: { content: { text: string }[]; isError?: boolean } } };
  }
  const tok = async (cl: Client, b: Record<string, unknown>) => { const r = await cl.req('POST', '/api/ich/tokens', { json: b }); return { status: r.status, body: await r.json() }; };

  it('Anlegen: Standard ohne, nur Freigeber/Admin, nie mit agent, nie für OAuth-Zugänge', async () => {
    expect((await tok(c.freigeber!, {})).body.eintrag.scopes).not.toContain('kern:freigeben');
    expect((await tok(c.autor!, { scopes: ['kern:lesen', 'kern:freigeben'] })).status).toBe(403);
    expect((await tok(c.leser!, { scopes: ['kern:freigeben'] })).status).toBe(403);
    expect((await tok(c.admin!, { agent: 'Claude', profil: 'autor', scopes: ['kern:lesen', 'kern:freigeben'] })).status).toBe(403);
    const f = await tok(c.freigeber!, { scopes: ['kern:lesen', 'kern:freigeben'] });
    expect(f.status).toBe(201);
    expect(f.body.eintrag.scopes).toContain('kern:freigeben');
    const z = new ErsatzZugang(t.dir);
    expect(() => z.erzeuge(u.admin!, { art: 'oauth_zugriff', scopes: ['kern:lesen', 'kern:freigeben'], agent: 'Claude' })).toThrow(/freigeben/);
    expect(() => z.erzeuge(u.admin!, { art: 'mcp', scopes: ['kern:freigeben'], agent: 'Claude' })).toThrow(/freigeben/);
    // OAuth: weder vergeben noch schrittweise erweiterbar, auch für Admins
    expect(scopeErlaubt(u.admin!, 'kern:freigeben')).toBe(false);
  });

  it('kern_sammelfreigabe verlangt kern:freigeben; OAuth- und Agenten-Token eines Admins bekommen 403; Regeln nur im Web', async () => {
    const grund = 'Import Lauf 9';
    for (const ziel of ['wissen/imp/a.md', 'wissen/imp/b.md', 'wissen/_regeln/r.md']) {
      expect((await c.autor!.req('POST', '/api/vorschlag', { json: { art: 'neu', ziel, neu: ART(ziel), grund } })).status).toBe(201);
    }
    // Admin mit vorschlagen, aber ohne freigeben
    const ohne = (await tok(c.admin!, { scopes: ['kern:lesen', 'kern:vorschlagen'] })).body.token as string;
    const r1 = await mcp(ohne, 'kern_sammelfreigabe', { aktion: 'freigeben', grund });
    expect(r1.status).toBe(403);
    expect(r1.kopf).toContain('insufficient_scope');
    expect(r1.kopf).toContain('nicht erweitern');
    // Agenten-Token eines Admins
    const agent = (await tok(c.admin!, { agent: 'Claude', profil: 'autor' })).body.token as string;
    expect((await mcp(agent, 'kern_sammelfreigabe', { aktion: 'freigeben', grund })).status).toBe(403);
    // OAuth-Zugang eines Admins (wie nach der Zustimmung, mit allen OAuth-Scopes)
    const oauth = t.app.zugang.erzeuge(u.admin!, { art: 'oauth_zugriff', scopes: ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht'], clientId: 'https://claude.ai/oauth/x', agent: 'Claude', zielgruppe: 'http://kern.test/mcp' }).token;
    expect((await mcp(oauth, 'kern_sammelfreigabe', { aktion: 'freigeben', grund })).status).toBe(403);
    // Eigenes Token eines Admins mit kern:freigeben: freigegeben, Regel bleibt für die Weboberfläche
    const mit = (await tok(c.admin!, { scopes: ['kern:lesen', 'kern:freigeben'] })).body.token as string;
    const ok = await mcp(mit, 'kern_sammelfreigabe', { aktion: 'freigeben', grund });
    expect(ok.status).toBe(200);
    expect(ok.body.result?.isError, ok.body.result?.content[0]?.text).toBeFalsy();
    const e = JSON.parse(ok.body.result!.content[0]!.text);
    expect(e.erledigt).toHaveLength(2);
    expect(e.fehler).toHaveLength(1);
    expect(e.fehler[0].meldung).toContain('Weboberfläche');
    const web = await (await c.admin!.req('POST', '/api/eingang/sammel', { json: { aktion: 'freigeben', grund } })).json();
    expect(web.freigegeben).toBe(1);
  });
});
