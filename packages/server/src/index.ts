import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { erstelleApp, type KernApp } from './app.js';
import { ladeKonfiguration, type ServerConfig } from './config.js';
import { oeffneKern } from './kern-laden.js';
import type { KernLike } from './types.js';
import { startePlaner } from './planer.js';
import { leseKernYaml } from './config.js';

export * from './types.js';
export { erstelleApp, CSRF_HEADER, MCP_PFAD, PRM_PFAD } from './app.js';
export type { KernApp, AppOptionen } from './app.js';
export { ladeKonfiguration, leseKernYaml, schreibeKernYaml, bauProvider } from './config.js';
export type { ServerConfig, KernYaml } from './config.js';
export { oeffneKern, leseQuelle } from './kern-laden.js';
export { ErsatzZugang, waehleZugang, ALLE_SCOPES } from './zugang.js';
export type { ZugangLike, TokenEintrag, TokenArt, Scope } from './zugang.js';
export { Fenster, KontoSperre, herkunftsIp } from './grenzen.js';
export { STANDARD_ANBIETER, ERLAUBTE_KEY_ENV, ladeAnbieterListe } from './anbieter.js';
export type { Anbieter } from './anbieter.js';
export { KernFehler, statusAusFehler } from './fehler.js';
export { pruefeRelPfad, sicherVerbinden, artikelPfad, quellenPfad } from './pfade.js';
export { teileFrontmatter, bauFrontmatter } from './frontmatter.js';
export { darf, pruefeZiel } from './rechte.js';
export { startePlaner } from './planer.js';
export { bauDatenweg } from './datenweg.js';
export type { Datenweg, DatenwegStrecke } from './datenweg.js';
export { MCP_TOOLS, TOOL_SCOPE, bauMcpServer, bearbeiteMcp } from './mcp.js';
export { FakeKern } from './testing/fake-kern.js';

export const VERSION = '0.1.0';

export interface LaufenderServer {
  url: string;
  port: number;
  kern: KernLike;
  app: KernApp;
  config: ServerConfig;
  stop(): Promise<void>;
}

/** Startet den HTTP-Server. Ohne Angaben aus Umgebung und kern.yaml. */
export async function starteServer(opt: { config?: ServerConfig; kern?: KernLike; beobachten?: boolean; leise?: boolean } = {}): Promise<LaufenderServer> {
  const config = opt.config ?? ladeKonfiguration();
  const kern = opt.kern ?? (await oeffneKern(config.kern, config.fake));
  const kernApp = erstelleApp({ kern, config, version: VERSION });
  const stopBeobachten = opt.beobachten === false ? () => {} : kern.beobachteOrdner();
  const log = opt.leise ? () => {} : (...a: unknown[]) => console.log(...a);
  // v1.2: Planer für beobachtete Quellen. KERN_BEOBACHTEN_STUNDEN oder kern.yaml beobachtung.stunden, Standard 24, 0 = aus.
  const yStunden = Number(leseKernYaml(config.dataDir).beobachtung?.stunden);
  const envStunden = process.env.KERN_BEOBACHTEN_STUNDEN;
  const stunden = envStunden !== undefined && envStunden !== '' ? Number(envStunden) : Number.isFinite(yStunden) ? yStunden : 24;
  const planer = opt.beobachten === false ? { stop() {} } : startePlaner(kern, { stunden: Number.isFinite(stunden) ? stunden : 24, log: (s) => log(s), logInhalte: config.logInhalte });
  for (const w of config.warnungen) log(`[kern] Hinweis: ${w}`);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: kernApp.app.fetch, port: config.port, hostname: config.host }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`;
  log(`[kern] läuft auf ${url} (Daten: ${config.dataDir}${config.fake ? ', Attrappe' : ''}, KI: ${config.kern.provider.art})`);
  return {
    url, port, kern, app: kernApp, config,
    stop: () => new Promise<void>((resolve) => {
      stopBeobachten();
      planer.stop();
      server.close(() => { void Promise.resolve(kern.schliesse?.()).catch(() => {}).finally(() => resolve()); });
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    }),
  };
}
