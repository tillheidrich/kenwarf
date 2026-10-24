import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bauDatenweg, bauMcpServer, startePlaner, FakeKern } from '../src/index.js';
import { baueUmgebung, Client, type TestUmgebung } from './helfer.js';

let u: TestUmgebung;
let autor: Client;
let frei: Client;
let admin: Client;
beforeAll(async () => {
  u = await baueUmgebung();
  autor = new Client(u.app.app); await autor.login('autor');
  frei = new Client(u.app.app); await frei.login('frei');
  admin = new Client(u.app.app); await admin.login('admin');
});
afterAll(() => u.aufraeumen());

const vorschlag = async (ziel: string, neu = '# Neu', art = 'aenderung') =>
  autor.req('POST', '/api/vorschlag', { json: { art, ziel, neu, grund: 'Test v1.2' } });

describe('Nachtrag v1.2', () => {
  it('GET /api/datenweg: mock verlässt den Server nicht', async () => {
    const d = await (await autor.req('GET', '/api/datenweg')).json();
    expect(d.anbieter).toBe('mock');
    expect(d.verlaesstServer).toBe(false);
    expect(d.daten).toEqual([]);
  });

  it('Datenweg erkennt lokal und extern', () => {
    expect(bauDatenweg({ art: 'ollama', url: 'http://127.0.0.1:11434', chatModell: 'a', embedModell: 'b' }).verlaesstServer).toBe(false);
    const m = bauDatenweg({ art: 'openai', url: 'https://api.mistral.ai/v1', apiKey: 'x', chatModell: 'a', embedModell: 'b' });
    expect(m.verlaesstServer).toBe(true);
    expect(m.strecken[0]!.region).toContain('EU');
    expect(JSON.stringify(m)).not.toContain('"x"');
  });

  it('Konflikt: Datei seit dem Vorschlag geändert → 409 mit neuem Vergleich, nichts überschrieben', async () => {
    const r = await vorschlag('wissen/betrieb/urlaub.md', '# Überschrieben');
    expect(r.status).toBe(201);
    const v = await r.json();
    const datei = path.join(u.dir, 'wissen/betrieb/urlaub.md');
    fs.appendFileSync(datei, '\nVon Hand in Obsidian ergänzt.\n');
    const e = await frei.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } });
    expect(e.status).toBe(409);
    const b = await e.json();
    expect(b.vorschlag.status).toBe('konflikt');
    expect(b.vorschlag.alt).toContain('Von Hand in Obsidian');
    expect(fs.readFileSync(datei, 'utf8')).toContain('Von Hand in Obsidian');
    // nach Prüfung des neuen Vergleichs freigeben
    const e2 = await frei.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } });
    expect(e2.status).toBe(200);
    expect(fs.readFileSync(datei, 'utf8')).toBe('# Überschrieben');
  });

  it('reservierte Namen index.md und log.md als Ziel abgewiesen', async () => {
    expect((await vorschlag('wissen/betrieb/index.md', '# x', 'neu')).status).toBe(400);
    expect((await vorschlag('wissen/log.md', '# x', 'neu')).status).toBe(400);
  });

  it('wissen/_regeln/ darf nur admin freigeben', async () => {
    const v = await (await vorschlag('wissen/_regeln/REGELN.md', '# Regeln', 'neu')).json();
    expect((await frei.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } })).status).toBe(403);
    expect((await admin.req('POST', `/api/eingang/${v.id}`, { json: { aktion: 'freigeben' } })).status).toBe(200);
  });

  it('MCP-Vorschläge sind gekennzeichnet, reservierte Namen abgewiesen', async () => {
    const s = bauMcpServer(u.kern, { ...u.nutzer.autor, name: 'autor', rollen: ['autor'], teams: [] } as never, '0');
    const tools = (s as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
    const t = tools.kern_vorschlag!;
    const fn = (t.handler ?? t.callback)!;
    const r = await fn({ art: 'neu', ziel: 'wissen/mcp/a.md', neu: '# A', grund: 'von der KI' }, {});
    expect(JSON.parse(r.content[0].text).grund).toBe('[über MCP] von der KI');
    const r2 = await fn({ art: 'neu', ziel: 'wissen/mcp/index.md', neu: '# A', grund: 'von der KI' }, {});
    expect(r2.isError).toBe(true);
  });

  it('Planer ruft beobachteQuellen als Admin auf', async () => {
    const k = u.kern as FakeKern;
    const vorher = k.beobachtungsLaeufe;
    const p = startePlaner(k, { stunden: 0 });
    const r = (await p.laufJetzt()) as { geprueft: number };
    expect(typeof r.geprueft).toBe('number');
    expect(k.beobachtungsLaeufe).toBe(vorher + 1);
    p.stop();
  });
});
