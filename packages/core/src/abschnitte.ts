/**
 * Abschnittsbildung: an Überschriften trennen, lange Abschnitte an Absätzen
 * auf ~1.200 Zeichen teilen, kleiner Überlapp (letzter kurzer Absatz).
 * Zeilen sind 1-basiert und beziehen sich auf die ganze Datei (inkl. YAML-Kopf).
 */
export interface Abschnitt {
  abschnitt: string;
  von: number;
  bis: number;
  text: string;
}

export interface AbschnittOptionen {
  maxZeichen?: number;
  ueberlappMax?: number;
}

interface Block {
  von: number;
  bis: number;
  zeilen: string[];
}

export function bildeAbschnitte(text: string, versatz: number, titel: string, opt: AbschnittOptionen = {}): Abschnitt[] {
  const max = opt.maxZeichen ?? 1200;
  const ueberlappMax = opt.ueberlappMax ?? 200;
  const zeilen = text.split(/\r?\n/);
  const pfadUeberschriften: string[] = [];
  const sektionen: { name: string; von: number; zeilen: { nr: number; t: string }[] }[] = [];
  let aktuell: { name: string; von: number; zeilen: { nr: number; t: string }[] } = { name: titel, von: versatz + 1, zeilen: [] };
  let imCode = false;

  zeilen.forEach((t, i) => {
    const nr = versatz + i + 1;
    if (/^\s*(```|~~~)/.test(t)) imCode = !imCode;
    const h = !imCode ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(t) : null;
    if (h) {
      if (aktuell.zeilen.some((z) => z.t.trim())) sektionen.push(aktuell);
      const ebene = h[1]!.length;
      pfadUeberschriften.length = Math.min(pfadUeberschriften.length, ebene - 1);
      while (pfadUeberschriften.length < ebene - 1) pfadUeberschriften.push('');
      pfadUeberschriften[ebene - 1] = h[2]!.replace(/[*_`]/g, '').trim();
      const name = pfadUeberschriften.filter(Boolean).join(' › ') || titel;
      aktuell = { name, von: nr, zeilen: [{ nr, t }] };
    } else {
      aktuell.zeilen.push({ nr, t });
    }
  });
  if (aktuell.zeilen.some((z) => z.t.trim())) sektionen.push(aktuell);

  const out: Abschnitt[] = [];
  for (const s of sektionen) {
    // Leere Rand-Zeilen abschneiden
    const zs = [...s.zeilen];
    while (zs.length && !zs[0]!.t.trim()) zs.shift();
    while (zs.length && !zs[zs.length - 1]!.t.trim()) zs.pop();
    if (!zs.length) continue;
    // Nur eine Überschrift ohne Inhalt: weglassen (Titel und Überschrift sind über den Kopf der Nachbarabschnitte suchbar)
    if (zs.every((z) => !z.t.trim() || /^#{1,6}\s/.test(z.t))) continue;
    const ganz = zs.map((z) => z.t).join('\n');
    if (ganz.length <= max) {
      out.push({ abschnitt: s.name, von: zs[0]!.nr, bis: zs[zs.length - 1]!.nr, text: ganz });
      continue;
    }
    // In Absätze (Blöcke) zerlegen
    const bloecke: Block[] = [];
    let b: Block | null = null;
    for (const z of zs) {
      if (!z.t.trim()) {
        if (b) bloecke.push(b);
        b = null;
        continue;
      }
      if (!b) b = { von: z.nr, bis: z.nr, zeilen: [] };
      b.zeilen.push(z.t);
      b.bis = z.nr;
    }
    if (b) bloecke.push(b);
    // Überlange Blöcke zeilenweise teilen
    const fein: Block[] = [];
    for (const bl of bloecke) {
      if (bl.zeilen.join('\n').length <= max) {
        fein.push(bl);
        continue;
      }
      let cur: Block | null = null;
      bl.zeilen.forEach((t, i) => {
        const nr = bl.von + i;
        if (cur && cur.zeilen.join('\n').length + t.length + 1 > max) {
          fein.push(cur);
          cur = null;
        }
        if (!cur) cur = { von: nr, bis: nr, zeilen: [] };
        cur.zeilen.push(t.length > max * 2 ? t.slice(0, max * 2) : t);
        cur.bis = nr;
      });
      if (cur) fein.push(cur);
    }
    // Blöcke zu Teilen ≤ max zusammenfassen, mit Überlapp
    let teil: Block[] = [];
    const laenge = (bs: Block[]) => bs.reduce((n, x) => n + x.zeilen.join('\n').length + 2, 0);
    const abschliessen = () => {
      if (!teil.length) return;
      out.push({
        abschnitt: s.name,
        von: teil[0]!.von,
        bis: teil[teil.length - 1]!.bis,
        text: teil.map((x) => x.zeilen.join('\n')).join('\n\n'),
      });
    };
    for (const bl of fein) {
      if (teil.length && laenge(teil) + laenge([bl]) > max) {
        abschliessen();
        const letzter = teil[teil.length - 1]!;
        teil = laenge([letzter]) <= ueberlappMax && laenge([letzter]) + laenge([bl]) <= max ? [letzter] : [];
      }
      teil.push(bl);
    }
    abschliessen();
  }
  return out;
}
