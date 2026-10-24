/**
 * Verwaltung des Egress-Proxys `kern-egress` (D2, deploy/egress/kern-egress.mjs, Port 3129, Bearer = admin-token).
 * Form mit D2 abgestimmt (24.10.2026): PUT/GET/DELETE /v1/instanzen/:id und /v1/instanzen/:id/egress.
 * Fehlerform { fehler, code }.
 */
export class EgressVerwaltung {
  constructor(private basis: string, private token: string, private f: typeof fetch = fetch) {}
  private async rufe(methode: string, pfad: string, body?: unknown, ok: number[] = [200]) {
    const r = await this.f(`${this.basis.replace(/\/$/, '')}${pfad}`, { method: methode, headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!ok.includes(r.status)) throw new Error(`Egress ${r.status}${typeof j.code === 'string' ? ` ${j.code}` : ''}: ${String(j.fehler ?? '').slice(0, 160)}`);
    return { status: r.status, j };
  }
  registrieren(id: string, e: { subdomain: string; token_sha256: string; netz_ip?: string; web_offen: boolean }) { return this.rufe('PUT', `/v1/instanzen/${id}`, e).then((r) => r.j); }
  abmelden(id: string) { return this.rufe('DELETE', `/v1/instanzen/${id}`, undefined, [200, 404]).then((r) => r.j); }
  freigabenSetzen(id: string, hosts: string[], grund = 'Freigabe im Leitstand') { return this.rufe('PUT', `/v1/instanzen/${id}/egress`, { hosts: hosts.map((host) => ({ host, grund })) }).then((r) => r.j); }
}
