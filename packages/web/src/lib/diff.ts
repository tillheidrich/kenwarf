// Wortgenauer Vergleich alt/neu (Myers, O((N+M)·D)). Leerraum zählt als eigenes Stück,
// damit Zeilenumbrüche erhalten bleiben.

export type Stueck = { art: 'gleich' | 'entfernt' | 'neu'; text: string };

export function zerlege(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

export function wortDiff(alt: string, neu: string): Stueck[] {
  const a = zerlege(alt);
  const b = zerlege(neu);
  // gemeinsamen Anfang und Schluss abschneiden, das hält D klein
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endeA = a.length;
  let endeB = b.length;
  while (endeA > start && endeB > start && a[endeA - 1] === b[endeB - 1]) {
    endeA--;
    endeB--;
  }
  const mitte = myers(a.slice(start, endeA), b.slice(start, endeB));
  const roh: Stueck[] = [];
  if (start > 0) roh.push({ art: 'gleich', text: a.slice(0, start).join('') });
  roh.push(...mitte);
  if (endeA < a.length) roh.push({ art: 'gleich', text: a.slice(endeA).join('') });
  return verdichte(roh);
}

function myers(a: string[], b: string[]): Stueck[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ art: 'neu', text: b.join('') }];
  if (m === 0) return [{ art: 'entfernt', text: a.join('') }];
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const spuren: Int32Array[] = [];
  let fertig = false;
  for (let d = 0; d <= max && !fertig; d++) {
    spuren.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) x = v[k + 1 + max];
      else x = v[k - 1 + max] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        fertig = true;
        break;
      }
    }
  }
  // Rückweg
  const aus: Stueck[] = [];
  let x = n;
  let y = m;
  for (let d = spuren.length - 1; d >= 0; d--) {
    const vd = spuren[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[k - 1 + max] < vd[k + 1 + max])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vd[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      aus.push({ art: 'gleich', text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) aus.push({ art: 'neu', text: b[y - 1] });
      else aus.push({ art: 'entfernt', text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return aus.reverse();
}

/**
 * Lesbar machen: kurze unveränderte Stücke (höchstens zwei Wörter, ohne Zeilenumbruch) zwischen
 * zwei Änderungen werden der Änderung zugeschlagen. Jede Änderungsgruppe wird dann als
 * „entfernt“ (alter Wortlaut) gefolgt von „neu“ (neuer Wortlaut) gezeigt.
 */
export function verdichte(st: Stueck[]): Stueck[] {
  const roh: Stueck[] = [];
  for (const s of st) {
    if (!s.text) continue;
    const l = roh[roh.length - 1];
    if (l && l.art === s.art) l.text += s.text;
    else roh.push({ ...s });
  }
  const kurz = (t: string) => !t.includes('\n') && (t.match(/[^\s]+/g) ?? []).length <= 2;
  const aus: Stueck[] = [];
  let i = 0;
  while (i < roh.length) {
    if (roh[i].art === 'gleich') {
      const l = aus[aus.length - 1];
      if (l && l.art === 'gleich') l.text += roh[i].text;
      else aus.push({ ...roh[i] });
      i++;
      continue;
    }
    // Änderungsgruppe sammeln
    let alt = '';
    let neu = '';
    let j = i;
    while (j < roh.length) {
      const s = roh[j];
      if (s.art === 'entfernt') alt += s.text;
      else if (s.art === 'neu') neu += s.text;
      else {
        const naechsteAenderung = roh.slice(j + 1).find((x) => x.art !== 'gleich');
        const direktDanach = roh[j + 1] && roh[j + 1].art !== 'gleich';
        if (kurz(s.text) && naechsteAenderung && direktDanach) {
          alt += s.text;
          neu += s.text;
        } else break;
      }
      j++;
    }
    if (alt) aus.push({ art: 'entfernt', text: alt });
    if (neu) aus.push({ art: 'neu', text: neu });
    i = j;
  }
  return aus;
}

export interface DiffZaehler {
  entfernt: number;
  neu: number;
}

export function zaehle(st: Stueck[]): DiffZaehler {
  let entfernt = 0;
  let neu = 0;
  for (const s of st) {
    const w = (s.text.match(/[^\s]+/g) ?? []).length;
    if (s.art === 'entfernt') entfernt += w;
    if (s.art === 'neu') neu += w;
  }
  return { entfernt, neu };
}

export type Block = { art: 'stuecke'; stuecke: Stueck[] } | { art: 'ausgelassen'; zeilen: number; text: string };

/**
 * Lange unveränderte Strecken einklappen: bleibt Kontext von `kontext` Zeilen vor und nach jeder Änderung.
 */
export function klappeEin(st: Stueck[], kontext = 2): Block[] {
  const bloecke: Block[] = [];
  let puffer: Stueck[] = [];
  const schiebe = () => {
    if (puffer.length) bloecke.push({ art: 'stuecke', stuecke: puffer });
    puffer = [];
  };
  st.forEach((s, i) => {
    if (s.art !== 'gleich') {
      puffer.push(s);
      return;
    }
    const zeilen = s.text.split('\n');
    const istErstes = i === 0;
    const istLetztes = i === st.length - 1;
    const vorne = istErstes ? 0 : kontext; // Kontext nach vorheriger Änderung
    const hinten = istLetztes ? 0 : kontext; // Kontext vor nächster Änderung
    if (zeilen.length <= vorne + hinten + 2) {
      puffer.push(s);
      return;
    }
    const kopf = zeilen.slice(0, vorne + (istErstes ? 0 : 1));
    const fuss = zeilen.slice(zeilen.length - hinten - (istLetztes ? 0 : 1));
    const mitte = zeilen.slice(kopf.length, zeilen.length - fuss.length);
    if (kopf.length) puffer.push({ art: 'gleich', text: kopf.join('\n') + '\n' });
    schiebe();
    bloecke.push({ art: 'ausgelassen', zeilen: mitte.length, text: mitte.join('\n') + (fuss.length ? '\n' : '') });
    if (fuss.length) puffer.push({ art: 'gleich', text: fuss.join('\n') });
  });
  schiebe();
  return bloecke;
}
