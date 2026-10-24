import fs from 'node:fs';
import YAML from 'yaml';

/**
 * H2: KI-Anbieter im Managed-Betrieb nur aus einer Liste von Heidrich Digital.
 * Kunden wählen einen Eintrag (`anbieter: <id>`), nie eine freie Adresse. Ein von HD gestellter
 * Schlüssel geht nur an die Adresse seines Listeneintrags.
 */
export interface Anbieter {
  id: string;
  name: string;
  art: 'openai' | 'ollama' | 'anthropic';
  url: string;
  chatModell: string;
  embedModell: string;
  /** Umgebungsvariable mit dem Schlüssel; muss zur Erlaubnisliste passen. */
  apiKeyEnv?: string;
  region?: string;
}

/** Erlaubte Namen für Schlüssel-Variablen. Alles andere (KERN_SECRET, DATABASE_URL …) wird nie gelesen. */
export const ERLAUBTE_KEY_ENV = /^KERN_PROVIDER_KEY(_[A-Z0-9]{1,32})?$/;

/**
 * Standardliste, solange HD keine eigene Datei setzt (KERN_ANBIETER_DATEI).
 * Adressen laut Anbieter-Doku; Modellnamen sind Vorgaben [Annahme, vor Betrieb prüfen].
 */
export const STANDARD_ANBIETER: Anbieter[] = [
  { id: 'mistral', name: 'Mistral AI (EU)', art: 'openai', url: 'https://api.mistral.ai/v1', chatModell: 'mistral-small-latest', embedModell: 'mistral-embed', apiKeyEnv: 'KERN_PROVIDER_KEY_MISTRAL', region: 'EU' },
  { id: 'ionos', name: 'IONOS AI Model Hub (DE)', art: 'openai', url: 'https://openai.inference.de-txl.ionos.com/v1', chatModell: 'meta-llama/Llama-3.3-70B-Instruct', embedModell: 'BAAI/bge-m3', apiKeyEnv: 'KERN_PROVIDER_KEY_IONOS', region: 'DE' },
];

function pruefeEintrag(roh: unknown, warnungen: string[]): Anbieter | null {
  const e = roh as Partial<Anbieter>;
  const ok = e && typeof e.id === 'string' && /^[a-z0-9_-]{1,40}$/.test(e.id) && typeof e.url === 'string' && /^https?:\/\//.test(e.url)
    && (e.art === 'openai' || e.art === 'ollama' || e.art === 'anthropic') && typeof e.chatModell === 'string' && typeof e.embedModell === 'string';
  if (!ok) { warnungen.push('Anbieterliste: ungültiger Eintrag übersprungen.'); return null; }
  if (e.apiKeyEnv && !ERLAUBTE_KEY_ENV.test(e.apiKeyEnv)) { warnungen.push(`Anbieterliste: apiKeyEnv von "${e.id}" nicht erlaubt (nur KERN_PROVIDER_KEY…).`); return null; }
  return { id: e.id!, name: typeof e.name === 'string' ? e.name : e.id!, art: e.art!, url: e.url!, chatModell: e.chatModell!, embedModell: e.embedModell!, apiKeyEnv: e.apiKeyEnv, region: e.region };
}

/** Liest die Liste aus KERN_ANBIETER_DATEI (YAML oder JSON, Liste von Einträgen), sonst Standard. */
export function ladeAnbieterListe(env: NodeJS.ProcessEnv, warnungen: string[]): Anbieter[] {
  const datei = env.KERN_ANBIETER_DATEI;
  if (!datei) return STANDARD_ANBIETER;
  try {
    const roh: unknown = YAML.parse(fs.readFileSync(datei, 'utf8'));
    const liste = Array.isArray(roh) ? roh : Array.isArray((roh as { anbieter?: unknown })?.anbieter) ? (roh as { anbieter: unknown[] }).anbieter : [];
    return liste.map((x) => pruefeEintrag(x, warnungen)).filter((x): x is Anbieter => !!x);
  } catch (e) {
    warnungen.push(`Anbieterliste ${datei} nicht lesbar (${(e as Error).message}); keine Anbieter erlaubt.`);
    return [];
  }
}
