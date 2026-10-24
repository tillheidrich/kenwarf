import type { OutlineBuendel, OutlineDokument, OutlineKnoten } from './typen.js';

/**
 * Ergänzt Eltern und Brotkrumen aus den Dokumentbäumen der Sammlungen und sortiert so,
 * dass Eltern vor ihren Kindern stehen (Baumreihenfolge, danach Dokumente ohne Baumplatz).
 */
export function ordneNachBaum(b: OutlineBuendel): OutlineBuendel {
  const reihenfolge = new Map<string, number>();
  const eltern = new Map<string, string | null>();
  const krume = new Map<string, string>();
  let n = 0;
  for (const s of b.sammlungen) {
    const lauf = (knoten: OutlineKnoten[], vater: string | null, weg: string[]) => {
      for (const k of knoten) {
        reihenfolge.set(k.id, n++);
        eltern.set(k.id, vater);
        krume.set(k.id, weg.join(' › '));
        lauf(k.children ?? [], k.id, [...weg, k.title]);
      }
    };
    lauf(s.baum, null, [s.name]);
  }
  // elternId verweist immer auf den Schlüssel des Elterndokuments (nicht auf die Outline-UUID)
  const idZuSchluessel = new Map(b.dokumente.filter((d) => d.id).map((d) => [d.id!, d.schluessel]));
  const schluessel = new Set(b.dokumente.map((d) => d.schluessel));
  const alsSchluessel = (e: string | null | undefined): string | null => (!e ? null : schluessel.has(e) ? e : (idZuSchluessel.get(e) ?? null));
  const dokumente: OutlineDokument[] = b.dokumente.map((d) => {
    if (!d.id) return d;
    return {
      ...d,
      elternId: alsSchluessel(d.elternId) ?? alsSchluessel(eltern.get(d.id)),
      breadcrumb: d.breadcrumb ?? krume.get(d.id) ?? null,
    };
  });
  dokumente.sort((x, y) => (reihenfolge.get(x.id ?? '') ?? 1e9) - (reihenfolge.get(y.id ?? '') ?? 1e9) || x.schluessel.localeCompare(y.schluessel));
  return { ...b, dokumente };
}

/** Tiefe der Hierarchie (1 = nur oberste Ebene). */
export function baumTiefe(knoten: OutlineKnoten[]): number {
  let max = 0;
  for (const k of knoten) max = Math.max(max, 1 + baumTiefe(k.children ?? []));
  return max;
}

export function zaehleKnoten(knoten: OutlineKnoten[]): number {
  return knoten.reduce((s, k) => s + 1 + zaehleKnoten(k.children ?? []), 0);
}
