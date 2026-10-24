import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { bauMcpServer, VERSION, type KernLike, type User } from '@kern/server';

/**
 * v1.4 6.5 Lokales MCP.
 * `kern mcp`: stdio-Server direkt auf dem Datenordner, als der Benutzer aus KERN_ALS/--als, mit dessen Rechten.
 * Schreiben nur als Vorschlag (wie über HTTP). Kein OAuth: stdio holt Zugangsdaten aus der Umgebung.
 */
export async function starteStdio(kern: KernLike, user: User, o: { produktName?: string; modell: { anbieter: string; name: string } }): Promise<() => Promise<void>> {
  const server = bauMcpServer(kern, user, VERSION, {
    produktName: o.produktName ?? 'Kern',
    // D-L13: Kennzeichnung wie über HTTP, falls core sie nicht selbst setzt.
    kennzeichne: <T extends object>(a: T) => ({ ki_erzeugt: true, modell: o.modell, ...a }) as T,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return async () => { await server.close(); };
}

/**
 * `kern mcp --verbinde <url>`: lokale Brücke stdio ↔ Streamable HTTP für Instanzen, die nur im VPN erreichbar sind.
 * Token aus der Umgebung (Standard KERN_TOKEN), nie als Argument (Prozessliste, Shell-Verlauf).
 */
export async function starteBruecke(url: string, token: string, log: (s: string) => void): Promise<{ fertig: Promise<void>; stop(): Promise<void> }> {
  const ziel = new URL(url);
  if (!/^https?:$/.test(ziel.protocol)) throw new Error('Nur http(s)-Adressen.');
  if (ziel.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(ziel.hostname) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ziel.hostname)) {
    log('[kern] Warnung: unverschlüsselte Verbindung (http) über ein nicht lokales Netz. Das Token geht im Klartext über die Leitung.');
  }
  if (!/\/mcp\/?$/.test(ziel.pathname)) ziel.pathname = `${ziel.pathname.replace(/\/+$/, '')}/mcp`;
  const http = new StreamableHTTPClientTransport(ziel, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const stdio = new StdioServerTransport();
  let ende!: () => void;
  const fertig = new Promise<void>((r) => { ende = r; });
  stdio.onmessage = (m: JSONRPCMessage) => { http.send(m).catch((e: Error) => fehlerAntwort(m, e)); };
  http.onmessage = (m: JSONRPCMessage) => { void stdio.send(m); };
  http.onerror = (e) => log(`[kern] Verbindung: ${e.message}`);
  stdio.onclose = () => { void http.close().finally(ende); };
  http.onclose = () => ende();
  const fehlerAntwort = (m: JSONRPCMessage, e: Error) => {
    const id = (m as { id?: string | number }).id;
    log(`[kern] Anfrage fehlgeschlagen: ${e.message}`);
    if (id !== undefined) void stdio.send({ jsonrpc: '2.0', id, error: { code: -32000, message: `Verbindung zu ${ziel.host} fehlgeschlagen: ${e.message}` } } as JSONRPCMessage);
  };
  await http.start();
  await stdio.start();
  return { fertig, stop: async () => { await stdio.close(); await http.close(); } };
}
