/**
 * Hetzner Cloud API (https://api.hetzner.cloud/v1), geprüft gegen die offizielle OpenAPI-Beschreibung
 * https://docs.hetzner.cloud/cloud.spec.json (info.version 1.0.0, abgerufen 24.10.2026):
 *   POST /servers (Pflicht: name, server_type, image; dazu location, ssh_keys, firewalls[{firewall}], user_data ≤ 32 KiB,
 *   labels, public_net, start_after_create), GET/DELETE /servers/{id}, GET /servers?label_selector=…,
 *   POST /firewalls (name, labels, rules[{direction, protocol, port, source_ips}]), GET /firewalls?name=…,
 *   DNS in der Cloud API: POST /zones/{zone}/rrsets (name, type, ttl, records[{value}]),
 *   POST /zones/{zone}/rrsets/{name}/{type}/actions/set_records, DELETE /zones/{zone}/rrsets/{name}/{type},
 *   GET /server_types?name=… (locations[].available).
 * Fehlerform { error: { code, message, details } }; Codes aus der Tabelle „Error Codes“, u. a. 412 resource_unavailable,
 * 409 uniqueness_error, 429 rate_limit_exceeded, 503 unavailable, 423 locked.
 *
 * Keine echten Aufrufe ohne Token: `fetch` ist austauschbar (Tests mit aufgezeichneten Antworten).
 */
export class HetznerFehler extends Error {
  constructor(public status: number, public code: string, meldung: string) { super(meldung); }
}

export interface HServer { id: number; name: string; status: string; created: string; labels: Record<string, string>; public_net: { ipv4: { ip: string } | null; ipv6: { ip: string } | null }; server_type: { name: string }; location?: { name: string } }

/** Codes, bei denen V-1 (G1) den nächsten Standort oder Typ versucht. */
export const NICHT_VERFUEGBAR = new Set(['resource_unavailable', 'placement_error', 'unavailable']);

export class HetznerApi {
  constructor(private token: string, private f: typeof fetch = fetch, private basis = 'https://api.hetzner.cloud/v1') {
    if (!token) throw new Error('Hetzner-Token fehlt: ohne Token keine Aufrufe');
  }
  async rufe<T>(methode: string, pfad: string, body?: unknown, ok: number[] = [200, 201, 204]): Promise<T> {
    const r = await this.f(`${this.basis}${pfad}`, { method: methode, headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    const j = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!ok.includes(r.status)) {
      const e = (j.error ?? {}) as { code?: string; message?: string };
      throw new HetznerFehler(r.status, e.code ?? 'unbekannt', `Hetzner ${r.status} ${e.code ?? ''}: ${String(e.message ?? '').slice(0, 200)}`);
    }
    return j as T;
  }

  async serverAnlegen(b: { name: string; server_type: string; location: string; image: string; ssh_keys: (string | number)[]; firewalls: { firewall: number }[]; user_data: string; labels: Record<string, string> }) {
    if (Buffer.byteLength(b.user_data) > 32 * 1024) throw new Error('user_data über 32 KiB (Grenze der Hetzner-API)');
    return this.rufe<{ server: HServer; action: { id: number; status: string } }>('POST', '/servers', { ...b, start_after_create: true, public_net: { enable_ipv4: true, enable_ipv6: true } });
  }
  server(id: number) { return this.rufe<{ server: HServer }>('GET', `/servers/${id}`).then((r) => r.server); }
  serverLoeschen(id: number) { return this.rufe<{ action?: unknown }>('DELETE', `/servers/${id}`, undefined, [200, 404]); }
  serverListe(labelSelector: string) { return this.rufe<{ servers: HServer[] }>('GET', `/servers?label_selector=${encodeURIComponent(labelSelector)}&per_page=50`).then((r) => r.servers); }
  async serverTypVerfuegbar(typ: string, standort: string): Promise<boolean | null> {
    const r = await this.rufe<{ server_types: { name: string; deprecated?: boolean; locations?: { name: string; available?: boolean }[] }[] }>('GET', `/server_types?name=${encodeURIComponent(typ)}`);
    const t = r.server_types[0];
    if (!t) return false;
    const l = t.locations?.find((x) => x.name === standort);
    return l ? l.available !== false : t.locations ? false : null;
  }
  async firewallSichern(name: string, labels: Record<string, string>): Promise<number> {
    const da = await this.rufe<{ firewalls: { id: number }[] }>('GET', `/firewalls?name=${encodeURIComponent(name)}`);
    if (da.firewalls[0]) return da.firewalls[0].id;
    const alle = ['0.0.0.0/0', '::/0'];
    const r = await this.rufe<{ firewall: { id: number } }>('POST', '/firewalls', {
      name, labels, rules: [
        { direction: 'in', protocol: 'tcp', port: '80', source_ips: alle, description: 'HTTP (ACME, Weiterleitung)' },
        { direction: 'in', protocol: 'tcp', port: '443', source_ips: alle, description: 'HTTPS' },
        { direction: 'in', protocol: 'udp', port: '443', source_ips: alle, description: 'HTTP/3' },
        { direction: 'in', protocol: 'udp', port: '51820', source_ips: alle, description: 'WireGuard zum Leitstand' },
        // SSH nur über WireGuard (O1 6.1): kein Port 22 von außen
      ],
    });
    return r.firewall.id;
  }
  async dnsSetzen(zone: string, name: string, typ: 'A' | 'AAAA', wert: string, ttl = 300): Promise<void> {
    const pfad = `/zones/${encodeURIComponent(zone)}/rrsets`;
    try {
      await this.rufe('POST', pfad, { name, type: typ, ttl, records: [{ value: wert }], labels: { kern: 'instanz' } });
    } catch (e) {
      if (!(e instanceof HetznerFehler) || e.code !== 'uniqueness_error') throw e;
      await this.rufe('POST', `${pfad}/${encodeURIComponent(name)}/${typ}/actions/set_records`, { records: [{ value: wert }] });
    }
  }
  dnsLoeschen(zone: string, name: string, typ: 'A' | 'AAAA') { return this.rufe('DELETE', `/zones/${encodeURIComponent(zone)}/rrsets/${encodeURIComponent(name)}/${typ}`, undefined, [200, 201, 204, 404]); }
}
