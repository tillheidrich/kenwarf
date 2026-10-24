/**
 * Attrappen für externe APIs (keine echten Aufrufe, keine echten Schlüssel):
 *  - Hetzner Cloud API als `fetch`-Ersatz mit Zustand. Antwortformen nach https://docs.hetzner.cloud/cloud.spec.json
 *    (Server-Objekt mit id, name, status, created, labels, public_net.ipv4.ip, server_type.name; Fehler { error: { code, message } }).
 *  - Stub der Betriebs-Endpunkte /_betrieb/* nach packages/server/src/betrieb.ts (Form von F1 bestätigt).
 */
import type { BetriebAntwort, Transport } from '../src/betrieb-client.js';

type Antwort = { status: number; body?: unknown };
const json = (a: Antwort) => new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });

export class HetznerAttrappe {
  aufrufe: { methode: string; pfad: string; body?: unknown; auth: string | null }[] = [];
  server = new Map<number, { id: number; name: string; status: string; created: string; labels: Record<string, string>; public_net: { ipv4: { ip: string }; ipv6: { ip: string } }; server_type: { name: string }; location: { name: string }; user_data: string }>();
  firewalls = new Map<number, { id: number; name: string; rules: unknown[] }>();
  dns = new Map<string, string[]>();
  /** "typ@ort" → nicht verfügbar (412 resource_unavailable) */
  ausverkauft = new Set<string>();
  n = 1000;
  /** Für den Tunneltest: öffentliche IPv4 des nächsten Servers und Haken nach dem Anlegen (startet die „Maschine“). */
  naechsteIp: (() => string) | null = null;
  nachAnlegen: ((s: { id: number; user_data: string; labels: Record<string, string>; ip: string }) => void) | null = null;
  jetzt = () => new Date().toISOString();

  fetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const methode = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const auth = new Headers(init?.headers).get('authorization');
    const pfad = u.pathname.replace(/^\/v1/, '');
    this.aufrufe.push({ methode, pfad: pfad + u.search, ...(body ? { body } : {}), auth });
    if (u.origin !== 'https://api.hetzner.cloud' || !u.pathname.startsWith('/v1/')) return json({ status: 404, body: { error: { code: 'not_found', message: 'falscher Host' } } });
    if (auth !== 'Bearer test-token') return json({ status: 401, body: { error: { code: 'unauthorized', message: 'unable to authenticate' } } });
    return json(this.route(methode, pfad, u.searchParams, body));
  };

  private route(m: string, p: string, q: URLSearchParams, b?: Record<string, unknown>): Antwort {
    if (m === 'GET' && p === '/server_types') return { status: 200, body: { server_types: [{ name: q.get('name'), deprecated: false, locations: ['nbg1', 'hel1', 'fsn1'].map((l) => ({ name: l, available: !this.ausverkauft.has(`${q.get('name')}@${l}`) })) }] } };
    if (m === 'GET' && p === '/firewalls') return { status: 200, body: { firewalls: [...this.firewalls.values()].filter((f) => f.name === q.get('name')) } };
    if (m === 'POST' && p === '/firewalls') { const id = ++this.n; this.firewalls.set(id, { id, name: String(b!.name), rules: b!.rules as unknown[] }); return { status: 201, body: { firewall: { id, name: b!.name } } }; }
    if (m === 'GET' && p === '/servers') {
      const sel = q.get('label_selector') ?? '';
      const passt = (l: Record<string, string>) => sel.split(',').every((t) => { const [k, v] = t.split('='); return v === undefined ? k! in l : l[k!] === v; });
      return { status: 200, body: { servers: [...this.server.values()].filter((s) => passt(s.labels)), meta: { pagination: { page: 1 } } } };
    }
    if (m === 'POST' && p === '/servers') {
      for (const k of ['name', 'server_type', 'image']) if (!b?.[k]) return { status: 422, body: { error: { code: 'invalid_input', message: `missing ${k}` } } };
      if (Buffer.byteLength(String(b!.user_data ?? '')) > 32 * 1024) return { status: 422, body: { error: { code: 'invalid_input', message: 'user_data too long' } } };
      if (this.ausverkauft.has(`${b!.server_type}@${b!.location}`)) return { status: 412, body: { error: { code: 'resource_unavailable', message: 'server type unavailable in location' } } };
      if ([...this.server.values()].some((s) => s.name === b!.name)) return { status: 409, body: { error: { code: 'uniqueness_error', message: 'name is already used' } } };
      const id = ++this.n;
      const s = { id, name: String(b!.name), status: 'initializing', created: this.jetzt(), labels: b!.labels as Record<string, string>, public_net: { ipv4: { ip: this.naechsteIp?.() ?? `203.0.113.${id % 250}` }, ipv6: { ip: '2001:db8:1::/64' } }, server_type: { name: String(b!.server_type) }, location: { name: String(b!.location) }, user_data: String(b!.user_data) };
      this.server.set(id, s);
      this.nachAnlegen?.({ id, user_data: s.user_data, labels: s.labels, ip: s.public_net.ipv4.ip });
      return { status: 201, body: { server: s, action: { id: id + 1, status: 'running' }, next_actions: [], root_password: null } };
    }
    const sm = /^\/servers\/(\d+)$/.exec(p);
    if (sm) {
      const s = this.server.get(Number(sm[1]));
      if (!s) return { status: 404, body: { error: { code: 'not_found', message: 'server not found' } } };
      if (m === 'GET') { if (s.status === 'initializing') s.status = 'running'; return { status: 200, body: { server: s } }; } // wie Hetzner: nach dem Start „running“
      if (m === 'DELETE') { this.server.delete(s.id); return { status: 200, body: { action: { id: s.id + 7, command: 'delete_server', status: 'running' } } }; }
    }
    const z = /^\/zones\/([^/]+)\/rrsets(?:\/([^/]+)\/([A-Z]+)(\/actions\/set_records)?)?$/.exec(p);
    if (z) {
      const key = `${z[2] ?? b?.name}/${z[3] ?? b?.type}`;
      if (m === 'POST' && !z[2]) { if (this.dns.has(key)) return { status: 409, body: { error: { code: 'uniqueness_error', message: 'rrset exists' } } }; this.dns.set(key, (b!.records as { value: string }[]).map((r) => r.value)); return { status: 201, body: { rrset: { id: key } } }; }
      if (m === 'POST' && z[4]) { this.dns.set(key, (b!.records as { value: string }[]).map((r) => r.value)); return { status: 201, body: { action: { id: 1 } } }; }
      if (m === 'DELETE') { const da = this.dns.delete(key); return da ? { status: 201, body: { action: { id: 2 } } } : { status: 404, body: { error: { code: 'not_found', message: 'rrset not found' } } }; }
    }
    return { status: 404, body: { error: { code: 'not_found', message: `${m} ${p}` } } };
  }
}

