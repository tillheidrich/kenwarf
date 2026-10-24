import type { ChatOptionen, ChatNachricht, Provider, ProviderConfig } from './types.js';
import { fetchMitProxy } from './netz.js';
import { extrahiereJson, saetze, sha256, stammformen, zeilenSaetze } from './util.js';

/* ================================================================== */
/* Mock: deterministisch, ohne Netz. Für Tests, Demo und „ohne KI“.     */
/* ================================================================== */

export const MOCK_DIM = 384;

function hashIndex(s: string, dim: number): [number, number] {
  const h = sha256(s);
  const idx = parseInt(h.slice(0, 8), 16) % dim;
  const vz = parseInt(h.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
  return [idx, vz];
}

/** Hash-Trick-Embedding über Stammformen und Zeichen-Trigramme, L2-normiert. */
export function mockEmbedding(text: string, dim = MOCK_DIM): Float32Array {
  const v = new Float32Array(dim);
  for (const st of stammformen(text)) {
    const [i, s] = hashIndex('w:' + st, dim);
    v[i]! += 2 * s;
    const w = `#${st}#`;
    for (let k = 0; k + 3 <= w.length; k++) {
      const [j, t] = hashIndex('t:' + w.slice(k, k + 3), dim);
      v[j]! += 0.5 * t;
    }
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i]! /= n;
  return v;
}

/** Anteil der Inhaltswörter der Frage, die im Text vorkommen (Stamm- oder Präfixgleichheit ≥ 5 Zeichen). */
export function ueberdeckung(frage: string, text: string): number {
  const f = [...new Set(stammformen(frage))].filter((w) => w.length >= 2);
  if (!f.length) return 0;
  const t = new Set(stammformen(text));
  const tl = [...t].filter((x) => x.length >= 5);
  let treffer = 0;
  for (const w of f) {
    if (t.has(w)) treffer++;
    else if (w.length >= 5 && tl.some((x) => x.includes(w) || w.includes(x))) treffer += 0.8;
  }
  return treffer / f.length;
}

interface NummerierterAbschnitt { nr: number; titel: string; text: string; }

/** Liest die nummerierten Abschnitte im Format `[n] (titel) … ` aus einem Prompt. */
export function leseNummerierteAbschnitte(prompt: string): NummerierterAbschnitt[] {
  const out: NummerierterAbschnitt[] = [];
  const re = /^\[(\d+)\] ([^\n]*)\n([\s\S]*?)(?=^\[\d+\] |^=== |(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ nr: Number(m[1]), titel: m[2] ?? '', text: (m[3] ?? '').replace(/^<<<(?:DATEN|ENDE) [^\n]*>>>$/gm, '').trim() });
  return out;
}

function zwischen(s: string, start: string, ende?: string): string {
  const a = s.indexOf(start);
  if (a < 0) return '';
  const rest = s.slice(a + start.length);
  if (!ende) return rest.trim();
  const b = rest.indexOf(ende);
  return (b < 0 ? rest : rest.slice(0, b)).trim();
}

function besterSatz(frage: string, text: string): string | null {
  let kandidaten = zeilenSaetze(text);
  if (!kandidaten.length) return null; // nur Überschrift oder Hinweiskasten
  let best = kandidaten[0]!;
  let bestScore = -1;
  for (const s of kandidaten) {
    const sc = ueberdeckung(frage, s) + Math.min(s.length, 200) / 10000;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  kandidaten = [];
  return best.length > 400 ? best.slice(0, best.lastIndexOf(' ', 400) > 200 ? best.lastIndexOf(' ', 400) : 400) : best;
}

export class MockProvider implements Provider {
  name = 'mock';
  async embed(texte: string[]): Promise<Float32Array[]> {
    return texte.map((t) => mockEmbedding(t));
  }

  async chat(msgs: ChatNachricht[], opt?: ChatOptionen): Promise<string> {
    const aus = this.chatIntern(msgs);
    // geschätzt: Zeichen / 4 (deterministisch), damit der Zähler auch ohne KI geprüft werden kann
    opt?.onVerbrauch?.({ eingabeTokens: Math.ceil(msgs.reduce((n, m) => n + m.content.length, 0) / 4), ausgabeTokens: Math.ceil(aus.length / 4) });
    return aus;
  }

  private chatIntern(msgs: ChatNachricht[]): string {
    const system = msgs.find((m) => m.role === 'system')?.content ?? '';
    const user = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('AUFGABE: FRAGE')) return JSON.stringify(this.frage(user));
    if (system.includes('AUFGABE: KOMPILIEREN')) return JSON.stringify(this.kompiliere(user));
    if (system.includes('AUFGABE: ANSICHT')) {
      const thema = zwischen(user, '=== THEMA', '=== ABSCHNITTE');
      const abschnitte = leseNummerierteAbschnitte(zwischen(user, '=== ABSCHNITTE'));
      const punkte: { block: string; satz: string; absatz: null; belege: number[]; zitat?: string }[] = [{ block: 'unsicher', satz: 'Keine Unsicherheit erkannt (Mock-Anbieter, keine KI angebunden).', absatz: null, belege: [] }];
      for (const a of abschnitte.slice(0, 5)) {
        const satz = besterSatz(thema, a.text);
        if (satz) punkte.push({ block: 'aendert_sich', satz, absatz: null, belege: [a.nr], zitat: satz });
      }
      return JSON.stringify({ punkte });
    }
    if (system.includes('AUFGABE: REGELPRUEFUNG')) return JSON.stringify({ verstoss: false, regel: null });
    return JSON.stringify({ text: 'Mock-Anbieter: keine KI angebunden.' });
  }

  async rerank(frage: string, texte: string[]): Promise<number[]> {
    return texte.map((t) => ueberdeckung(frage, t));
  }

  private frage(user: string) {
    const frage = zwischen(user, '=== FRAGE', '=== ABSCHNITTE');
    const abschnitte = leseNummerierteAbschnitte(zwischen(user, '=== ABSCHNITTE'));
    const bewertet = abschnitte
      .map((a) => ({ a, s: ueberdeckung(frage, a.titel + '\n' + a.text) }))
      .filter((x) => x.s >= 0.5 && zeilenSaetze(x.a.text).length > 0)
      .sort((x, y) => y.s - x.s || x.a.nr - y.a.nr)
      .filter((x, i, alle) => i === 0 || x.s >= alle[0]!.s - 1e-9)
      .slice(0, 2);
    const punkte = bewertet.map(({ a }) => {
      const satz = besterSatz(frage, a.text);
      return { text: satz, belege: [a.nr], zitat: satz };
    });
    return { punkte, hinweis: 'Mock-Antwort aus den besten Fundstellen (keine KI angebunden).' };
  }

  private kompiliere(user: string) {
    const titel = /^titel:\s*(.+)$/m.exec(user)?.[1]?.trim() || 'Neue Notiz';
    const sammlung = /sammlung:\s*(.+)/i.exec(user)?.[1]?.trim() ?? 'allgemein';
    const abschnitte = leseNummerierteAbschnitte(zwischen(user, '=== QUELLABSCHNITTE', '=== BESTEHENDE ARTIKEL'));
    const artikel = leseNummerierteAbschnitte(zwischen(user, '=== BESTEHENDE ARTIKEL'));
    const text = abschnitte.map((a) => a.text).join('\n\n').trim();
    if (!text) return { vorschlaege: [] };
    const kurz = saetze(text.replace(/^#+\s.*$/gm, '').replace(/^>.*$/gm, '')).slice(0, 2).join(' ');
    // Passender bestehender Artikel? Dann Ergänzung vorschlagen.
    const bester = artikel
      .map((a) => ({ a, s: ueberdeckung(a.titel.replace(/\s*pfad:.*$/, ''), titel + ' ' + text) }))
      .sort((x, y) => y.s - x.s)[0];
    const nrs = abschnitte.map((a) => a.nr);
    if (bester && bester.s >= 0.6) {
      const ziel = /pfad:\s*(\S+)/.exec(bester.a.titel)?.[1] ?? '';
      return {
        vorschlaege: [
          {
            art: 'aenderung',
            ziel,
            titel: bester.a.titel.replace(/\s*pfad:.*$/, ''),
            kurzfassung: '',
            text: `## Ergänzung: ${titel}\n\n${text.replace(/^#{1,6}\s+/gm, '### ')}`,
            abschnitte: nrs,
            grund: `Ergänzung aus der Quelle „${titel}“`,
          },
        ],
      };
    }
    return {
      vorschlaege: [
        {
          art: 'neu',
          titel,
          gruppe: sammlung,
          kurzfassung: kurz.slice(0, 400),
          text: text.replace(/^# .*\n+/, ''),
          abschnitte: nrs,
          grund: `Neuer Artikel aus der Quelle „${titel}“`,
        },
      ],
    };
  }
}

/* ================================================================== */
/* HTTP-Anbieter                                                        */
/* ================================================================== */

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 120_000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchMitProxy(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`KI-Anbieter antwortet ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

const ohneSlash = (u: string) => u.replace(/\/+$/, '');

export class OllamaProvider implements Provider {
  name = 'ollama';
  constructor(private c: { url: string; chatModell: string; embedModell: string }) {}
  async embed(texte: string[]): Promise<Float32Array[]> {
    if (!texte.length) return [];
    const r = await postJson(`${ohneSlash(this.c.url)}/api/embed`, { model: this.c.embedModell, input: texte });
    return (r.embeddings as number[][]).map((e) => Float32Array.from(e));
  }
  async chat(msgs: ChatNachricht[], opt?: ChatOptionen): Promise<string> {
    const r = await postJson(`${ohneSlash(this.c.url)}/api/chat`, {
      model: this.c.chatModell,
      messages: msgs,
      stream: false,
      ...(opt?.json ? { format: 'json' } : {}),
      options: { temperature: 0 },
    });
    opt?.onVerbrauch?.({ eingabeTokens: Number(r.prompt_eval_count ?? 0), ausgabeTokens: Number(r.eval_count ?? 0) });
    return String(r.message?.content ?? '');
  }
}

/** OpenAI-kompatibel (Mistral, IONOS, STACKIT, vLLM, LocalAI …). `url` inkl. `/v1`. */
export class OpenAIProvider implements Provider {
  name = 'openai';
  constructor(private c: { url: string; apiKey: string; chatModell: string; embedModell: string }) {}
  private h(): Record<string, string> {
    return this.c.apiKey ? { authorization: `Bearer ${this.c.apiKey}` } : {};
  }
  async embed(texte: string[]): Promise<Float32Array[]> {
    if (!texte.length) return [];
    const out: Float32Array[] = [];
    for (let i = 0; i < texte.length; i += 64) {
      const r = await postJson(`${ohneSlash(this.c.url)}/embeddings`, { model: this.c.embedModell, input: texte.slice(i, i + 64) }, this.h());
      const daten = [...(r.data as { index: number; embedding: number[] }[])].sort((a, b) => a.index - b.index);
      out.push(...daten.map((d) => Float32Array.from(d.embedding)));
    }
    return out;
  }
  async chat(msgs: ChatNachricht[], opt?: ChatOptionen): Promise<string> {
    const r = await postJson(
      `${ohneSlash(this.c.url)}/chat/completions`,
      { model: this.c.chatModell, messages: msgs, temperature: 0, ...(opt?.json ? { response_format: { type: 'json_object' } } : {}) },
      this.h(),
    );
    opt?.onVerbrauch?.({ eingabeTokens: Number(r.usage?.prompt_tokens ?? 0), ausgabeTokens: Number(r.usage?.completion_tokens ?? 0) });
    return String(r.choices?.[0]?.message?.content ?? '');
  }
}

/** Anthropic Messages API für Chat; Embeddings über einen zweiten Anbieter. */
export class AnthropicProvider implements Provider {
  name = 'anthropic';
  constructor(
    private c: { apiKey: string; chatModell: string; url?: string },
    private embedder: Provider,
  ) {}
  embed(texte: string[]): Promise<Float32Array[]> {
    return this.embedder.embed(texte);
  }
  async chat(msgs: ChatNachricht[], opt?: ChatOptionen): Promise<string> {
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const r = await postJson(
      `${ohneSlash(this.c.url ?? 'https://api.anthropic.com')}/v1/messages`,
      {
        model: this.c.chatModell,
        max_tokens: 4096,
        temperature: 0,
        system: opt?.json ? `${system}\n\nAntworte ausschließlich mit einem gültigen JSON-Objekt, ohne Text davor oder danach.` : system,
        messages: rest,
      },
      { 'x-api-key': this.c.apiKey, 'anthropic-version': '2023-06-01' },
    );
    opt?.onVerbrauch?.({ eingabeTokens: Number(r.usage?.input_tokens ?? 0), ausgabeTokens: Number(r.usage?.output_tokens ?? 0) });
    const text = ((r.content ?? []) as { type: string; text?: string }[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (opt?.json) {
      try {
        return JSON.stringify(extrahiereJson(text));
      } catch {
        return text;
      }
    }
    return text;
  }
}

export function erzeugeProvider(c: ProviderConfig): Provider {
  switch (c.art) {
    case 'mock':
      return new MockProvider();
    case 'ollama':
      return new OllamaProvider(c);
    case 'openai':
      return new OpenAIProvider(c);
    case 'anthropic':
      if (c.embed.art === 'anthropic') throw new Error('Anthropic bietet keine Embeddings: embed muss ein anderer Anbieter sein');
      return new AnthropicProvider(c, erzeugeProvider(c.embed));
  }
}

/** Kennung für Index-Gültigkeit (Wechsel des Embedding-Modells ⇒ Vektoren neu). */
export function embedKennung(c: ProviderConfig): string {
  switch (c.art) {
    case 'mock':
      return `mock:${MOCK_DIM}:v1`;
    case 'ollama':
      return `ollama:${c.embedModell}`;
    case 'openai':
      return `openai:${c.url}:${c.embedModell}`;
    case 'anthropic':
      return embedKennung(c.embed);
  }
}

