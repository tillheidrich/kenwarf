import { describe, expect, it } from 'vitest';
import { klappeEin, wortDiff, zaehle } from './diff';

const zusammen = (st: ReturnType<typeof wortDiff>, seite: 'alt' | 'neu') =>
  st.filter((s) => s.art === 'gleich' || s.art === (seite === 'alt' ? 'entfernt' : 'neu')).map((s) => s.text).join('');

describe('wortDiff', () => {
  it('erkennt ein ersetztes Wort', () => {
    const st = wortDiff('Für Beschläge rechnen wir mit zwei bis drei Wochen.', 'Für Beschläge rechnen wir mit vier Wochen.');
    expect(st.filter((s) => s.art === 'entfernt').map((s) => s.text.trim())).toEqual(['zwei bis drei']);
    expect(st.filter((s) => s.art === 'neu').map((s) => s.text.trim())).toEqual(['vier']);
  });
  it('setzt alt und neu verlustfrei wieder zusammen', () => {
    const alt = 'Zeile eins\nZeile zwei mit Text\n\n- Punkt A\n- Punkt B\n';
    const neu = 'Zeile eins\nZeile zwei mit mehr Text\n\n- Punkt A\n- Punkt C\n- Punkt B\n';
    const st = wortDiff(alt, neu);
    expect(zusammen(st, 'alt')).toBe(alt);
    expect(zusammen(st, 'neu')).toBe(neu);
  });
  it('behandelt neu und Löschung', () => {
    expect(wortDiff('', 'ganz neu')).toEqual([{ art: 'neu', text: 'ganz neu' }]);
    expect(wortDiff('weg damit', '')).toEqual([{ art: 'entfernt', text: 'weg damit' }]);
    expect(wortDiff('gleich', 'gleich')).toEqual([{ art: 'gleich', text: 'gleich' }]);
  });
  it('zählt Wörter', () => {
    expect(zaehle(wortDiff('a b c', 'a x y c'))).toEqual({ entfernt: 1, neu: 2 });
  });
  it('klappt lange unveränderte Strecken ein, ohne Text zu verlieren', () => {
    const lang = Array.from({ length: 30 }, (_, i) => `Zeile ${i}`).join('\n');
    const st = wortDiff(lang + '\nalt', lang + '\nneu');
    const b = klappeEin(st, 2);
    expect(b.some((x) => x.art === 'ausgelassen')).toBe(true);
    const text = b.map((x) => (x.art === 'ausgelassen' ? x.text : x.stuecke.filter((s) => s.art !== 'neu').map((s) => s.text).join(''))).join('');
    expect(text).toBe(lang + '\nalt');
  });
});
