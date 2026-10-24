// Unscharfe Suche für Befehlspalette und Filterfelder. Umlaute werden gleich behandelt wie ae/oe/ue.

export function normal(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

/** Punktzahl > 0 bei Treffer. Ganzes Wort am Anfang zählt mehr als verstreute Buchstaben. */
export function punkte(text: string, anfrage: string): number {
  const t = normal(text);
  const q = normal(anfrage).trim();
  if (!q) return 1;
  const woerter = q.split(/\s+/);
  let summe = 0;
  for (const w of woerter) {
    const i = t.indexOf(w);
    if (i === -1) {
      // verstreut
      let pos = 0;
      for (const c of w) {
        pos = t.indexOf(c, pos);
        if (pos === -1) return 0;
        pos++;
      }
      summe += 1;
    } else {
      const wortanfang = i === 0 || /[^a-z0-9]/.test(t[i - 1]);
      summe += wortanfang ? 10 : 5;
      if (i === 0) summe += 3;
    }
  }
  return summe;
}

export function filtere<T>(liste: T[], anfrage: string, text: (x: T) => string): T[] {
  if (!anfrage.trim()) return liste;
  return liste
    .map((x, i) => ({ x, i, p: punkte(text(x), anfrage) }))
    .filter((e) => e.p > 0)
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((e) => e.x);
}
