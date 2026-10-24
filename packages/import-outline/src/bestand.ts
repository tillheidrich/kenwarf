import { baumTiefe, zaehleKnoten } from './baum.js';
import { sammleAnhangVerweise } from './links.js';
import type { OutlineBuendel } from './typen.js';

export interface Bestand {
  sammlungen: { name: string; permission: string; dokumenteImBaum: number; dokumenteGeladen: number; tiefe: number }[];
  dokumente: number;
  zeichen: number;
  tabellen: number;
  bilder: number;
  dateilinks: number;
  interneLinks: number;
  externeLinks: number;
  erwaehnungen: number;
  codebloecke: number;
  hinweisbloecke: number;
  kommentare: number;
}

/** Zählt, was ein Bündel enthält (für die Bestandsaufnahme vor dem Umzug). */
export function bestandsaufnahme(b: OutlineBuendel): Bestand {
  const host = b.basisUrl ? new URL(b.basisUrl).hostname : null;
  const out: Bestand = { sammlungen: [], dokumente: b.dokumente.length, zeichen: 0, tabellen: 0, bilder: 0, dateilinks: 0, interneLinks: 0, externeLinks: 0, erwaehnungen: 0, codebloecke: 0, hinweisbloecke: 0, kommentare: b.kommentare.length };
  for (const s of b.sammlungen) {
    out.sammlungen.push({ name: s.name, permission: s.permission ?? 'privat', dokumenteImBaum: zaehleKnoten(s.baum), dokumenteGeladen: b.dokumente.filter((d) => d.sammlungId === s.id).length, tiefe: baumTiefe(s.baum) });
  }
  for (const d of b.dokumente) {
    const t = d.markdown;
    out.zeichen += t.length;
    out.tabellen += (t.match(/^\|.*\|\s*\n\|[-:| ]+\|\s*$/gm) ?? []).length;
    out.codebloecke += Math.floor((t.match(/^```/gm) ?? []).length / 2);
    out.hinweisbloecke += (t.match(/^:::\w+/gm) ?? []).length;
    out.erwaehnungen += (t.match(/@\[[^\]]*\]\(mention:/g) ?? []).length;
    const anh = sammleAnhangVerweise(t);
    out.bilder += anh.filter((a) => a.bild).length;
    out.dateilinks += anh.filter((a) => !a.bild).length;
    for (const m of t.matchAll(/\]\((https?:\/\/[^)\s]+|\/doc\/[^)\s]+)/g)) {
      const z = m[1]!;
      if (z.includes('attachments.redirect')) continue;
      if (z.startsWith('/doc/') || (host && new URL(z).hostname === host && z.includes('/doc/'))) out.interneLinks++;
      else out.externeLinks++;
    }
  }
  return out;
}