/** /_betrieb/* als Attrappe mit dem Verhalten des Servers (Token, Modus, Grenzen, Einladung mit 409, Export 501). */
export class BetriebAttrappe implements Transport {
  modus = 'normal'; grenzen: Record<string, unknown> = {}; nutzer: string[] = []; beispiel = false; aufrufe: string[] = [];
  constructor(public token = 'b'.repeat(64), public exportGebaut = false) {}
  antwort(methode: string, pfad: string, body: Record<string, unknown> | undefined, auth: string | undefined): BetriebAntwort {
    this.aufrufe.push(`${methode} ${pfad}`);
    if (auth !== `Bearer ${this.token}`) return { status: 401, json: { fehler: 'Nicht berechtigt.' } };
    switch (`${methode} ${pfad}`) {
      case 'GET /_betrieb/status': return { status: 200, json: { ok: true, version: '0.1.0', modus: this.modus, nutzer: this.nutzer.length, artikel: 12, quellen: 7, speicher_bytes: 48213, zugaenge_oauth: 1, ki_art: 'mock', ki_verbrauch_cent_monat: null, ki_kontingent_cent_monat: this.grenzen.ki_kontingent_cent_monat ?? null, grenzen: this.grenzen } };
      case 'POST /_betrieb/modus': this.modus = String(body?.modus); return { status: 200, json: { modus: this.modus } };
      case 'POST /_betrieb/grenzen': this.grenzen = { ...body }; return { status: 200, json: { grenzen: this.grenzen } };
      case 'POST /_betrieb/einladung': {
        const name = String(body?.name);
        if (this.nutzer.includes(name)) return { status: 409, json: { fehler: 'Diesen Zugang gibt es schon.' } };
        this.nutzer.push(name);
        return { status: 201, json: { benutzer_id: `u_${this.nutzer.length}`, einmalPasswort: 'EinmalPasswort123', mussPasswortAendern: true } };
      }
      case 'POST /_betrieb/beispiel': this.beispiel = body?.aktion === 'laden'; return { status: 200, json: { ok: true, quellen: 9 } };
      case 'POST /_betrieb/export': return this.exportGebaut ? { status: 200, json: { bytes: 1234, sha256: 'a'.repeat(64) } } : { status: 501, json: { fehler: 'Export über den Leitstand kommt mit core-Export (v1.4 7.1).' } };
      default: return { status: 404, json: { fehler: 'Nicht gefunden.' } };
    }
  }
  async anfrage(methode: 'GET' | 'POST', pfad: string, body?: unknown) { return this.antwort(methode, pfad, body as Record<string, unknown> | undefined, `Bearer ${this.token}`); }
}
