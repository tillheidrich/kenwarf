/**
 * Client für die Betriebs-Endpunkte einer Instanz (CONTRACT v1.4 3.4, O1 1.7; Server-Stand packages/server/src/betrieb.ts,
 * Form von F1 bestätigt: nur additive Änderungen). Der Leitstand liegt nicht im Instanznetz; deshalb ist der Weg
 * austauschbar:
 *   - `HttpTransport`: direkt an http://<ip>:7480 (Leitstand im internen Netz, WireGuard oder auf dem Host).
 *   - `ExecTransport`: per Docker exec im Container gegen 127.0.0.1:7480 (kein Netzweg nötig).
 * Die Instanz lehnt Anfragen mit X-Forwarded-For/Forwarded ab (404), also nie über einen Proxy schicken.
 *
 * Alles, was zurückkommt, läuft durch `nurBetriebsdaten()`: Zähler wie `artikel` und `quellen` werden verworfen.
 */
import type { DockerEngine } from './docker/engine.js';
import type { Grenzen, Modus, StatusAntwort } from './bereitsteller/typ.js';
import { nurBetriebsdaten } from './bereitsteller/typ.js';

export interface BetriebAntwort { status: number; json: unknown }
export interface Transport { anfrage(methode: 'GET' | 'POST', pfad: string, body?: unknown): Promise<BetriebAntwort> }

export class BetriebFehler extends Error {
  constructor(public status: number, meldung: string, public code?: string) { super(meldung); }
}

const PFAD = /^\/_betrieb\/[a-z]+(\/[A-Za-z0-9_-]{1,64})?$/;

export class HttpTransport implements Transport {
  constructor(private basis: string, private token: string, private f: typeof fetch = fetch, private zeitMs = 15_000) {}
  async anfrage(methode: 'GET' | 'POST', pfad: string, body?: unknown): Promise<BetriebAntwort> {
    if (!PFAD.test(pfad)) throw new Error('nur /_betrieb/*');
    const r = await this.f(`${this.basis.replace(/\/$/, '')}${pfad}`, {
      method: methode, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.zeitMs),
    });
    const text = await r.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { fehler: text.slice(0, 200) }; }
    return { status: r.status, json };
  }
}

/**
 * Ruft /_betrieb/* aus dem Container selbst auf. Das Token geht über die Umgebung des exec-Prozesses, nicht über die
 * Befehlszeile (sonst stünde es in `ps`). Antwort als eine JSON-Zeile auf stdout.
 */
export class ExecTransport implements Transport {
  constructor(private engine: DockerEngine, private container: string, private token: string, private port = 7480) {}
  async anfrage(methode: 'GET' | 'POST', pfad: string, body?: unknown): Promise<BetriebAntwort> {
    if (!PFAD.test(pfad)) throw new Error('nur /_betrieb/*');
    const skript = `const b=process.env.KB_BODY;fetch('http://127.0.0.1:${this.port}'+process.env.KB_PFAD,{method:process.env.KB_M,headers:Object.assign({authorization:'Bearer '+process.env.KB_T},b?{'content-type':'application/json'}:{}),body:b||undefined}).then(async r=>{process.stdout.write(JSON.stringify({s:r.status,t:await r.text()}))}).catch(e=>{process.stdout.write(JSON.stringify({s:0,t:String(e.message)}))})`;
    const env = [`KB_PFAD=${pfad}`, `KB_M=${methode}`, `KB_T=${this.token}`, ...(body !== undefined ? [`KB_BODY=${JSON.stringify(body)}`] : [])];
    const r = await this.engine.exec(this.container, ['node', '-e', skript], { env });
    let a: { s: number; t: string };
    try { a = JSON.parse(r.stdout) as { s: number; t: string }; } catch { throw new BetriebFehler(0, `exec ohne Antwort (Code ${r.code})`); }
    if (a.s === 0) throw new BetriebFehler(0, `Instanz nicht erreichbar: ${a.t.slice(0, 120)}`);
    let json: unknown = null;
    try { json = a.t ? JSON.parse(a.t) : null; } catch { json = { fehler: a.t.slice(0, 200) }; }
    return { status: a.s, json };
  }
}

export interface Einladung { benutzer_id: string; einmalPasswort: string; mussPasswortAendern: boolean }

export class BetriebClient {
  constructor(private t: Transport) {}

  private async rufe(methode: 'GET' | 'POST', pfad: string, body?: unknown, ok: number[] = [200]): Promise<Record<string, unknown>> {
    const r = await this.t.anfrage(methode, pfad, body);
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (!ok.includes(r.status)) {
      const m = typeof j.fehler === 'string' ? j.fehler.slice(0, 200) : `HTTP ${r.status}`;
      throw new BetriebFehler(r.status, r.status === 501 ? `Instanz kann das noch nicht (${pfad}, 501): ${m}` : `${pfad}: ${m}`, typeof j.code === 'string' ? j.code : undefined);
    }
    return j;
  }

