import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { KernConfig, ProviderConfig } from './types.js';
import { ERLAUBTE_KEY_ENV, ladeAnbieterListe, type Anbieter } from './anbieter.js';
import { Geheimnisse } from './geheimnisse.js';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Schlüssel zum Signieren der Sitzungs-Cookies. */
  secret: string;
  secretAusEnv: boolean;
  produktion: boolean;
  secureCookie: boolean;
  noindex: boolean;
  maxUploadBytes: number;
  trustProxy: boolean;
  /** Anzahl vertrauter Proxys vor dem Server (0 = keiner). */
  proxyHops: number;
  /** Öffentliche Adresse, z. B. https://kunde.example.de (für Origin, OAuth-Metadaten, HTTPS-Erkennung). */
  publicUrl: string | null;
  modus: Modus;
  anbieter: Anbieter[];
  grenzen: Grenzen;
  /** Erlaubte Origins für /mcp (zusätzlich zur eigenen Adresse). */
  mcpOrigins: string[];
  /** Titel, Adressen und Fehlerdetails ins Log schreiben (Standard aus). */
  logInhalte: boolean;
  /** OAuth-Autorisierungsserver (kommt mit v1.4, O1). Nur Ankündigung in den Metadaten. */
  oauthIssuer: string | null;
  /** Betriebs-Token für /_betrieb/* (nur intern; öffnet keine /api- oder /mcp-Route). */
  betriebToken: string | null;
  leitstandUrl: string | null;
  kontoToken: string | null;
  /** Schlüssel für .kern/geheimnisse.json (AES-256-GCM), nur aus der Umgebung. */
  geheimnisSchluessel: string | null;
  produktName: string;
  webDist: string;
  fake: boolean;
  sitzungStunden: number;
  kern: KernConfig;
  warnungen: string[];
}

export interface Grenzen {
  jsonVorLoginBytes: number;
  jsonBytes: number;
  vorschlagBytes: number;
  mcpBytes: number;
  fragenProMinute: number;
  fragenProMinuteInstanz: number;
  uploadsProMinute: number;
  sitzungenJeNutzer: number;
  fragenProTag: number;
  kiProTagInstanz: number;
  mcpProMinuteToken: number;
  apiProMinuteNutzer: number;
}

export interface KernYaml {
  betrieb?: string;
  sprache?: 'de' | 'en';
  teams?: string[];
  /** Anbieter; core schreibt ihn unter `ki`, beide Schlüssel werden gelesen. */
  provider?: Record<string, unknown>;
  ki?: Record<string, unknown>;
  beobachtung?: { stunden?: number };
  [k: string]: unknown;
}

const hier = path.dirname(fileURLToPath(import.meta.url));

export function leseKernYaml(dataDir: string): KernYaml {
  const datei = path.join(dataDir, 'kern.yaml');
  if (!fs.existsSync(datei)) return {};
  const roh: unknown = YAML.parse(fs.readFileSync(datei, 'utf8'));
  return roh && typeof roh === 'object' && !Array.isArray(roh) ? (roh as KernYaml) : {};
}

export function schreibeKernYaml(dataDir: string, daten: KernYaml): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'kern.yaml'), YAML.stringify(daten));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export type Modus = 'selbst' | 'managed';

export interface ProviderOptionen {
  modus?: Modus;
  anbieter?: Anbieter[];
  /** v1.4 5.2: verschlüsselt gespeicherte Schlüssel (Name → Wert), nie aus kern.yaml. */
  geheimnis?: (name: string) => string | undefined;
}

function hostVon(url: string): string {
  try { return new URL(url).host; } catch { return '(ungültige Adresse)'; }
}

/**
 * Baut die Anbieter-Konfiguration aus kern.yaml und Umgebungsvariablen.
 * Umgebungsvariablen setzt der Betreiber; kern.yaml kann ein Admin des Mandanten über die UI ändern.
 * H2: Schlüssel nur aus KERN_PROVIDER_KEY oder einer Variable, die zu ERLAUBTE_KEY_ENV passt.
 * Managed: Anbieter aus kern.yaml nur als `anbieter: <id>` aus der HD-Liste, keine freie Adresse.
 */
