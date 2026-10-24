import { describe, expect, it } from 'vitest';
import { artikelHtml } from './artikel';

describe('Fußnoten-Fundstellen', () => {
  const fs = [{ id: 'q1', quelle: 'quellen/2026/a.md', abschnitt: 'Annehmen', zeilen: [3, 7] as [number, number] }];
  it('macht aus [^id] einen Link zur Fundstelle und entfernt die Definition', () => {
    const h = artikelHtml('Am Telefon nichts sagen.[^q1]\n\n[^q1]: quellen/2026/a.md', 'wissen/x/a.md', fs);
    expect(h).toContain('class="fussnote"');
    expect(h).toContain('#/fundstelle?pfad=quellen%2F2026%2Fa.md&amp;von=3&amp;bis=7');
    expect(h).not.toContain('[^q1]');
    expect(h).not.toContain('quellen/2026/a.md</p>');
  });
  it('trennt direkt aufeinanderfolgende Fußnoten', () => {
    const zwei = [...fs, { id: 'q_2', quelle: 'quellen/b.md', abschnitt: 'B', zeilen: [1, 2] as [number, number] }];
    const h = artikelHtml('Satz.[^q1][^q_2]', 'wissen/a.md', zwei);
    expect(h.match(/class="fussnote"/g)?.length).toBe(2);
    expect(h).not.toContain('fussnote--lose');
  });
  it('markiert unbekannte Fußnoten', () => {
    expect(artikelHtml('Text[^x9]', 'wissen/a.md', fs)).toContain('fussnote--lose');
  });
});
