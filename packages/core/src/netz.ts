/**
 * Eine Schutzschicht für jeden Abruf fremder Adressen (S1 H1, SSRF).
 * - nur http/https, keine Zugangsdaten in der URL, Ports standardmäßig nur 80/443
 * - DNS auflösen, alle Adressen prüfen; gesperrt sind Loopback, private Netze, Link-Local (Metadaten-Dienste),
 *   CGNAT, ULA, Multicast, Dokumentations- und reservierte Bereiche, auch in IPv6-Verpackung (::ffff:, 64:ff9b::)
 * - die Verbindung geht an genau die geprüfte Adresse (kein DNS-Rebinding)
 * - Weiterleitungen von Hand, höchstens 3, jede neu geprüft
 * - Größen- und Zeitgrenze beim Lesen
 * - mit HTTP(S)_PROXY (Managed-Betrieb mit Egress-Proxy) geht der Abruf über den Proxy (undici EnvHttpProxyAgent);
 *   die eigenen Prüfungen gelten zusätzlich. Löst der Name lokal nicht auf, entscheidet der Proxy.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as ufetch, type Dispatcher } from 'undici';

export interface NetzOptionen {
  /** Höchstgröße der Antwort in Bytes (Standard 5 MB). */
  maxBytes?: number;
  /** Gesamtzeit (Standard 20 s). */
  timeoutMs?: number;
  /** Höchstzahl Weiterleitungen (Standard 3). */
  maxWeiterleitungen?: number;
  /** Erlaubte Ports (Standard 80, 443); `'alle'` nur für Tests oder ausdrücklich gewollte Installationen. */
  erlaubtePorts?: number[] | 'alle';
  /** Ausdrücklich erlaubte Adressen trotz Sperrbereich (z. B. ein bestimmter Intranet-Server); Standard keine. */
  erlaubeAdressen?: string[];
  /** Proxy-Einstellungen; Standard aus der Umgebung (HTTPS_PROXY, HTTP_PROXY, NO_PROXY). `null` = ohne Proxy. */
  proxy?: { httpProxy?: string; httpsProxy?: string; noProxy?: string } | null;
  /** Für Tests: eigene Namensauflösung. */
  aufloesen?: (host: string) => Promise<string[]>;
  headers?: Record<string, string>;
}

export class NetzFehler extends Error {
  constructor(public grund: 'adresse' | 'gesperrt' | 'port' | 'weiterleitung' | 'zu_gross' | 'zeit' | 'status' | 'netz', message: string, public status?: number) {
    super(message);
    this.name = 'NetzFehler';
  }
}

const GESPERRT = new BlockList();
for (const [netz, praefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) GESPERRT.addSubnet(netz, praefix, 'ipv4');
for (const [netz, praefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16],
] as const) GESPERRT.addSubnet(netz, praefix, 'ipv6');