export function bauProvider(yamlProv: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv, warnungen: string[], opt: ProviderOptionen = {}): ProviderConfig {
  const p = yamlProv ?? {};
  const modus = opt.modus ?? 'selbst';
  const fehlt = (art: string, was: string) => {
    warnungen.push(`KI-Anbieter "${art}": ${was} fehlt, nutze "mock".`);
    return { art: 'mock' } as const;
  };
  const keyEnv = str(p.apiKeyEnv);
  if (keyEnv && !ERLAUBTE_KEY_ENV.test(keyEnv)) {
    warnungen.push(`provider.apiKeyEnv "${keyEnv}" ist nicht erlaubt (nur KERN_PROVIDER_KEY oder KERN_PROVIDER_KEY_<NAME>) und wird ignoriert.`);
  }
  const erlaubterKeyEnv = keyEnv && ERLAUBTE_KEY_ENV.test(keyEnv) ? keyEnv : undefined;

  // Betreiber legt den Anbieter per Umgebung fest: gilt in beiden Modi.
  const envArt = str(env.KERN_PROVIDER);

  if (modus === 'managed' && !envArt) {
    const art = str(p.art) ?? 'mock';
    if (art === 'mock' && !str(p.anbieter)) return { art: 'mock' };
    if (str(p.url) || keyEnv) warnungen.push('Managed-Betrieb: freie KI-Adresse und apiKeyEnv aus kern.yaml werden ignoriert. Erlaubt ist nur ein Anbieter aus der Liste.');
    const id = str(p.anbieter);
    const e = id ? (opt.anbieter ?? []).find((x) => x.id === id) : undefined;
    if (!e) {
      warnungen.push(`Managed-Betrieb: Anbieter "${id ?? art}" steht nicht auf der Liste, nutze "mock".`);
      return { art: 'mock' };
    }
    // Schlüssel: von HD (Variable des Listeneintrags) oder vom Kunden selbst (kern.yaml). Ziel ist immer die Listenadresse.
    const apiKey = (e.apiKeyEnv ? str(env[e.apiKeyEnv]) : undefined) ?? opt.geheimnis?.(e.id) ?? str(p.apiKey);
    const chatModell = str(p.chatModell) ?? e.chatModell;
    const embedModell = str(p.embedModell) ?? e.embedModell;
    switch (e.art) {
      case 'ollama': return { art: 'ollama', url: e.url, chatModell, embedModell };
      case 'openai': return { art: 'openai', url: e.url, apiKey: apiKey ?? '', chatModell, embedModell };
      case 'anthropic':
        if (!apiKey) return fehlt(e.id, 'API-Schlüssel');
        return { art: 'anthropic', apiKey, chatModell, embed: { art: 'mock' } };
    }
  }

  const art = envArt ?? str(p.art) ?? 'mock';
  const urlEnv = str(env.KERN_PROVIDER_URL);
  const urlYaml = str(p.url);
  const url = urlEnv ?? urlYaml;
  const chatModell = str(env.KERN_CHAT_MODELL) ?? str(p.chatModell);
  const embedModell = str(env.KERN_EMBED_MODELL) ?? str(p.embedModell);
  const apiKey = str(env.KERN_PROVIDER_KEY) ?? (erlaubterKeyEnv ? str(env[erlaubterKeyEnv]) : undefined) ?? opt.geheimnis?.(str(p.anbieter) ?? 'eigen') ?? str(p.apiKey);
  if (str(p.apiKey)) warnungen.push('kern.yaml enthält einen API-Schlüssel im Klartext. Besser KERN_PROVIDER_KEY oder provider.apiKeyEnv nutzen.');
  if (!urlEnv && urlYaml && art !== 'mock') {
    warnungen.push(`KI-Endpunkt frei gewählt (kern.yaml): ${hostVon(urlYaml)}. Fragen, Quellenabschnitte${apiKey ? ' und der API-Schlüssel' : ''} gehen an diese Adresse. Nur im Selbstbetrieb erlaubt.`);
  }
  switch (art) {
    case 'mock':
      return { art: 'mock' };
    case 'ollama':
      return { art: 'ollama', url: url ?? 'http://127.0.0.1:11434', chatModell: chatModell ?? 'llama3.1', embedModell: embedModell ?? 'nomic-embed-text' };
    case 'openai':
    case 'openai-kompatibel':
      if (!url) return fehlt(art, 'url');
      if (!chatModell || !embedModell) return fehlt(art, 'chatModell/embedModell');
      return { art: 'openai', url, apiKey: apiKey ?? '', chatModell, embedModell };
    case 'anthropic': {
      if (!apiKey) return fehlt(art, 'API-Schlüssel');
      const embedRoh = p.embed && typeof p.embed === 'object' ? (p.embed as Record<string, unknown>) : { art: 'mock' };
      const embed = bauProvider(embedRoh, {}, warnungen, opt);
      return { art: 'anthropic', apiKey, chatModell: chatModell ?? 'claude-sonnet-4-5', embed };
    }
    default:
      warnungen.push(`Unbekannter KI-Anbieter "${art}", nutze "mock".`);
      return { art: 'mock' };
  }
}

