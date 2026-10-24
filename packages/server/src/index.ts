import fs from 'node:fs';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { erstelleApp, type KernApp } from './app.js';
import { ladeKonfiguration, type ServerConfig } from './config.js';
import { oeffneKern } from './kern-laden.js';
import type { KernLike } from './types.js';
import { startePlaner } from './planer.js';
import { leseKernYaml } from './config.js';
import { installiereEgress } from './egress.js';

export * from './types.js';
export { erstelleApp, CSRF_HEADER, MCP_PFAD, PRM_PFAD } from './app.js';
export type { KernApp, AppOptionen } from './app.js';
export { ladeKonfiguration, leseKernYaml, schreibeKernYaml, bauProvider } from './config.js';
export type { ServerConfig, KernYaml } from './config.js';
export { oeffneKern, leseQuelle } from './kern-laden.js';
export { ErsatzZugang, waehleZugang, ALLE_SCOPES, freigebenErlaubt } from './zugang.js';
export type { ZugangLike, TokenEintrag, TokenArt, Scope } from './zugang.js';
export { Fenster, KontoSperre, herkunftsIp } from './grenzen.js';
export { STANDARD_ANBIETER, ERLAUBTE_KEY_ENV, ladeAnbieterListe } from './anbieter.js';
export type { Anbieter } from './anbieter.js';
export { KernFehler, statusAusFehler } from './fehler.js';
export { pruefeRelPfad, sicherVerbinden, artikelPfad, quellenPfad } from './pfade.js';
export { teileFrontmatter, bauFrontmatter } from './frontmatter.js';
export { darf, pruefeZiel, agentenScopes, alsAgent, engereReichweite, inReichweite, profilVonScopes, type AgentenProfil } from './rechte.js';
export { sammelEntscheiden } from './sammel.js';
export { pruefeAnhang, anhangMaxBytes, ANHANG_MAX_MB_STANDARD } from './anhang.js';
export { startePlaner } from './planer.js';
export { bauDatenweg } from './datenweg.js';
export type { Datenweg, DatenwegStrecke } from './datenweg.js';
export { MCP_TOOLS, TOOL_SCOPE, bauMcpServer, bearbeiteMcp } from './mcp.js';
export { FakeKern } from './testing/fake-kern.js';
export { sammleDateien, schreibeZip, leseZipNamen, type ZipErgebnis } from './zip.js';
export { proxyAusUmgebung, proxyDispatcher, bauAbruf, installiereEgress, type Abruf, type ProxyEinstellung } from './egress.js';
export { VOREINSTELLUNGEN, voreinstellungenFuer, type KiVoreinstellung } from './voreinstellungen.js';
export { testeVerbindung, KiVerwaltung } from './ki.js';
export { Exporte, type ExportAuftrag } from './export.js';
export { pruefeProtokollversion, MCP_VERSIONEN, MCP_NEUESTE, wegweiser } from './mcp.js';
export { f12Hinweis, F12_HINWEIS, nurBekannteApps } from './oauth.js';

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
/**
 * Stufenwechsel und Umzug am Ziel (v1.4 7.2, O1 1.8.4): Ist `KERN_IMPORT_PAKET` gesetzt und der Datenordner noch leer
 * (kein kern.yaml), packt der Start das Umzugspaket vor dem Öffnen aus (Passphrase aus `KERN_IMPORT_PASSPHRASE` oder
 * der Datei `KERN_IMPORT_PASSPHRASE_DATEI`), prüft es danach mit core `umzugPruefen` und legt `.kern/pruefbericht.json` ab
 * (GET /_betrieb/pruefbericht). Bei jedem weiteren Start passiert nichts mehr (idempotent).
 */
