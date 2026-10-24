/**
 * Schmaler Client für die Docker Engine API (ohne Abhängigkeiten). Geprüft gegen die Swagger-Definition
 * https://docs.docker.com/reference/api/engine/version/v1.47.yaml (abgerufen 24.10.2026) und gegen einen lokalen
 * dockerd 29.8.2 (API 1.56). Verbindung: lokaler Socket oder TCP mit TLS (Client-Zertifikat), konfigurierbar.
 *
 * Nur die Aufrufe, die der Bereitsteller braucht. Pfade werden mit Versionspräfix gebaut (`/v1.47/...`), damit ein
 * neuerer Daemon das alte Verhalten liefert.
 */
import http from 'node:http';
import https from 'node:https';

export type EngineVerbindung =
  | { art: 'socket'; pfad?: string }
  | { art: 'tcp'; host: string; port?: number; tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer } }
  /** Nur über den WireGuard-Tunnel (10.99.0.0/16): Klartext-HTTP, Schutz und Authentisierung leistet WireGuard. */
  | { art: 'wg'; host: string; port?: number };

export class EngineFehler extends Error {
  constructor(public status: number, meldung: string) { super(meldung); }
}

export interface Antwort { status: number; body: Buffer; kopf: http.IncomingHttpHeaders }

export class DockerEngine {
  readonly version: string;
  constructor(private v: EngineVerbindung = { art: 'socket' }, opt: { version?: string; zeitMs?: number } = {}) {
    if (v.art === 'wg' && !/^10\.99\.\d{1,3}\.\d{1,3}$/.test(v.host)) throw new Error('Docker ohne TLS nur über eine Tunneladresse 10.99.x.y');
    this.version = opt.version ?? 'v1.47';
    this.zeitMs = opt.zeitMs ?? 60_000;
  }
  private zeitMs: number;

