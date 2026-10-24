import type { ProviderConfig } from './types.js';

export interface DatenwegStrecke {
  zweck: 'antworten' | 'einbetten';
  anbieter: string;
  endpunkt: string | null;
  modell: string | null;
  ort: 'dieser Server' | 'lokales Netz' | 'extern';
  /** Region nur, wenn sie sich sicher aus dem Endpunkt ablesen lässt; sonst null. */
  region: string | null;
}

export interface Datenweg {
  anbieter: string;
  strecken: DatenwegStrecke[];
  daten: string[];
  verlaesstServer: boolean;
  hinweis: string;
}

const BEKANNTE_REGIONEN: [RegExp, string][] = [
  [/(^|\.)mistral\.ai$/i, 'EU (Frankreich, laut Anbieter)'],
  [/(^|\.)ionos\.(com|de)$/i, 'EU (Deutschland, laut Anbieter)'],
  [/(^|\.)stackit\.(cloud|de)$/i, 'EU (Deutschland, laut Anbieter)'],
  [/(^|\.)anthropic\.com$/i, 'USA (laut Anbieter)'],
  [/(^|\.)openai\.com$/i, 'USA (laut Anbieter)'],
];

function ortVon(url: string | null): { ort: DatenwegStrecke['ort']; region: string | null } {
  if (!url) return { ort: 'dieser Server', region: null };
  let host = '';
  try { host = new URL(url).hostname; } catch { return { ort: 'extern', region: null }; }
  if (/^(localhost|127\.|::1$|\[::1\])/.test(host)) return { ort: 'dieser Server', region: null };
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    return { ort: 'lokales Netz', region: null };
  }
  const r = BEKANNTE_REGIONEN.find(([m]) => m.test(host));
  return { ort: 'extern', region: r ? r[1] : null };
}

function strecke(zweck: DatenwegStrecke['zweck'], p: ProviderConfig): DatenwegStrecke {
  switch (p.art) {
    case 'mock':
      return { zweck, anbieter: 'mock (keine KI)', endpunkt: null, modell: null, ort: 'dieser Server', region: null };
    case 'ollama':
      return { zweck, anbieter: 'ollama', endpunkt: p.url, modell: zweck === 'antworten' ? p.chatModell : p.embedModell, ...ortVon(p.url) };
    case 'openai':
      return { zweck, anbieter: 'openai-kompatibel', endpunkt: p.url, modell: zweck === 'antworten' ? p.chatModell : p.embedModell, ...ortVon(p.url) };
    case 'anthropic':
      if (zweck === 'einbetten') return strecke('einbetten', p.embed);
      return { zweck, anbieter: 'anthropic', endpunkt: 'https://api.anthropic.com', modell: p.chatModell, ...ortVon('https://api.anthropic.com') };
  }
}

/**
 * v1.2 (F13): Welche Daten gehen an welchen KI-Anbieter. Wird genutzt, wenn core keine
 * eigene `datenweg()`-Funktion hat. Nur Konfiguration, kein Netzwerkzugriff.
 */
export function bauDatenweg(p: ProviderConfig): Datenweg {
  const strecken = [strecke('antworten', p), strecke('einbetten', p)];
  const extern = strecken.some((s) => s.ort === 'extern');
  return {
    anbieter: p.art,
    strecken,
    daten: p.art === 'mock'
      ? []
      : [
          'Bei „Fragen“: die Frage und die gefundenen Abschnitte, die der fragende Benutzer sehen darf.',
          'Beim Hinzufügen und Kompilieren: der Text der neuen Quelle und betroffene Artikel.',
          'Beim Indizieren (nur mit Einbettungsmodell): alle Abschnitte aus wissen/ und quellen/.',
          'Briefing und Prüflauf: Kurzfassungen und Befunde.',
        ],
    verlaesstServer: extern,
    hinweis: p.art === 'mock'
      ? 'Keine KI angebunden. Es verlassen keine Daten den Server.'
      : extern
        ? 'Daten gehen an einen externen Anbieter. Region und Vertrag (AVV) beim Anbieter prüfen.'
        : 'Die KI läuft auf diesem Server oder im lokalen Netz.',
  };
}