  /** `nutzer` heißt im Leitstand `benutzer`; `null` beim Verbrauch heißt „noch kein Zähler“ und wird 0. */
  async status(): Promise<StatusAntwort> {
    const j = await this.rufe('GET', '/_betrieb/status');
    return nurBetriebsdaten({ ...j, benutzer: j.benutzer ?? j.nutzer, ki_verbrauch_cent_monat: j.ki_verbrauch_cent_monat ?? 0, health: 'ok', backup_ok: j.backup_ok === undefined ? true : j.backup_ok } as never);
  }
  async modus(m: Modus): Promise<void> { await this.rufe('POST', '/_betrieb/modus', { modus: m }); }
  async grenzen(g: Grenzen): Promise<void> { await this.rufe('POST', '/_betrieb/grenzen', g); }
  /** Erster Admin: Einmalpasswort mit Pflicht zum Wechsel. 409 = gibt es schon (Wiederholung) oder Grenze erreicht. */
  async einladung(name: string): Promise<Einladung | null> {
    const r = await this.t.anfrage('POST', '/_betrieb/einladung', { name, rollen: ['admin'] });
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (r.status === 409 && j.code !== 'kontingent') return null;
    if (r.status !== 201 && r.status !== 200) throw new BetriebFehler(r.status, `/_betrieb/einladung: ${String(j.fehler ?? r.status)}`, typeof j.code === 'string' ? j.code : undefined);
    return { benutzer_id: String(j.benutzer_id), einmalPasswort: String(j.einmalPasswort), mussPasswortAendern: j.mussPasswortAendern === true };
  }
  async beispiel(aktion: 'laden' | 'entfernen'): Promise<void> { await this.rufe('POST', '/_betrieb/beispiel', { aktion }); }
  /**
   * Export (S2, d80276e): wartet bis 120 s und liefert { bytes, sha256, datei, passphrase? }. Bei 202 (länger) wird
   * `/_betrieb/export/:id` abgefragt. Die Passphrase eines selbst erzeugten Umzugspakets kommt nur hier zurück.
   */
  async exportVoll(art: 'umzugspaket' | 'okf' | 'zip', opt: { passphrase?: string; warteMs?: number } = {}): Promise<{ bytes: number; sha256: string; datei?: string; passphrase?: string }> {
    let j = await this.rufe('POST', '/_betrieb/export', { art, ...(opt.passphrase ? { passphrase: opt.passphrase } : {}) }, [200, 201, 202]);
    const pass = typeof j.passphrase === 'string' ? j.passphrase : undefined;
    const bis = Date.now() + (opt.warteMs ?? 600_000);
    while (j.status !== 'fertig' && typeof j.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(j.id)) {
      if (j.status === 'fehler') throw new BetriebFehler(500, 'Export in der Instanz gescheitert');
      if (Date.now() > bis) throw new BetriebFehler(504, 'Export dauert zu lange');
      await new Promise((r) => setTimeout(r, 2000));
      j = await this.rufe('GET', `/_betrieb/export/${j.id}`);
    }
    const bytes = typeof j.bytes === 'number' ? j.bytes : NaN, sha = typeof j.sha256 === 'string' ? j.sha256 : '';
    if (!Number.isFinite(bytes) || !/^[a-f0-9]{64}$/.test(sha)) throw new BetriebFehler(502, 'Export-Antwort ohne bytes/sha256');
    return { bytes, sha256: sha, ...(typeof j.datei === 'string' ? { datei: j.datei } : {}), ...(pass ? { passphrase: pass } : {}) };
  }
  /** Prüfbericht nach Import am Ziel: nur Zahlen, Wahrheitswerte und die Prüfsumme für /v1/…/umzug/bestaetigen. */
  async pruefbericht(neu = false): Promise<{ bestanden: boolean; pruefbericht_sha256: string }> {
    const j = await this.rufe(neu ? 'POST' : 'GET', '/_betrieb/pruefbericht', neu ? {} : undefined);
    const sha = typeof j.pruefbericht_sha256 === 'string' ? j.pruefbericht_sha256 : '';
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new BetriebFehler(502, 'Prüfbericht ohne Prüfsumme');
    return { bestanden: j.bestanden === true, pruefbericht_sha256: sha };
  }
  async export(art: 'umzugspaket' | 'okf'): Promise<{ bytes: number; sha256: string }> {
    const r = await this.exportVoll(art);
    return { bytes: r.bytes, sha256: r.sha256 };
  }

}
