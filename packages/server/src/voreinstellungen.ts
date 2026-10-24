import type { Anbieter } from './anbieter.js';

/**
 * v1.4 5.1: Voreinstellungen für KI-Anbieter. Adressen nach O1 4.1 bzw. Anbieter-Doku.
 * `quelle_geprueft` ist nur gesetzt, wo die Adresse in diesem Lauf gegen die Doku geprüft wurde; sonst null
 * (vor Betrieb prüfen, CONTRACT 5.1: Mistral und OVHcloud ausdrücklich).
 * `preis_cent_je_mio` fehlt bewusst: keine Zahl ohne Quelle. core rechnet ohne Preis mit 0 und meldet das.
 */
export type Region = 'lokal' | 'eu' | 'usa' | 'unbekannt';
export interface KiVoreinstellung {
  id: 'hd_test' | 'mistral' | 'ionos' | 'stackit' | 'scaleway' | 'ovhcloud' | 'ollama' | 'llamacpp' | 'vllm' | 'anthropic' | 'openai' | 'google';
  name: string;
  art: 'openai' | 'ollama' | 'anthropic';
  url: string;
  chatModelle: string[];
  embedModelle: string[];
  region: Region;
  preis_cent_je_mio?: { ein: number; aus: number };
  quelle_geprueft: string | null;
  managed_erlaubt: boolean;
  /** Ehrlicher Hinweis zum Datenfluss (F12, Drittland); kein Warndialog, die Entscheidung trifft der Kunde. */
  datenfluss: string;
}

type Basis = Omit<KiVoreinstellung, 'managed_erlaubt' | 'datenfluss'>;

