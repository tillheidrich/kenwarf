import { describe, expect, it } from 'vitest';
import type { Heute, Punkt } from '../api/types';
import { punktWoerter, schneideZu, sortiere } from './lesen';

const p = (id: string, block: Punkt['block'], farbe: Punkt['ampel']['farbe'], n = 10): Punkt => ({
  id,
  block,
  satz: Array.from({ length: n }, () => 'wort').join(' '),
  absatz: null,
  belege: [],
  ampel: { farbe, grund: '', regel: '' },
});
const heute = (punkte: Punkt[], minuten = 1, wpm = 30): Heute => ({
  datum: '2026-10-24',
  ansicht: { id: 'a', zweck: 'briefing', titel: '', generated: { by: 'x', at: '' }, gilt_bis: '2026-10-25', basis_stand: '', lesezeit_min: 0, status: 'aktuell' },
  budget: { minuten, woerter_pro_minute: wpm },
  punkte,
  ignorieren_anzahl: 0,
  zurueckgestellt: 0,
});

describe('Lesebudget', () => {
  it('ordnet unsicher, entscheiden (rot vor gelb), ändert sich', () => {
    const s = sortiere([p('a', 'aendert_sich', 'rot'), p('b', 'entscheiden', 'gelb'), p('c', 'entscheiden', 'rot'), p('d', 'unsicher', 'gruen')]);
    expect(s.map((x) => x.id)).toEqual(['d', 'c', 'b', 'a']);
  });
  it('hält die harte Grenze ein und legt ganze Punkte zurück, ohne zu kürzen', () => {
    const z = schneideZu(heute([p('a', 'unsicher', 'rot', 12), p('b', 'entscheiden', 'rot', 12), p('c', 'aendert_sich', 'gelb', 12)], 1, 30));
    expect(z.zeigen.map((x) => x.id)).toEqual(['a', 'b']);
    expect(z.zurueck).toBe(1);
    expect(z.woerter).toBeLessThanOrEqual(z.grenzeWoerter);
    expect(z.zeigen.every((x) => punktWoerter(x) === 12)).toBe(true);
  });
  it('weiche Grenze zeigt alles und nennt den ersten Punkt über dem Budget', async () => {
    const { ersterUeberBudget } = await import('./lesen');
    const h = heute([p('a', 'unsicher', 'rot', 12), p('b', 'entscheiden', 'rot', 12), p('c', 'aendert_sich', 'gelb', 12)], 1, 30);
    const z = schneideZu(h, false);
    expect(z.zeigen).toHaveLength(3);
    expect(z.zurueck).toBe(0);
    expect(ersterUeberBudget(z.zeigen, h)).toBe(2);
  });
  it('zählt „ignorieren“ nicht mit', () => {
    const z = schneideZu(heute([p('a', 'ignorieren', 'gruen', 100), p('b', 'entscheiden', 'rot', 5)], 1, 10));
    expect(z.zeigen.map((x) => x.id)).toEqual(['b']);
    expect(z.zurueck).toBe(0);
  });
});
