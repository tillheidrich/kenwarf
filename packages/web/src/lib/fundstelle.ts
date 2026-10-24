// Fundstelle im Text wiederfinden. Zuerst über das wörtliche Zitat (robust gegen
// abweichende Zeilenzählung mit oder ohne YAML-Kopf), sonst über den Zeilenbereich.

function flach(s: string): string {
  return s
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[„“"»«]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface Bereich {
  von: number; // 1-basiert, einschließlich
  bis: number;
  quelle: 'zitat' | 'zeilen' | 'keine';
}

export function findeBereich(text: string, zitat: string | undefined, zeilen: [number, number] | undefined): Bereich {
  const zeilenListe = text.split('\n');
  if (zitat && zitat.trim().length >= 8) {
    const ziel = flach(zitat).replace(/\.\.\.$|…$/, '');
    // Zeilen mit laufendem Versatz flach zusammensetzen
    const starts: number[] = [];
    let gesamt = '';
    zeilenListe.forEach((z, i) => {
      starts[i] = gesamt.length;
      gesamt += flach(z) + ' ';
    });
    let pos = gesamt.indexOf(ziel);
    if (pos === -1 && ziel.length > 40) pos = gesamt.indexOf(ziel.slice(0, 40));
    if (pos !== -1) {
      const ende = pos + Math.min(ziel.length, gesamt.length - pos) - 1;
      let von = 0;
      while (von + 1 < starts.length && starts[von + 1] <= pos) von++;
      let bis = von;
      while (bis + 1 < starts.length && starts[bis + 1] <= ende) bis++;
      return { von: von + 1, bis: bis + 1, quelle: 'zitat' };
    }
  }
  if (zeilen && zeilen[0] >= 1) {
    const von = Math.min(zeilen[0], zeilenListe.length);
    const bis = Math.min(Math.max(zeilen[1], von), zeilenListe.length);
    return { von, bis, quelle: 'zeilen' };
  }
  return { von: 0, bis: 0, quelle: 'keine' };
}

export function zeilenText(z: [number, number]): string {
  return z[0] === z[1] ? `Zeile ${z[0]}` : `Zeilen ${z[0]}–${z[1]}`;
}
