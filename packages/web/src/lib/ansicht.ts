import { AMPEL_WORT } from './lesen';
import { escape, markdownZuHtml } from './markdown';

// Ansichten (Heute, Briefing, Entscheidungsvorlage) speichert core als Markdown im Dateiformat des
// Wissensordners: Punkt-Kennung „[P-…]“, Lese-Ampel „{ampel: rot, grund: "…"}“ und Fundstellen als
// Fußnoten „[^b1]“ mit Definition „[^b1]: quelle, Zeilen 3–5: „Zitat““ (CONTRACT, OKF-Nähe).
// Das Format bleibt in der Datei so, damit es ohne Programm lesbar ist. Für die Anzeige wird es hier
// in sichtbare Marken übersetzt; marked kennt weder die Ampel noch Fußnoten.

const MARKE_AUF = '';
const MARKE_ZU = '';
const FARBEN = new Set(['rot', 'gelb', 'gruen']);

interface Fussnote { id: string; nr: number; text: string }

/** Zerlegt den Ansichtstext und gibt sicheres HTML zurück. */
export function ansichtZuHtml(md: string): string {
  const zeilen = md.replace(/\r\n/g, '\n').split('\n');
  const definitionen = new Map<string, string>();
  const rest: string[] = [];
  let ersteUeberschrift = true;
  for (const z of zeilen) {
    const def = /^\[\^([\w-]+)\]:\s*(.*)$/.exec(z);
    if (def) {
      definitionen.set(def[1]!, def[2]!);
      continue;
    }
    // Die Karte hat schon eine eigene Überschrift; der Titel der Ansicht („# Zusammenfassung 2026-10-24“) entfällt.
    if (ersteUeberschrift && /^#\s+/.test(z)) {
      ersteUeberschrift = false;
      continue;
    }
    rest.push(z);
  }

  const marken: string[] = [];
  const merke = (html: string) => `${MARKE_AUF}${marken.push(html) - 1}${MARKE_ZU}`;
  const fussnoten: Fussnote[] = [];
  const nummer = (id: string): Fussnote => {
    let f = fussnoten.find((x) => x.id === id);
    if (!f) {
      f = { id, nr: fussnoten.length + 1, text: definitionen.get(id) ?? '' };
      fussnoten.push(f);
    }
    return f;
  };

  const vorbereitet = rest
    .map((z) =>
      z
        // Punkt-Kennung am Listenanfang ist eine interne ID
        .replace(/^(\s*(?:[-*+]|\d+\.)\s+)\[P[\w-]*\]\s*/, '$1')
        .replace(/\s*\{ampel:\s*(rot|gelb|gruen)\s*(?:,\s*grund:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g, (_, farbe: string, grund?: string) => {
          if (!FARBEN.has(farbe)) return '';
          const g = grund ? `<span class="ansicht-ampel-grund">${escape(grund)}</span>` : '';
          return ' ' + merke(
            `<span class="lese-ampel lese-ampel--${farbe}"${grund ? ` title="${escape(grund)}"` : ''}><span class="lese-ampel-punkt" aria-hidden="true"></span><span><span class="sr-only">Muss ich das lesen? </span>${escape(AMPEL_WORT[farbe as 'rot'])}</span></span>${g}`,
          );
        })
        .replace(/\s*\[\^([\w-]+)\]/g, (_, id: string) => {
          const f = nummer(id);
          const titel = f.text ? ` title="${escape(f.text)}"` : '';
          return merke(`<span class="fussnote fussnote--inline"${titel}><span class="sr-only">Beleg </span>${f.nr}</span>`);
        }),
    )
    .join('\n');

  let html = markdownZuHtml(vorbereitet);
  html = html.replace(new RegExp(`${MARKE_AUF}(\\d+)${MARKE_ZU}`, 'g'), (_, i: string) => marken[Number(i)] ?? '');
  if (fussnoten.length) {
    const liste = fussnoten
      .map((f) => `<li><span class="fussnote fussnote--inline" aria-hidden="true">${f.nr}</span> ${escape(f.text || 'Fundstelle fehlt')}</li>`)
      .join('');
    html += `<h3 class="ansicht-belege-titel">Belege</h3><ol class="ansicht-belege">${liste}</ol>`;
  }
  return html;
}