export async function importBeimStart(dataDir: string, env: NodeJS.ProcessEnv, log: (s: string) => void): Promise<boolean> {
  const paket = env.KERN_IMPORT_PAKET;
  if (!paket) return false;
  if (fs.existsSync(path.join(dataDir, 'kern.yaml'))) return false;
  const pass = env.KERN_IMPORT_PASSPHRASE ?? (env.KERN_IMPORT_PASSPHRASE_DATEI ? fs.readFileSync(env.KERN_IMPORT_PASSPHRASE_DATEI, 'utf8').trim() : '');
  if (!pass) throw new Error('KERN_IMPORT_PAKET gesetzt, aber keine Passphrase (KERN_IMPORT_PASSPHRASE oder KERN_IMPORT_PASSPHRASE_DATEI).');
  const modName = '@kern/core';
  const core = (await import(modName)) as { umzugAuspacken?: (p: string, o: string, pw: string) => Promise<unknown> };
  if (typeof core.umzugAuspacken !== 'function') throw new Error('Diese core-Version kann kein Umzugspaket auspacken.');
  fs.mkdirSync(dataDir, { recursive: true });
  await core.umzugAuspacken(paket, dataDir, pass);
  log('[kern] Umzugspaket ausgepackt; Prüfung folgt nach dem Start.');
  return true;
}

export async function starteServer(opt: { config?: ServerConfig; kern?: KernLike; beobachten?: boolean; leise?: boolean } = {}): Promise<LaufenderServer> {
  let config = opt.config ?? ladeKonfiguration();
  const importiert = !opt.kern && !config.fake ? await importBeimStart(config.dataDir, config.umgebung, opt.leise ? () => {} : (s) => console.log(s)) : false;
  if (importiert) config = ladeKonfiguration({ dataDir: config.dataDir, port: config.port, env: config.umgebung });
  // v1.4 3.7: Egress-Proxy aus der Umgebung auch für fetch in core (KI-Anbieter), sobald HTTPS_PROXY gesetzt ist.
  const proxyAktiv = installiereEgress(config.umgebung);
  const kern = opt.kern ?? (await oeffneKern(config.kern, config.fake));
  if (importiert) {
    const k = kern as KernLike & { umzugPruefen?: (u: { id: string; name: string; rollen: string[]; teams: string[] }) => Promise<{ bestanden: boolean }> };
    const admin = (await kern.benutzer.liste()).find((u) => u.rollen.includes('admin'));
    if (typeof k.umzugPruefen === 'function' && admin) {
      const b = await k.umzugPruefen({ ...admin, rollen: ['admin'] }).catch((e: Error) => { console.error(`[kern] Umzugsprüfung fehlgeschlagen: ${e.message}`); return null; });
      if (b && !opt.leise) console.log(`[kern] Umzugsprüfung: ${b.bestanden ? 'bestanden' : 'NICHT bestanden'} (GET /_betrieb/pruefbericht).`);
    }
  }
  const kernApp = erstelleApp({ kern, config, version: VERSION });
  const stopBeobachten = opt.beobachten === false ? () => {} : kern.beobachteOrdner();
  const log = opt.leise ? () => {} : (...a: unknown[]) => console.log(...a);
  // v1.2: Planer für beobachtete Quellen. KERN_BEOBACHTEN_STUNDEN oder kern.yaml beobachtung.stunden, Standard 24, 0 = aus.
  const yStunden = Number(leseKernYaml(config.dataDir).beobachtung?.stunden);
  const envStunden = process.env.KERN_BEOBACHTEN_STUNDEN;
  const stunden = envStunden !== undefined && envStunden !== '' ? Number(envStunden) : Number.isFinite(yStunden) ? yStunden : 24;
  const planer = opt.beobachten === false ? { stop() {} } : startePlaner(kern, { stunden: Number.isFinite(stunden) ? stunden : 24, log: (s) => log(s), logInhalte: config.logInhalte });
  for (const w of config.warnungen) log(`[kern] Hinweis: ${w}`);
  if (proxyAktiv) log('[kern] Ausgehende Verbindungen laufen über den Proxy aus HTTPS_PROXY/HTTP_PROXY.');
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
