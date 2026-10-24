import type { FundstelleKopf } from '../api/types';
import { escape, markdownZuHtml } from './markdown';
import { href } from './router';

// Fußnoten-Fundstellen (v1.1): [^id] im Text wird zu einer klickbaren Nummer, die zur
// Fundstelle führt. Die Definitionszeilen [^id]: … fallen weg, weil die Fundstellen
// unter dem Artikel ohnehin vollständig stehen.

const ANFANG = 'KERNFNANFANG';
const ENDE = 'KERNFNENDE';

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const vonHex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16))));

export function fundstelleHref(f: FundstelleKopf & { zitat?: string }): string {
  return href('fundstelle', { pfad: f.quelle, von: f.zeilen[0], bis: f.zeilen[1], abschnitt: f.abschnitt, zitat: f.zitat?.slice(0, 300) });
}

export function artikelHtml(text: string, pfad: string, fundstellen: FundstelleKopf[]): string {
  const nummer = new Map<string, number>();
  fundstellen.forEach((f, i) => {
    if (f.id) nummer.set(f.id, i + 1);
  });
  const ohneDefinitionen = text.replace(/^\[\^[^\]\s]+\]:.*$/gm, '').replace(/\n{3,}/g, '\n\n');
  const mitMarken = ohneDefinitionen.replace(/\[\^([^\]\s]+)\]/g, (_m, id: string) => `${ANFANG}${hex(id)}${ENDE}`);
  const html = markdownZuHtml(mitMarken, pfad);
  return html.replace(new RegExp(`${ANFANG}([0-9a-f]+?)${ENDE}`, 'g'), (_m, kod: string) => {
    const id = vonHex(kod);
    const n = nummer.get(id);
    const f = n ? fundstellen[n - 1] : undefined;
    if (!f) return `<sup class="fussnote fussnote--lose" title="Fundstelle ${escape(id)} fehlt">?</sup>`;
    return `<a class="fussnote" href="${escape(fundstelleHref(f))}" aria-label="Fundstelle ${n}: ${escape(f.abschnitt)}">${n}</a>`;
  });
}