/** IPv4 aus IPv6-Verpackung holen (::ffff:a.b.c.d, ::ffff:xxxx:xxxx, 64:ff9b::/96, ::a.b.c.d). */
function eingebettetesV4(ip: string): string | null {
  const l = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const m = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (m) return m[1]!;
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
  if (h) {
    const a = parseInt(h[1]!, 16);
    const b = parseInt(h[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** true, wenn die Adresse in einem gesperrten Bereich liegt. */
export function istGesperrt(ip: string): boolean {
  const roh = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const v = isIP(roh);
  if (v === 4) return GESPERRT.check(roh, 'ipv4');
  if (v === 6) {
    const v4 = eingebettetesV4(roh);
    if (v4) return GESPERRT.check(v4, 'ipv4');
    return GESPERRT.check(roh, 'ipv6');
  }
  return true; // keine gültige Adresse ⇒ sperren
}

function proxyAusUmgebung(): NetzOptionen['proxy'] {
  const env = process.env;
  const httpsProxy = env['HTTPS_PROXY'] ?? env['https_proxy'];
  const httpProxy = env['HTTP_PROXY'] ?? env['http_proxy'];
  const noProxy = env['NO_PROXY'] ?? env['no_proxy'];
  if (!httpsProxy && !httpProxy) return null;
  return { ...(httpProxy ? { httpProxy } : {}), ...(httpsProxy ? { httpsProxy } : {}), ...(noProxy ? { noProxy } : {}) };
}

function umgehtProxy(host: string, noProxy?: string): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy.split(/[\s,]+/).filter(Boolean).some((e) => {
    const x = e.toLowerCase().replace(/^\*?\./, '');
    return x === '*' || h === x || h.endsWith(`.${x}`);
  });
}

/** Prüft eine URL und liefert die geprüften Zieladressen (leer, wenn der Proxy auflöst). */
async function pruefeZiel(url: URL, o: NetzOptionen, mitProxy: boolean): Promise<string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetzFehler('adresse', 'Nur http(s)-Adressen');
  if (url.username || url.password) throw new NetzFehler('adresse', 'Adressen mit Zugangsdaten werden nicht abgerufen');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const ports = o.erlaubtePorts ?? [80, 443];
  if (ports !== 'alle' && !ports.includes(port)) throw new NetzFehler('port', `Port ${port} ist nicht erlaubt (nur ${ports.join(', ')})`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const erlaubt = new Set(o.erlaubeAdressen ?? []);
  let adressen: string[];
  if (isIP(host)) adressen = [host];
  else {
    try {
      adressen = o.aufloesen ? await o.aufloesen(host) : (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      if (mitProxy) return []; // im abgeschotteten Netz löst nur der Proxy auf
      throw new NetzFehler('adresse', `Name ${host} lässt sich nicht auflösen`);
    }
  }
  if (!adressen.length && !mitProxy) throw new NetzFehler('adresse', `Name ${host} lässt sich nicht auflösen`);
  for (const a of adressen) if (istGesperrt(a) && !erlaubt.has(a)) throw new NetzFehler('gesperrt', `Ziel ${host} liegt in einem gesperrten Netz (intern, lokal oder Metadaten-Dienst)`);
  return adressen;
}

/** Verbindung nur zu den geprüften Adressen (gegen DNS-Rebinding). */
function festeAdresseAgent(adressen: string[], timeoutMs: number): Agent {
  const familie = (a: string) => (isIP(a) === 6 ? 6 : 4);
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (_host: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
        if (opts?.all) cb(null, adressen.map((a) => ({ address: a, family: familie(a) })));
        else cb(null, adressen[0]!, familie(adressen[0]!));
      },
    } as never,
  });
}

export interface AbrufErgebnis { status: number; url: string; typ: string; daten: Buffer; text: () => string }

/** Sicherer Abruf mit allen Prüfungen. Wirft `NetzFehler`. */
export async function sichererAbruf(adresse: string, o: NetzOptionen = {}): Promise<AbrufErgebnis> {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const maxW = o.maxWeiterleitungen ?? 3;
  const proxy = o.proxy === undefined ? proxyAusUmgebung() : o.proxy;
  const ctrl = new AbortController();
  const zeit = setTimeout(() => ctrl.abort(), timeoutMs);
  let url: URL;
  try {
    url = new URL(adresse);
  } catch {
    clearTimeout(zeit);
    throw new NetzFehler('adresse', 'Ungültige Adresse');
  }
  try {
    for (let hop = 0; ; hop++) {
      const mitProxy = !!proxy && !!(url.protocol === 'https:' ? proxy.httpsProxy ?? proxy.httpProxy : proxy.httpProxy) && !umgehtProxy(url.hostname, proxy.noProxy);
      const adressen = await pruefeZiel(url, o, mitProxy);
      const dispatcher: Dispatcher = mitProxy
        ? new EnvHttpProxyAgent({ ...(proxy!.httpProxy ? { httpProxy: proxy!.httpProxy } : {}), ...(proxy!.httpsProxy ? { httpsProxy: proxy!.httpsProxy } : {}), noProxy: proxy!.noProxy ?? '' })
        : festeAdresseAgent(adressen, timeoutMs);
      let r: Awaited<ReturnType<typeof ufetch>>;
      try {
        r = await ufetch(url, { dispatcher, redirect: 'manual', signal: ctrl.signal, headers: o.headers ?? {} });
      } catch (e) {
        void dispatcher.close().catch(() => {});
        if (ctrl.signal.aborted) throw new NetzFehler('zeit', `Zeitgrenze ${Math.round(timeoutMs / 1000)} s überschritten`);
        throw new NetzFehler('netz', `Abruf fehlgeschlagen: ${(e as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        await r.body?.cancel().catch(() => {});
        void dispatcher.close().catch(() => {});
        const ziel = r.headers.get('location');
        if (!ziel) throw new NetzFehler('weiterleitung', 'Weiterleitung ohne Ziel');
        if (hop >= maxW) throw new NetzFehler('weiterleitung', `Mehr als ${maxW} Weiterleitungen`);
        url = new URL(ziel, url);
        continue;
      }
      const laenge = Number(r.headers.get('content-length') ?? 0);
      if (laenge > maxBytes) {
        await r.body?.cancel().catch(() => {});
        void dispatcher.close().catch(() => {});
        throw new NetzFehler('zu_gross', `Antwort größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      const teile: Buffer[] = [];
      let n = 0;
      try {
        if (r.body) {
          for await (const stueck of r.body as unknown as AsyncIterable<Uint8Array>) {
            n += stueck.byteLength;
            if (n > maxBytes) {
              ctrl.abort();
              throw new NetzFehler('zu_gross', `Antwort größer als ${Math.round(maxBytes / 1024 / 1024)} MB`);
            }
            teile.push(Buffer.from(stueck));
          }
        }
      } catch (e) {
        if (e instanceof NetzFehler) throw e;
        if (ctrl.signal.aborted) throw new NetzFehler('zeit', `Zeitgrenze ${Math.round(timeoutMs / 1000)} s überschritten`);
        throw new NetzFehler('netz', `Abruf abgebrochen: ${(e as Error).message}`);
      } finally {
        void dispatcher.close().catch(() => {});
      }
      const daten = Buffer.concat(teile);
      return { status: r.status, url: url.toString(), typ: r.headers.get('content-type') ?? '', daten, text: () => daten.toString('utf8') };
    }
  } finally {
    clearTimeout(zeit);
  }
}

let proxyCache: { schluessel: string; agent: EnvHttpProxyAgent } | null = null;

/**
 * Gemeinsamer Proxy-Dispatcher für alle ausgehenden Aufrufe (KI-Anbieter, Konto-Brücke, Verbindungstest):
 * mit HTTP(S)_PROXY ein undici EnvHttpProxyAgent (NO_PROXY gilt), sonst `undefined`. Loopback geht nie über den Proxy.
 */
export function proxyDispatcher(url: string, proxy: NetzOptionen['proxy'] = proxyAusUmgebung()): Dispatcher | undefined {
  if (!proxy) return undefined;
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && (host === '::1' || host.startsWith('127.')))) return undefined;
  if (umgehtProxy(host, proxy.noProxy)) return undefined;
  if (!(u.protocol === 'https:' ? proxy.httpsProxy ?? proxy.httpProxy : proxy.httpProxy)) return undefined;
  const schluessel = JSON.stringify(proxy);
  if (!proxyCache || proxyCache.schluessel !== schluessel) {
    proxyCache = { schluessel, agent: new EnvHttpProxyAgent({ ...(proxy.httpProxy ? { httpProxy: proxy.httpProxy } : {}), ...(proxy.httpsProxy ? { httpsProxy: proxy.httpsProxy } : {}), noProxy: proxy.noProxy ?? '' }) };
  }
  return proxyCache.agent;
}

/** fetch mit gemeinsamem Proxy (für vertrauenswürdige, konfigurierte Ziele; fremde URLs immer über `sichererAbruf`). */
export function fetchMitProxy(url: string, init: Parameters<typeof ufetch>[1] = {}): ReturnType<typeof ufetch> {
  const d = proxyDispatcher(url);
  return ufetch(url, { ...init, ...(d ? { dispatcher: d } : {}) });
}

let kiCache: { uri: string; agent: ProxyAgent } | null = null;

/**
 * Dispatcher für KI-Anbieter (v1.4 3.7, Egress-Kanal „.ki“): `KERN_KI_PROXY` (z. B. `http://<id>.ki:<token>@kern-egress:3128`,
 * nur Erlaubnisliste) hat Vorrang, sonst wie `proxyDispatcher` (HTTP(S)_PROXY, NO_PROXY). Loopback nie über einen Proxy.
 */
export function kiDispatcher(url: string, kiProxy: string | undefined = process.env['KERN_KI_PROXY']): Dispatcher | undefined {
  if (!kiProxy) return proxyDispatcher(url);
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && (host === '::1' || host.startsWith('127.')))) return undefined;
  if (!kiCache || kiCache.uri !== kiProxy) {
    const p = new URL(kiProxy);
    const token = p.username || p.password ? `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` : undefined;
    p.username = '';
    p.password = '';
    kiCache = { uri: kiProxy, agent: new ProxyAgent({ uri: p.toString(), ...(token ? { token } : {}) }) };
  }
  return kiCache.agent;
}

/** fetch für KI-Anbieter über `kiDispatcher`. */
export function fetchKi(url: string, init: Parameters<typeof ufetch>[1] = {}): ReturnType<typeof ufetch> {
  const d = kiDispatcher(url);
  return ufetch(url, { ...init, ...(d ? { dispatcher: d } : {}) });
}