  roh(methode: string, pfad: string, body?: unknown, kopf: Record<string, string> = {}): Promise<Antwort> {
    const daten = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { host: 'docker', ...kopf };
    if (daten) { headers['content-length'] = String(daten.length); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
    const basis = { method: methode, path: `/${this.version}${pfad}`, headers, timeout: this.zeitMs };
    return new Promise((ok, nein) => {
      const req = this.v.art === 'socket'
        ? http.request({ ...basis, socketPath: this.v.pfad ?? '/var/run/docker.sock' })
        : this.v.art === 'wg'
        ? http.request({ ...basis, host: this.v.host, port: this.v.port ?? 2375, agent: false })
        : https.request({ ...basis, host: this.v.host, port: this.v.port ?? 2376, ca: this.v.tls.ca, cert: this.v.tls.cert, key: this.v.tls.key, rejectUnauthorized: true });
      req.on('response', (res) => {
        const teile: Buffer[] = [];
        res.on('data', (d: Buffer) => teile.push(d));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(teile), kopf: res.headers }));
        res.on('error', nein);
      });
      req.on('timeout', () => req.destroy(new Error(`Docker: Zeitüberschreitung bei ${methode} ${pfad.split('?')[0]}`)));
      req.on('error', nein);
      if (daten) req.write(daten);
      req.end();
    });
  }

  async json<T>(methode: string, pfad: string, body?: unknown, erlaubt: number[] = []): Promise<T> {
    const r = await this.roh(methode, pfad, body);
    if (r.status >= 400 && !erlaubt.includes(r.status)) {
      let m = r.body.toString('utf8').slice(0, 300);
      try { m = (JSON.parse(m) as { message?: string }).message ?? m; } catch { /* Text */ }
      throw new EngineFehler(r.status, `Docker ${r.status}: ${m}`);
    }
    if (!r.body.length) return undefined as T;
    try { return JSON.parse(r.body.toString('utf8')) as T; } catch { return r.body.toString('utf8') as T; }
  }

  ping() { return this.json<string>('GET', '/_ping'); }
  bild(name: string) { return this.json<{ Id: string; Config?: { Healthcheck?: unknown } }>('GET', `/images/${encodeURIComponent(name)}/json`); }

  // Container
  containerAnlegen(name: string, spec: unknown) { return this.json<{ Id: string; Warnings?: string[] }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec); }
  containerStarten(id: string) { return this.json<void>('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, [304]); }
  containerStoppen(id: string, sek = 10) { return this.json<void>('POST', `/containers/${encodeURIComponent(id)}/stop?t=${sek}`, undefined, [304, 404]); }
  containerInfo(id: string) { return this.json<ContainerInfo>('GET', `/containers/${encodeURIComponent(id)}/json`); }
  async containerInfoOpt(id: string): Promise<ContainerInfo | null> {
    try { return await this.containerInfo(id); } catch (e) { if (e instanceof EngineFehler && e.status === 404) return null; throw e; }
  }
  containerEntfernen(id: string) { return this.json<void>('DELETE', `/containers/${encodeURIComponent(id)}?force=true&v=false`, undefined, [404]); }
  containerUmbenennen(id: string, name: string) { return this.json<void>('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`); }
  containerAendern(id: string, grenzen: Record<string, unknown>) { return this.json<{ Warnings?: string[] }>('POST', `/containers/${encodeURIComponent(id)}/update`, grenzen); }
  containerListe(label: string) { return this.json<{ Id: string; Names: string[]; Labels: Record<string, string>; State: string }[]>('GET', `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`); }
  /** Tar-Archiv eines Pfads im Container (GET /containers/{id}/archive). */
  async archivHolen(id: string, pfad: string): Promise<Buffer> {
    const r = await this.roh('GET', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(pfad)}`);
    if (r.status !== 200) throw new EngineFehler(r.status, `Docker ${r.status} beim Archiv`);
    return r.body;
  }
  async archivEinspielen(id: string, pfad: string, tar: Buffer): Promise<void> {
    const r = await this.roh('PUT', `/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(pfad)}`, tar, { 'content-type': 'application/x-tar' });
    if (r.status !== 200) throw new EngineFehler(r.status, `Docker ${r.status} beim Einspielen: ${r.body.toString('utf8').slice(0, 200)}`);
  }

  // Netze
  netzAnlegen(spec: unknown) { return this.json<{ Id: string }>('POST', '/networks/create', spec); }
  netzInfo(name: string) { return this.json<{ Id: string; Name: string; Internal: boolean; Labels: Record<string, string>; IPAM: { Config: { Subnet?: string; Gateway?: string }[] }; Containers?: Record<string, { Name: string; IPv4Address: string }> }>('GET', `/networks/${encodeURIComponent(name)}`); }
  async netzInfoOpt(name: string) { try { return await this.netzInfo(name); } catch (e) { if (e instanceof EngineFehler && e.status === 404) return null; throw e; } }
  netzListe(label: string) { return this.json<{ Id: string; Name: string; Labels: Record<string, string>; IPAM: { Config: { Subnet?: string }[] } }[]>('GET', `/networks?filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`); }
  netzVerbinden(netz: string, container: string, ip?: string) {
    return this.json<void>('POST', `/networks/${encodeURIComponent(netz)}/connect`, { Container: container, ...(ip ? { EndpointConfig: { IPAMConfig: { IPv4Address: ip } } } : {}) }, [403]);
  }
  netzTrennen(netz: string, container: string) { return this.json<void>('POST', `/networks/${encodeURIComponent(netz)}/disconnect`, { Container: container, Force: true }, [404, 500]); }
  netzEntfernen(netz: string) { return this.json<void>('DELETE', `/networks/${encodeURIComponent(netz)}`, undefined, [404]); }

  // Volumes
  volumeAnlegen(name: string, labels: Record<string, string>, driverOpts?: Record<string, string>) { return this.json<{ Name: string; Mountpoint: string }>('POST', '/volumes/create', { Name: name, Labels: labels, ...(driverOpts ? { DriverOpts: driverOpts } : {}) }); }
  volumeInfoOpt(name: string) { return this.json<{ Name: string; Labels: Record<string, string> } | undefined>('GET', `/volumes/${encodeURIComponent(name)}`, undefined, [404]).then((v) => (v && 'Name' in v ? v : null)); }
  volumeEntfernen(name: string) { return this.json<void>('DELETE', `/volumes/${encodeURIComponent(name)}?force=false`, undefined, [404]); }

  /** Befehl im Container ausführen (POST /containers/{id}/exec, POST /exec/{id}/start, GET /exec/{id}/json). */
  async exec(container: string, cmd: string[], opt: { user?: string; env?: string[] } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    const e = await this.json<{ Id: string }>('POST', `/containers/${encodeURIComponent(container)}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, ...(opt.user ? { User: opt.user } : {}), ...(opt.env ? { Env: opt.env } : {}) });
    const r = await this.roh('POST', `/exec/${e.Id}/start`, { Detach: false, Tty: false });
    if (r.status !== 200) throw new EngineFehler(r.status, `Docker ${r.status} bei exec`);
    const { stdout, stderr } = entmische(r.body);
    const info = await this.json<{ ExitCode: number | null }>('GET', `/exec/${e.Id}/json`);
    return { code: info.ExitCode ?? -1, stdout, stderr };
  }
}

/** Multiplexed Stream: 8 Byte Kopf [Typ,0,0,0,Größe uint32 BE], dann Nutzlast (Engine-API „Stream format“). */
export function entmische(b: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [], err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= b.length) {
    const typ = b[i]!, n = b.readUInt32BE(i + 4);
    const teil = b.subarray(i + 8, i + 8 + n);
    (typ === 2 ? err : out).push(teil);
    i += 8 + n;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string>; Image: string; Env?: string[] };
  State: { Status: string; Running: boolean; Health?: { Status: 'starting' | 'healthy' | 'unhealthy' } };
  HostConfig: { NanoCpus: number; Memory: number; MemorySwap: number; MemoryReservation: number; PidsLimit: number | null; ReadonlyRootfs: boolean; CapDrop: string[] | null; SecurityOpt: string[] | null };
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> };
  RestartCount: number;
}
