import type { Heute, LeseAmpel, Punkt, PunktBlock } from '../api/types';

// Lese-Engpass (Contract v1.3): harte Lesegrenze, feste Reihenfolge, Ampel „Muss ich das lesen?“.

export function woerter(s: string | null | undefined): number {
  return (s ?? '').match(/[^\s]+/g)?.length ?? 0;
}

/** Wörter eines Punkts in Stufe 1 und 2 (Zitat und Rohtext zählen nicht, die öffnet man bewusst). */
export function punktWoerter(p: Punkt): number {
  return woerter(p.satz) + woerter(p.absatz);
}

const BLOCK_REIHE: PunktBlock[] = ['unsicher', 'entscheiden', 'aendert_sich', 'ignorieren'];
const FARBE_REIHE = { rot: 0, gelb: 1, gruen: 2 } as const;

export function sortiere(punkte: Punkt[]): Punkt[] {
  return punkte
    .map((p, i) => ({ p, i }))
    .sort((a, b) => BLOCK_REIHE.indexOf(a.p.block) - BLOCK_REIHE.indexOf(b.p.block) || FARBE_REIHE[a.p.ampel.farbe] - FARBE_REIHE[b.p.ampel.farbe] || a.i - b.i)
    .map((x) => x.p);
}

export interface Zuschnitt {
  zeigen: Punkt[];
  zurueck: number;
  woerter: number;
  minuten: number;
  grenzeWoerter: number;
}

/**
 * Harte Grenze auch im Browser: Liefert der Server mehr als das Budget, wird nicht gekürzt,
 * sondern ganze Punkte werden auf morgen gelegt. „Ignorieren“ zählt nie zum Budget.
 */
export function schneideZu(h: Heute, hart = true): Zuschnitt {
  const grenze = Math.max(0, Math.round(h.budget.minuten * h.budget.woerter_pro_minute));
  const zeigen: Punkt[] = [];
  let summe = 0;
  let zurueck = h.zurueckgestellt ?? 0;
  for (const p of sortiere(h.punkte.filter((x) => x.block !== 'ignorieren'))) {
    const w = punktWoerter(p);
    if (!hart || summe + w <= grenze) {
      zeigen.push(p);
      summe += w;
    } else zurueck++;
  }
  return { zeigen, zurueck, woerter: summe, minuten: summe / Math.max(1, h.budget.woerter_pro_minute), grenzeWoerter: grenze };
}

/** Bei weicher Grenze: Index des ersten Punkts, der über dem Budget liegt (oder -1). */
export function ersterUeberBudget(punkte: Punkt[], h: Heute): number {
  const grenze = h.budget.minuten * h.budget.woerter_pro_minute;
  let summe = 0;
  for (let i = 0; i < punkte.length; i++) {
    summe += punktWoerter(punkte[i]);
    if (summe > grenze) return i;
  }
  return -1;
}

export function minutenText(m: number): string {
  if (m < 1) return 'unter 1 Minute';
  const r = Math.round(m);
  return `${r} ${r === 1 ? 'Minute' : 'Minuten'}`;
}

export const AMPEL_WORT: Record<LeseAmpel['farbe'], string> = {
  rot: 'Ja, heute lesen',
  gelb: 'Wenn Zeit ist',
  gruen: 'Nein',
};

export const BLOCK_TITEL: Record<PunktBlock, string> = {
  unsicher: 'Unsicher oder fehlgeschlagen',
  entscheiden: 'Zu entscheiden',
  aendert_sich: 'Was sich für dich ändert',
  ignorieren: 'Darfst du ignorieren',
};