export const VOREINSTELLUNGEN: Basis[] = [
  { id: 'mistral', name: 'Mistral AI (EU)', art: 'openai', url: 'https://api.mistral.ai/v1', chatModelle: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest'], embedModelle: ['mistral-embed'], region: 'eu', quelle_geprueft: null },
  { id: 'ionos', name: 'IONOS AI Model Hub (DE)', art: 'openai', url: 'https://openai.inference.de-txl.ionos.com/v1', chatModelle: ['meta-llama/Llama-3.3-70B-Instruct'], embedModelle: ['BAAI/bge-m3'], region: 'eu', quelle_geprueft: null },
  { id: 'stackit', name: 'STACKIT AI Model Serving (DE)', art: 'openai', url: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', chatModelle: [], embedModelle: [], region: 'eu', quelle_geprueft: null },
  { id: 'scaleway', name: 'Scaleway Generative APIs (FR)', art: 'openai', url: 'https://api.scaleway.ai/v1', chatModelle: [], embedModelle: ['bge-multilingual-gemma2'], region: 'eu', quelle_geprueft: null },
  { id: 'ovhcloud', name: 'OVHcloud AI Endpoints (FR)', art: 'openai', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', chatModelle: [], embedModelle: ['bge-m3'], region: 'eu', quelle_geprueft: null },
  { id: 'ollama', name: 'Ollama (lokal)', art: 'ollama', url: 'http://127.0.0.1:11434', chatModelle: ['llama3.1', 'mistral-nemo'], embedModelle: ['nomic-embed-text', 'bge-m3'], region: 'lokal', quelle_geprueft: null },
  { id: 'llamacpp', name: 'llama.cpp-Server (lokal)', art: 'openai', url: 'http://127.0.0.1:8080/v1', chatModelle: [], embedModelle: [], region: 'lokal', quelle_geprueft: null },
  { id: 'vllm', name: 'vLLM (eigener Server)', art: 'openai', url: 'http://127.0.0.1:8000/v1', chatModelle: [], embedModelle: [], region: 'lokal', quelle_geprueft: null },
  // Till 07:12: gleichwertig unterstützt, nativ und per MCP; nur der Datenfluss wird ehrlich benannt.
  { id: 'anthropic', name: 'Anthropic Claude', art: 'anthropic', url: 'https://api.anthropic.com', chatModelle: ['claude-sonnet-4-5', 'claude-opus-4-1'], embedModelle: [], region: 'usa', quelle_geprueft: null },
  { id: 'openai', name: 'OpenAI (ChatGPT, Codex)', art: 'openai', url: 'https://api.openai.com/v1', chatModelle: ['gpt-4.1-mini', 'gpt-4.1'], embedModelle: ['text-embedding-3-small'], region: 'usa', quelle_geprueft: null },
  { id: 'google', name: 'Google Gemini', art: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', chatModelle: ['gemini-2.5-flash', 'gemini-2.5-pro'], embedModelle: ['gemini-embedding-001'], region: 'usa', quelle_geprueft: null },
];

/**
 * Liste für die Instanz. Selbstbetrieb: alle außer `hd_test`. Managed (H2, 5.1): nur Einträge, die auch in der
 * Anbieterliste von HD stehen (`managed_erlaubt`), keine lokale KI; `hd_test` nur mit [S-1] und nie für
 * Berufsgeheimnisträger. Die Adresse kommt im Managed-Betrieb immer aus der HD-Liste.
 */
export function voreinstellungenFuer(o: { managed: boolean; anbieter: Anbieter[]; testKi: boolean; berufsgeheimnis: boolean }): KiVoreinstellung[] {
  const liste: KiVoreinstellung[] = [];
  if (o.managed) {
    const hd = o.anbieter.find((a) => a.id === 'hd_test');
    if (hd && o.testKi && !o.berufsgeheimnis) {
      const r = regionAus(hd.region);
      liste.push({ id: 'hd_test', name: hd.name || 'Test-KI von Heidrich Digital', art: hd.art, url: hd.url, chatModelle: [hd.chatModell], embedModelle: [hd.embedModell], region: r, quelle_geprueft: null, managed_erlaubt: true,
        datenfluss: `${datenflussText(hd.name || 'die Test-KI', r)} Heidrich Digital stellt diesen Zugang als Unterauftragsverarbeiter.` });
    }
    for (const a of o.anbieter) {
      if (a.id === 'hd_test') continue;
      const v = VOREINSTELLUNGEN.find((x) => x.id === a.id);
      const region = v?.region ?? regionAus(a.region);
      if (region === 'lokal') continue;
      liste.push({ ...(v ?? { id: a.id as KiVoreinstellung['id'], name: a.name, chatModelle: [], embedModelle: [], quelle_geprueft: null }), art: a.art, url: a.url, region,
        chatModelle: uniq([a.chatModell, ...(v?.chatModelle ?? [])]), embedModelle: uniq([a.embedModell, ...(v?.embedModelle ?? [])].filter((m) => m !== 'mock')), managed_erlaubt: true,
        datenfluss: datenflussText(v?.name ?? a.name, region) } as KiVoreinstellung);
    }
    return liste;
  }
  return VOREINSTELLUNGEN.map((v) => ({ ...v, managed_erlaubt: false, datenfluss: datenflussText(v.name, v.region) }));
}

/** Sachlicher Datenfluss-Satz je Region (F12, Drittlandübermittlung, § 203 StGB für Berufsgeheimnisträger). */
export function datenflussText(name: string, region: Region): string {
  switch (region) {
    case 'lokal': return `Fragen und gefundene Abschnitte bleiben bei ${name} auf eurem eigenen Rechner oder Server.`;
    case 'eu': return `Fragen und gefundene Abschnitte gehen an ${name} (Verarbeitung in der EU laut Anbieter).`;
    case 'usa': return `Fragen und gefundene Abschnitte gehen an ${name} in den USA (Übermittlung in ein Drittland, Grundlage laut Anbieter, z. B. EU-US Data Privacy Framework oder Standardvertragsklauseln). Berufsgeheimnisträger prüfen § 203 StGB.`;
    default: return `Fragen und gefundene Abschnitte gehen an ${name}; der Ort der Verarbeitung ist nicht bekannt.`;
  }
}

function uniq(a: string[]): string[] { return [...new Set(a.filter(Boolean))]; }
export function regionAus(r: string | undefined): Region {
  if (!r) return 'unbekannt';
  const x = r.toLowerCase();
  if (['eu', 'de', 'fr', 'nl', 'at', 'it', 'es', 'se', 'fi', 'pl'].includes(x)) return 'eu';
  if (['usa', 'us'].includes(x)) return 'usa';
  if (x === 'lokal') return 'lokal';
  return 'unbekannt';
}
