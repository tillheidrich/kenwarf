/**
 * Adapter zum Rechnungs-Werkzeug „Rechnungen-Heidrich_Digital“ (MCP über Streamable HTTP, JSON-RPC 2.0, `tools/call`).
 * Harte Regel (Till, v1.4 3.6, S-9): Der Leitstand legt nur Entwürfe an. Festschreiben ist immer Tills Schritt im
 * Werkzeug. Der Adapter kennt deshalb nur eine Erlaubnisliste von Werkzeugen (`beleg_entwerfen`, `kunden_suchen`);
 * jedes andere Werkzeug, insbesondere `beleg_festschreiben`, wird vor dem Netz abgelehnt. Auch mit S-9 an meldet er
 * `festgeschrieben: false` und vermerkt nur, dass eine stehende Freigabe vorliegt.
 *
 * Felder von `beleg_entwerfen` nach der Werkzeugbeschreibung im MCP-Server (art, kunde | anschrift, betreff,
 * leistungsdatum, bestellnummer, positionen[{ bezeichnung, einzelpreis_eur, menge, einheit }]). Kleinunternehmer
 * nach § 19 UStG: Preise ohne Umsatzsteuer.
 */
import type { Kunde } from './typen.js';
import type { RechnungsTool } from './leitstand.js';

export const ERLAUBTE_WERKZEUGE = new Set(['beleg_entwerfen', 'kunden_suchen']);

export interface McpOptionen { url: string; token?: string; f?: typeof fetch; protokoll?: string }

/** Minimaler MCP-Client (initialize → tools/call), Antworten als JSON oder als SSE-Ereignis. */
export class McpClient {
  private sitzung: string | null = null;
  private n = 0;
  constructor(private o: McpOptionen) {}
  private async rpc(method: string, params: unknown): Promise<unknown> {
    const f = this.o.f ?? fetch;
    const r = await f(this.o.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': this.o.protokoll ?? '2025-06-18', ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}), ...(this.sitzung ? { 'mcp-session-id': this.sitzung } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method, params }), signal: AbortSignal.timeout(20_000),
    });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sitzung = sid;
    if (!r.ok) throw new Error(`Rechnungs-Werkzeug ${r.status}`);
    const text = await r.text();
    const roh = (r.headers.get('content-type') ?? '').includes('text/event-stream') ? text.split('\n').filter((z) => z.startsWith('data:')).map((z) => z.slice(5).trim()).pop() ?? '' : text;
    const j = JSON.parse(roh) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`Rechnungs-Werkzeug: ${j.error.message.slice(0, 200)}`);
    return j.result;
  }
  async werkzeug(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ERLAUBTE_WERKZEUGE.has(name)) throw new Error(`Werkzeug ${name} ist für den Leitstand gesperrt (nur Entwürfe)`);
    if (!this.sitzung) await this.rpc('initialize', { protocolVersion: this.o.protokoll ?? '2025-06-18', capabilities: {}, clientInfo: { name: 'kern-leitstand', version: '0.1.0' } });
    const r = (await this.rpc('tools/call', { name, arguments: args })) as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[]; isError?: boolean };
    if (r.isError) throw new Error(`Rechnungs-Werkzeug meldet Fehler: ${(r.content?.[0]?.text ?? '').slice(0, 200)}`);
    if (r.structuredContent) return r.structuredContent;
    const t = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
    try { return JSON.parse(t) as Record<string, unknown>; } catch { return { text: t }; }
  }
}

/** Feste Katalogpositionen (G1 7.3), Text aus Produktname, Paket und Stufe. */
export class RechnungsEntwurf implements RechnungsTool {
  constructor(private mcp: Pick<McpClient, 'werkzeug'>, private opt: { produkt: () => string; linkMuster?: string } = { produkt: () => 'Kern' }) {}
  async entwurf(e: { kunde: Kunde; zahlung_id: string; betrag_cent: number; position: string; festschreiben: boolean }): Promise<{ id: string; link?: string; festgeschrieben: false; stehende_freigabe: boolean }> {
    const kunde = e.kunde.rechnung_ref ?? e.kunde.firma;
    const r = await this.mcp.werkzeug('beleg_entwerfen', {
      art: 'rechnung', ...(e.kunde.rechnung_ref ? { kunde } : { anschrift: { name: e.kunde.firma } }),
      betreff: `${this.opt.produkt()}: ${e.position}`, bestellnummer: e.zahlung_id,
      leistungsdatum: new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }),
      positionen: [{ bezeichnung: e.position, einzelpreis_eur: e.betrag_cent / 100, menge: 1, einheit: 'Zeitraum' }],
      schlusstext: 'Bezahlt per Mollie. Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    });
    const id = String(r.id ?? r.entwurf_id ?? r.beleg_id ?? '');
    if (!id) throw new Error('Rechnungs-Werkzeug ohne Entwurfs-ID');
    return { id, ...(this.opt.linkMuster ? { link: this.opt.linkMuster.replace('{id}', encodeURIComponent(id)) } : {}), festgeschrieben: false, stehende_freigabe: e.festschreiben };
  }
}
