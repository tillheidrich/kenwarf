import { afterAll, describe, expect, it } from 'vitest';
import { AnthropicProvider, MockProvider, OllamaProvider, OpenAIProvider, erzeugeProvider } from '../src/provider.js';
import { testServer } from './helfer.js';

const anfragen: { url: string; headers: Record<string, unknown>; body: any }[] = [];
const srv = await testServer((req, body, res) => {
  anfragen.push({ url: req.url ?? '', headers: req.headers, body: body ? JSON.parse(body) : null });
  const u = req.url ?? '';
  if (!['/api/embed', '/api/chat', '/v1/embeddings', '/v1/chat/completions', '/v1/messages'].includes(u)) {
    res.writeHead(404);
    return res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (u === '/api/embed') return res.end(JSON.stringify({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }));
  if (u === '/api/chat') return res.end(JSON.stringify({ message: { content: '{"ok":1}' } }));
  if (u === '/v1/embeddings') return res.end(JSON.stringify({ data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] }));
  if (u === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":2}' } }] }));
  if (u === '/v1/messages') return res.end(JSON.stringify({ content: [{ type: 'text', text: 'Hier: {"ok":3} fertig' }] }));
});
afterAll(() => srv.schliessen());

describe('Provider', () => {
  it('ollama: /api/embed und /api/chat mit format json', async () => {
    const p = new OllamaProvider({ url: srv.url, chatModell: 'mistral-small', embedModell: 'bge-m3' });
    const e = await p.embed(['a', 'b']);
    expect(e.map((x) => Array.from(x))).toEqual([[Math.fround(0.1), Math.fround(0.2)], [Math.fround(0.3), Math.fround(0.4)]]);
    expect(await p.chat([{ role: 'user', content: 'x' }], { json: true })).toBe('{"ok":1}');
    const c = anfragen.find((a) => a.url === '/api/chat')!;
    expect(c.body).toMatchObject({ model: 'mistral-small', stream: false, format: 'json' });
  });

  it('openai-kompatibel: Bearer, Reihenfolge nach index, response_format', async () => {
    const p = new OpenAIProvider({ url: `${srv.url}/v1/`, apiKey: 'sk-test', chatModell: 'mistral-large', embedModell: 'mistral-embed' });
    const e = await p.embed(['x', 'y']);
    expect(e.map((x) => Array.from(x))).toEqual([[1, 1], [2, 2]]);
    expect(await p.chat([{ role: 'user', content: 'x' }], { json: true })).toBe('{"ok":2}');
    const c = anfragen.find((a) => a.url === '/v1/chat/completions')!;
    expect(c.headers['authorization']).toBe('Bearer sk-test');
    expect(c.body.response_format).toEqual({ type: 'json_object' });
  });

  it('anthropic: Messages-API, System getrennt, JSON herausgelöst, Embeddings über zweiten Anbieter', async () => {
    const p = new AnthropicProvider({ apiKey: 'ak', chatModell: 'claude-x', url: srv.url }, new MockProvider());
    expect(await p.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { json: true })).toBe('{"ok":3}');
    const c = anfragen.find((a) => a.url === '/v1/messages')!;
    expect(c.headers['x-api-key']).toBe('ak');
    expect(c.headers['anthropic-version']).toBe('2023-06-01');
    expect(c.body.system).toContain('S');
    expect(c.body.messages).toEqual([{ role: 'user', content: 'U' }]);
    expect((await p.embed(['a']))[0]!.length).toBe(384);
    expect(() => erzeugeProvider({ art: 'anthropic', apiKey: '', chatModell: 'x', embed: { art: 'anthropic', apiKey: '', chatModell: 'y', embed: { art: 'mock' } } })).toThrow();
  });

  it('Fehler des Anbieters werden gemeldet', async () => {
    const p = new OpenAIProvider({ url: `${srv.url}/falsch`, apiKey: '', chatModell: 'm', embedModell: 'e' });
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/404/);
  });

  it('mock ist deterministisch', async () => {
    const m = new MockProvider();
    const p = [{ role: 'system' as const, content: 'AUFGABE: FRAGE' }, { role: 'user' as const, content: '=== FRAGE\nWo liegt der Hubwagen?\n=== ABSCHNITTE\n[1] Lager\nDer Hubwagen liegt hinten links.\n\n[2] Büro\nDas Telefon klingelt.' }];
    const a = await m.chat(p);
    expect(await m.chat(p)).toBe(a);
    expect(JSON.parse(a).punkte[0]).toMatchObject({ belege: [1], zitat: 'Der Hubwagen liegt hinten links.' });
  });
});
