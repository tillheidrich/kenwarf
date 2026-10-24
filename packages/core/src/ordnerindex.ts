import { posix } from 'node:path';
import type { DateiEintrag } from './suchindex.js';
import { saetze } from './util.js';

/** Reservierte Dateinamen (OKF v0.2): werden von Kern erzeugt, nie von Hand bearbeitet, sind keine Artikel. */
export const RESERVIERT = new Set(['index.md', 'log.md']);

export function istReserviert(pfad: string): boolean {
  return RESERVIERT.has(posix.basename(pfad));
}

const hinweis = (produkt: string) => `<!-- Von ${produkt} automatisch erzeugt. Nicht von Hand bearbeiten. -->`;

/** Ordner, deren index.md/log.md eine Änderung an `pfad` betrifft. */
export function betroffeneOrdner(pfad: string): string[] {
  const teile = pfad.split('/');
  if (teile[0] === 'wissen') return teile.length > 2 ? ['', 'wissen', `wissen/${teile[1]}`] : ['', 'wissen'];
  if (teile[0] === 'quellen') return ['', 'quellen'];
  return [];
}

function ersterSatz(s: string): string {
  return (saetze(s)[0] ?? '').slice(0, 200);
}

/** Inhalt von `<ordner>/index.md`. `''` = Wurzel des Datenordners (mit `okf_version`). */
export function erzeugeIndex(ordner: string, dateien: DateiEintrag[], betrieb: string, kurz: Map<string, string>, produkt = 'Kern', alleZeigen = false): string {
  const HINWEIS = hinweis(produkt);
  // S1 N1/P2: in der gemeinsamen Datei nur, was alle sehen dürfen; Team- und private Dateien nur als Zahl
  const offen = (d: DateiEintrag) => alleZeigen || d.sichtbarkeit === 'betrieb';
  const sichtbar = dateien.filter(offen);
  const verborgen = (filter: (d: DateiEintrag) => boolean) => dateien.filter((d) => !offen(d) && filter(d)).length;
  const rest = (n: number, was: string) => (n ? [`- ${n} weitere ${was} mit eingeschränkter Sichtbarkeit`] : []);
  if (ordner === '') {
    const gruppen = [...new Set(sichtbar.filter((d) => d.art === 'wissen').map((d) => d.pfad.split('/')[1]!).filter((g) => !g.endsWith('.md')))].sort();
    return [
      '---',
      'okf_version: "0.2"',
      '---',
      '',
      HINWEIS,
      '',
      `# ${betrieb}`,
      '',
      `- [Wissen](/wissen/index.md): ${sichtbar.filter((d) => d.art === 'wissen').length} Artikel in ${gruppen.length} Gruppen`,
      `- [Quellen](/quellen/index.md): ${sichtbar.filter((d) => d.art === 'quelle').length} Quellen (Rohmaterial)`,
      '',
    ].join('\n');
  }
  if (ordner === 'wissen') {
    const zeilen = [HINWEIS, '', '# Wissen', ''];
    const nachGruppe = new Map<string, DateiEintrag[]>();
    for (const d of sichtbar.filter((x) => x.art === 'wissen')) {
      const t = d.pfad.split('/');
      const g = t.length > 2 ? t[1]! : '';
      nachGruppe.set(g, [...(nachGruppe.get(g) ?? []), d]);
    }
    for (const [g, ds] of [...nachGruppe.entries()].sort()) {
      if (g) zeilen.push(`- [${g}](/wissen/${g}/index.md): ${ds.length} Artikel`);
      else for (const d of ds) zeilen.push(`- [${d.titel}](/${d.pfad})`);
    }
    zeilen.push(...rest(verborgen((d) => d.art === 'wissen'), 'Artikel'));
    return zeilen.join('\n') + '\n';
  }
  if (ordner === 'quellen') {
    const zeilen = [HINWEIS, '', '# Quellen', ''];
    for (const d of sichtbar.filter((x) => x.art === 'quelle' && x.aktiv).sort((a, b) => b.pfad.localeCompare(a.pfad))) {
      zeilen.push(`- [${d.titel}](/${d.pfad})${d.sammlung ? ` · Sammlung ${d.sammlung}` : ''}`);
    }
    zeilen.push(...rest(verborgen((d) => d.art === 'quelle' && !!d.aktiv), 'Quellen'));
    return zeilen.join('\n') + '\n';
  }
  const gruppe = ordner.split('/')[1] ?? '';
  const zeilen = [HINWEIS, '', `# ${gruppe}`, ''];
  for (const d of sichtbar.filter((x) => x.pfad.startsWith(ordner + '/') && x.art === 'wissen').sort((a, b) => a.titel.localeCompare(b.titel, 'de'))) {
    const k = ersterSatz(kurz.get(d.pfad) ?? '');
    zeilen.push(`- [${d.titel}](/${d.pfad})${k ? `: ${k}` : ''}${d.status === 'veraltet' ? ' (veraltet)' : ''}`);
  }
  zeilen.push(...rest(verborgen((d) => d.pfad.startsWith(ordner + '/') && d.art === 'wissen'), 'Artikel'));
  return zeilen.join('\n') + '\n';
}

/** Neuen Eintrag oben in log.md einfügen (Datumsüberschriften JJJJ-MM-TT, neueste zuerst). */
export function ergaenzeLog(alt: string | null, datum: string, eintrag: string, titel: string, produkt = 'Kern'): string {
  const HINWEIS = hinweis(produkt);
  const zeile = `- ${eintrag.replace(/\n+/g, ' ')}`;
  if (!alt || !alt.trim()) return `${HINWEIS}\n\n# ${titel}\n\n## ${datum}\n\n${zeile}\n`;
  const lines = alt.split('\n');
  const idx = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
  if (idx >= 0 && lines[idx] === `## ${datum}`) {
    let ins = idx + 1;
    while (ins < lines.length && !lines[ins]!.trim()) ins++;
    lines.splice(ins, 0, zeile);
    return lines.join('\n');
  }
  const at = idx >= 0 ? idx : lines.length;
  lines.splice(at, 0, `## ${datum}`, '', zeile, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
