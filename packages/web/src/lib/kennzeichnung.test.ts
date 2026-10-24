import { describe, expect, it } from 'vitest';
import { kiHinweis } from './kennzeichnung';

describe('KI-Kennzeichnung (Art. 50 KI-VO, v1.4 D-L13)', () => {
  it('nennt KI und Modell aus der Antwort', () => {
    expect(kiHinweis({ ki_erzeugt: true, modell: { anbieter: 'mistral', name: 'mistral-small-latest' } }, { art: 'mock' })).toBe(
      'Diese Antwort hat eine KI aus euren Dokumenten erzeugt (Modell: mistral-small-latest, mistral).',
    );
  });
  it('ki_erzeugt false sagt ehrlich „ohne KI“, auch wenn ein Anbieter eingestellt ist', () => {
    expect(kiHinweis({ ki_erzeugt: false, modell: null }, { art: 'openai', chatModell: 'x' })).toMatch(/^Ohne KI/);
  });
  it('Rückfall auf Einstellungen bei älterem Server, Text enthält immer „KI“', () => {
    const t = kiHinweis(undefined, { art: 'ollama', chatModell: null });
    expect(t).toContain('KI');
    expect(t).toContain('lokales Modell');
  });
  it('Zusammenfassungen werden ebenso gekennzeichnet', () => {
    expect(kiHinweis({ ki_erzeugt: true, modell: { anbieter: 'ionos', name: 'llama' } }, undefined, 'Zusammenfassung')).toMatch(/^Diese Zusammenfassung hat eine KI/);
  });
});
