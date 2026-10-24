import { describe, expect, it } from 'vitest';
import { FolgenErkenner } from './tasten';
import { filtere, punkte } from './finden';
import { findeBereich } from './fundstelle';
import { apiPfad, bereichVon, sichtbarkeitText } from './pfade';

describe('Tastenfolgen', () => {
  const k = [{ folge: 'g w' }, { folge: 'g e' }, { folge: '/' }, { folge: '?' }];
  it('erkennt Folgen und Einzeltasten', () => {
    const e = new FolgenErkenner(k);
    expect(e.taste('g', 0)).toBeNull();
    expect(e.taste('w', 100)).toBe('g w');
    expect(e.taste('/', 200)).toBe('/');
  });
  it('vergisst Folgen nach Ablauf der Zeit', () => {
    const e = new FolgenErkenner(k, 1000);
    e.taste('g', 0);
    expect(e.taste('w', 5000)).toBeNull();
  });
  it('fängt nach einer falschen Taste neu an', () => {
    const e = new FolgenErkenner(k);
    e.taste('g', 0);
    expect(e.taste('x', 10)).toBeNull();
    expect(e.taste('g', 20)).toBeNull();
    expect(e.taste('e', 30)).toBe('g e');
  });
});

describe('Finden', () => {
  it('behandelt Umlaute gleich', () => {
    expect(punkte('Prüftermin', 'pruef')).toBeGreaterThan(0);
    expect(filtere(['Reklamation', 'Angebot schreiben', 'Abnahme'], 'angeb', (x) => x)).toEqual(['Angebot schreiben']);
  });
});

describe('Fundstelle', () => {
  const text = 'Kopf\n\n## Annehmen\n\nAm Telefon nichts zu Ursache,\nSchuld oder Kosten sagen.\n\nEnde';
  it('findet das Zitat über Zeilen hinweg', () => {
    expect(findeBereich(text, 'Am Telefon nichts zu Ursache, Schuld oder Kosten sagen.', [1, 1])).toEqual({ von: 5, bis: 6, quelle: 'zitat' });
  });
  it('fällt auf den Zeilenbereich zurück', () => {
    expect(findeBereich(text, 'steht so nirgends im Text drin', [3, 4])).toEqual({ von: 3, bis: 4, quelle: 'zeilen' });
  });
});

describe('Pfade', () => {
  it('baut REST-Pfade ohne Bereichspräfix', () => {
    expect(apiPfad('wissen/ablaeufe/18 reklamation.md', 'wissen')).toBe('ablaeufe/18%20reklamation.md');
    expect(bereichVon('quellen/2026/x.md')).toBe('quellen');
    expect(sichtbarkeitText('team:buero')).toBe('Team Büro');
  });
});
