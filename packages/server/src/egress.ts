import { EnvHttpProxyAgent, fetch as ufetch, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

/**
 * v1.4 3.7 und H1: Ausgehende Abrufe des Servers (Konto-Brücke zum Leitstand, Verbindungstest der KI,
 * KI-Anbieter über das globale fetch) laufen über den Egress-Proxy aus der Umgebung, sobald
 * HTTPS_PROXY oder HTTP_PROXY gesetzt ist. NO_PROXY gilt wie üblich.
 *
 * Node 22 kennt NODE_USE_ENV_PROXY erst in neueren Versionen und nicht in jeder 22er-Linie; deshalb
 * undici `EnvHttpProxyAgent` ausdrücklich. Geprüft: `setGlobalDispatcher` aus undici 7 wirkt auch auf das
 * eingebaute fetch von Node 22 (gemeinsames Symbol `undici.globalDispatcher.1`).
 */
export interface ProxyEinstellung { httpProxy?: string; httpsProxy?: string; noProxy?: string }

const wert = (env: NodeJS.ProcessEnv, n: string): string | undefined => {
  const v = env[n] ?? env[n.toLowerCase()];
  return v && v.trim() ? v.trim() : undefined;
};

/** Proxy-Angaben aus der Umgebung oder null, wenn keiner gesetzt ist. */
export function proxyAusUmgebung(env: NodeJS.ProcessEnv): ProxyEinstellung | null {
  const httpsProxy = wert(env, 'HTTPS_PROXY');
  const httpProxy = wert(env, 'HTTP_PROXY');
  if (!httpsProxy && !httpProxy) return null;
  return { httpProxy: httpProxy ?? httpsProxy, httpsProxy: httpsProxy ?? httpProxy, noProxy: wert(env, 'NO_PROXY') ?? '' };
}

export function proxyDispatcher(p: ProxyEinstellung | null): Dispatcher | undefined {
  if (!p) return undefined;
  return new EnvHttpProxyAgent({ ...(p.httpProxy ? { httpProxy: p.httpProxy } : {}), ...(p.httpsProxy ? { httpsProxy: p.httpsProxy } : {}), noProxy: p.noProxy ?? '' });
}

/** Ausgehender Abruf des Servers; mit Proxy über undici, sonst über das eingebaute fetch. */
export type Abruf = (url: string, init?: RequestInit & { zeitMs?: number }) => Promise<Response>;

export function bauAbruf(p: ProxyEinstellung | null): Abruf {
  const d = proxyDispatcher(p);
  return async (url, init = {}) => {
    const { zeitMs, ...rest } = init;
    const signal = rest.signal ?? AbortSignal.timeout(zeitMs ?? 10_000);
    if (!d) return fetch(url, { ...rest, signal });
    // undici-Typen weichen von lib.dom ab; zur Laufzeit sind es dieselben Formen.
    return (await ufetch(url, { ...(rest as object), signal, dispatcher: d } as Parameters<typeof ufetch>[1])) as unknown as Response;
  };
}

let installiert: Dispatcher | null = null;

/**
 * Setzt den Proxy als globalen Dispatcher (wirkt auf fetch in core-Anbietern). Einmal je Prozess.
 * Gibt true zurück, wenn ein Proxy aktiv ist.
 */
export function installiereEgress(env: NodeJS.ProcessEnv): boolean {
  // Globales fetch nutzen nur KI-Anbieter: dann Kanal ".ki" (KERN_KI_PROXY, nur Erlaubnisliste), sonst HTTPS_PROXY.
  const ki = wert(env, 'KERN_KI_PROXY');
  const p = ki ? { httpProxy: ki, httpsProxy: ki, noProxy: wert(env, 'NO_PROXY') ?? '' } : proxyAusUmgebung(env);
  if (!p) return false;
  if (installiert && getGlobalDispatcher() === installiert) return true;
  installiert = proxyDispatcher(p)!;
  setGlobalDispatcher(installiert);
  return true;
}
