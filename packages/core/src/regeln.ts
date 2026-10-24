import { faltUmlaute, stammformen } from './util.js';

export const REGEL_DATEI = 'wissen/_regeln/was-nie-hineinkommt.md';

export interface Regel {
  /** Wortlaut der Zeile in der Regel-Datei. */
  text: string;
  /** Dateizeile (1-basiert). */
  zeile: number;
  /** Überschrift, unter der die Regel steht. */
  abschnitt: string;
  pruefe: (eingabe: string) => boolean;
}

/**
 * Regel-Datei lesen. Jeder Listenpunkt ist eine Regel.
 * - `/muster/flags` → regulärer Ausdruck (Standard-Flags `iu`).
 * - Sonst Schlüsselwörter: mehrere Alternativen mit `|` oder `,` getrennt; eine Alternative trifft,
 *   wenn alle ihre Wörter (Stammform, Umlaute gefaltet) in der Eingabe vorkommen.
 * - Text nach ` — `, ` – `, ` - ` oder `: ` ist Erläuterung und zählt nicht als Schlüsselwort
 *   (`- Gehalt | Lohn: Lohndaten gehören in die Lohnbuchhaltung`).
 */
export function leseRegeln(text: string, kopfZeilen = 0): Regel[] {
  const zeilen = text.split(/\r?\n/);
  const out: Regel[] = [];
  let abschnitt = '';
  let imCode = false;
  zeilen.forEach((z, i) => {
    if (/^\s*```/.test(z)) imCode = !imCode;
    if (imCode) return;
    const h = /^#{1,6}\s+(.+)$/.exec(z);
    if (h) {
      abschnitt = h[1]!.trim();
      return;
    }
    const m = /^\s*[-*]\s+(.+)$/.exec(z);
    if (!m) return;
    const roh = m[1]!.trim();
    const zeile = kopfZeilen + i + 1;
    const rx = /^`?\/(.+)\/([a-z]*)`?(?:\s.*)?$/.exec(roh);
    if (rx) {
      try {
        const re = new RegExp(rx[1]!, rx[2] || 'iu');
        out.push({ text: roh, zeile, abschnitt, pruefe: (e) => re.test(e) || re.test(faltUmlaute(e)) });
      } catch {
        /* ungültiges Muster ignorieren */
      }
      return;
    }
    const schluessel = roh.split(/\s+[—–-]\s+|:\s+/)[0]!.replace(/[*_`„“"]/g, '');
    const alternativen = schluessel
      .split(/\s*[|,;]\s*|\s+oder\s+/)
      .map((a) => stammformen(a, true).filter((w) => w.length >= 3))
      .filter((a) => a.length > 0);
    if (!alternativen.length) return;
    out.push({
      text: roh,
      zeile,
      abschnitt,
      pruefe: (e) => {
        const st = stammformen(e, true);
        const set = new Set(st);
        return alternativen.some((alt) => alt.every((w) => set.has(w) || (w.length >= 5 && st.some((x) => x.length >= w.length && x.includes(w)))));
      },
    });
  });
  return out;
}

export function verletzteRegel(regeln: Regel[], eingabe: string): Regel | null {
  return regeln.find((r) => r.pruefe(eingabe)) ?? null;
}
