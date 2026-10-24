import type { Einstellungen, KiModell } from '../api/types';

// Art. 50 KI-VO (gilt auch für freie Software) und CONTRACT v1.4 D-L13:
// Jede KI-Ausgabe nennt das Wort KI und, soweit bekannt, das Modell.
// Quelle der Wahrheit sind `ki_erzeugt` und `modell` an Antwort und Ansicht; die Einstellungen sind nur Rückfall für ältere Server.

export interface KiHerkunft {
  ki_erzeugt?: boolean;
  modell?: KiModell | null;
}

const ART_TEXT: Record<string, string> = { ollama: 'lokales Modell', openai: 'Sprachmodell', anthropic: 'Claude' };

export function istKi(h: KiHerkunft | undefined, provider?: Einstellungen['provider']): boolean {
  if (typeof h?.ki_erzeugt === 'boolean') return h.ki_erzeugt;
  return !!provider && provider.art !== 'mock';
}

export function modellText(h: KiHerkunft | undefined, provider?: Einstellungen['provider']): string {
  if (h?.modell) return h.modell.anbieter && h.modell.anbieter !== h.modell.name ? `${h.modell.name}, ${h.modell.anbieter}` : h.modell.name;
  return provider?.chatModell || ART_TEXT[provider?.art ?? ''] || 'Sprachmodell';
}

/** z. B. „Diese Antwort hat eine KI aus euren Dokumenten erzeugt (Modell: mistral-small-latest, mistral).“ */
export const TESTMODUS_ANTWORT = 'Testmodus ohne KI: Antwort aus Textauszügen.';

/**
 * Testmodus = Anbieter „mock“ (kein Sprachmodell). Die Felder der Antwort gehen vor: ein Modell „mock“
 * (älterer Server schickte ki_erzeugt=true dazu) ist Testmodus, ein echtes Modell nie.
 */
export function istTestmodus(h: KiHerkunft | undefined, provider?: Einstellungen['provider']): boolean {
  if (h?.modell) return h.modell.anbieter === 'mock' || h.modell.name === 'mock';
  if (typeof h?.ki_erzeugt === 'boolean') return !h.ki_erzeugt && provider?.art === 'mock';
  return provider?.art === 'mock';
}

export function kiHinweis(h: KiHerkunft | undefined, provider: Einstellungen['provider'] | undefined, was: 'Antwort' | 'Zusammenfassung' = 'Antwort'): string {
  // Testmodus ist nie KI, auch wenn ein älterer Server ki_erzeugt=true mit Modell „mock“ schickt
  if (istTestmodus(h, provider) && was === 'Antwort') return TESTMODUS_ANTWORT;
  if (istTestmodus(h, provider) || !istKi(h, provider)) return was === 'Antwort' ? 'Ohne KI: wörtliche Auszüge aus euren Dokumenten mit Fundstelle.' : 'Ohne KI zusammengestellt aus euren Dokumenten.';
  return `Diese ${was} hat eine KI aus euren Dokumenten erzeugt (Modell: ${modellText(h, provider)}).`;
}