export function ladeKonfiguration(opt: { dataDir?: string; port?: number; env?: NodeJS.ProcessEnv } = {}): ServerConfig {
  const env = opt.env ?? process.env;
  const warnungen: string[] = [];
  const dataDir = path.resolve(opt.dataDir ?? env.KERN_DATA ?? './kern-data');
  const y = leseKernYaml(dataDir);
  const produktion = env.NODE_ENV === 'production' || env.KERN_MODUS === 'managed' || /^(1|true|ja|yes|on)$/i.test(env.KERN_MANAGED ?? '');
  let secret = env.KERN_SECRET ?? '';
  const secretAusEnv = secret.length > 0;
  if (secretAusEnv && secret.length < 32) {
    if (produktion) throw new Error('KERN_SECRET ist zu kurz (mindestens 32 Zeichen).');
    warnungen.push('KERN_SECRET ist kürzer als 32 Zeichen.');
  }
  if (!secretAusEnv) {
    if (produktion) throw new Error('KERN_SECRET fehlt. In Produktion (NODE_ENV=production) ist er Pflicht, mindestens 32 Zeichen.');
    secret = crypto.randomBytes(32).toString('hex');
    warnungen.push('KERN_SECRET nicht gesetzt: zufälliger Schlüssel, Sitzungen enden beim Neustart.');
  }
  const zahl = (v: string | undefined, std: number) => (v && /^\d+$/.test(v) ? Number(v) : std);
  const ja = (v: string | undefined, std: boolean) => (v === undefined || v === '' ? std : /^(1|true|ja|yes|on)$/i.test(v));
  const fake = ja(env.KERN_FAKE, false);
  const sprache = y.sprache === 'en' ? 'en' : 'de';
  // v1.4: KERN_MANAGED=1; KERN_MODUS=managed bleibt als gleichwertiger Name.
  const modus: Modus = env.KERN_MODUS === 'managed' || ja(env.KERN_MANAGED, false) ? 'managed' : 'selbst';
  if (env.KERN_MODUS && !['managed', 'selbst'].includes(env.KERN_MODUS)) warnungen.push(`KERN_MODUS "${env.KERN_MODUS}" unbekannt, nutze "selbst".`);
  const anbieter = modus === 'managed' ? ladeAnbieterListe(env, warnungen) : [];
  // H3: KERN_TRUST_PROXY = Anzahl vertrauter Proxys (1 = ein Proxy wie Traefik/Coolify). "true" zählt als 1.
  const tp = env.KERN_TRUST_PROXY_HOPS ?? env.KERN_TRUST_PROXY ?? '';
  const proxyHops = /^\d+$/.test(tp) ? Math.min(Number(tp), 10) : ja(tp, false) ? 1 : 0;
  let publicUrl: string | null = null;
  if (env.KERN_PUBLIC_URL) {
    try { const u = new URL(env.KERN_PUBLIC_URL); publicUrl = `${u.protocol}//${u.host}`; } catch { warnungen.push('KERN_PUBLIC_URL ist keine gültige Adresse.'); }
  }
  // P2: sicheres Cookie und HSTS, sobald HTTPS erkennbar ist (Produktion, Proxy oder https-Adresse), nicht nur mit NODE_ENV.
  // Zusätzlich je Anfrage: https-URL oder X-Forwarded-Proto: https vom vertrauten Proxy (siehe app.ts).
  const httpsErkannt = produktion || (publicUrl?.startsWith('https://') ?? false) || modus === 'managed';
  if (env.KERN_BETRIEB_TOKEN && env.KERN_BETRIEB_TOKEN.length < 32) warnungen.push('KERN_BETRIEB_TOKEN ist kürzer als 32 Zeichen und wird ignoriert.');
  if (modus === 'managed' && !publicUrl) warnungen.push('Managed-Betrieb ohne KERN_PUBLIC_URL: Origin-Prüfung und OAuth-Metadaten leiten die Adresse aus der Anfrage ab.');
  const kb = 1024;
  const grenzen: Grenzen = {
    jsonVorLoginBytes: zahl(env.KERN_MAX_JSON_LOGIN_KB, 16) * kb,
    jsonBytes: zahl(env.KERN_MAX_JSON_KB, 1024) * kb,
    vorschlagBytes: zahl(env.KERN_MAX_VORSCHLAG_MB, 6) * kb * kb,
    mcpBytes: zahl(env.KERN_MAX_MCP_KB, 1024) * kb,
    fragenProMinute: zahl(env.KERN_LIMIT_FRAGEN_MINUTE, zahl(String((y.grenzen as { fragen_je_minute?: number } | undefined)?.fragen_je_minute ?? ''), 30)),
    fragenProMinuteInstanz: zahl(env.KERN_LIMIT_FRAGEN_MINUTE_INSTANZ, 120),
    uploadsProMinute: zahl(env.KERN_LIMIT_UPLOAD_MINUTE, 30),
    sitzungenJeNutzer: zahl(env.KERN_MAX_SITZUNGEN, 20),
    fragenProTag: zahl(env.KERN_LIMIT_FRAGEN_TAG, 500),
    kiProTagInstanz: zahl(env.KERN_LIMIT_KI_TAG, 3000),
    mcpProMinuteToken: zahl(env.KERN_LIMIT_MCP_MINUTE, 120),
    apiProMinuteNutzer: zahl(env.KERN_LIMIT_API_MINUTE, 600),
  };
  return {
    port: opt.port ?? zahl(env.PORT, 7480),
    host: env.HOST ?? '0.0.0.0',
    dataDir,
    secret,
    secretAusEnv,
    produktion,
    secureCookie: ja(env.KERN_SECURE_COOKIE, httpsErkannt),
    noindex: ja(env.KERN_NOINDEX, true),
    maxUploadBytes: zahl(env.KERN_MAX_UPLOAD_MB, 50) * 1024 * 1024,
    trustProxy: proxyHops > 0,
    proxyHops,
    publicUrl,
    modus,
    anbieter,
    grenzen,
    mcpOrigins: (env.KERN_MCP_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    logInhalte: ja(env.KERN_LOG_INHALTE, false),
    oauthIssuer: str(env.KERN_OAUTH_ISSUER) ?? null,
    betriebToken: str(env.KERN_BETRIEB_TOKEN) && env.KERN_BETRIEB_TOKEN!.length >= 32 ? env.KERN_BETRIEB_TOKEN! : null,
    leitstandUrl: str(env.KERN_LEITSTAND_URL)?.replace(/\/+$/, '') ?? null,
    kontoToken: str(env.KERN_KONTO_TOKEN) ?? null,
    geheimnisSchluessel: str(env.KERN_GEHEIMNIS_SCHLUESSEL) ?? null,
    produktName: str((y.produkt as { name?: string } | undefined)?.name) ?? str(env.KERN_PRODUKT_NAME) ?? 'Kern',
    webDist: path.resolve(env.KERN_WEB_DIST ?? path.join(hier, '..', '..', 'web', 'dist')),
    fake,
    sitzungStunden: zahl(env.KERN_SITZUNG_STUNDEN, 12),
    kern: {
      dataDir,
      betrieb: str(y.betrieb) ?? 'Mein Betrieb',
      sprache,
      provider: bauProvider((y.provider ?? y.ki) as Record<string, unknown> | undefined, env, warnungen, { modus, anbieter, geheimnis: (n) => new Geheimnisse(dataDir, str(env.KERN_GEHEIMNIS_SCHLUESSEL) ?? null).hole(n) }),
    },
    warnungen,
  };
}
