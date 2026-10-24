// Pfade im Daten-Ordner sind relativ zu KERN_DATA, z. B. "wissen/ablaeufe/18-reklamation.md"
// oder "quellen/2026/werkstattordner.md". Die REST-Routen hängen den Pfad ohne Bereichspräfix an
// (/api/wissen/ablaeufe/18-reklamation.md). Annahme, siehe NOTES/web.md.

export type Bereich = 'wissen' | 'quellen';

export function bereichVon(pfad: string): Bereich {
  return pfad.replace(/^\/+/, '').startsWith('quellen/') ? 'quellen' : 'wissen';
}

/** Pfad für die REST-Route: Präfix entfernen, Segmente einzeln kodieren. */
export function apiPfad(pfad: string, bereich: Bereich): string {
  const ohne = pfad.replace(/^\/+/, '').replace(new RegExp(`^${bereich}/`), '');
  return ohne.split('/').map(encodeURIComponent).join('/');
}

/** Dateiname ohne Endung und ohne Nummernpräfix, als Lesehilfe. */
export function kurzname(pfad: string): string {
  const datei = pfad.split('/').pop() ?? pfad;
  return datei.replace(/\.md$/, '');
}

/** Teams aus einer Sichtbarkeit lesen. */
export function sichtbarkeitText(s: string): string {
  if (s === 'ich') return 'Nur ich';
  if (s === 'betrieb') return 'Alle im Betrieb';
  if (s.startsWith('team:')) return `Team ${teamName(s.slice(5))}`;
  return s;
}

export function teamName(t: string): string {
  const namen: Record<string, string> = { buero: 'Büro', werkstatt: 'Werkstatt', montage: 'Montage' };
  return namen[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

/** App-Link zu einem Artikel ohne doppeltes „wissen/“: #/wissen/ablaeufe/18-reklamation.md */
export function artikelRoute(pfad: string): string {
  return `wissen/${pfad.replace(/^\/+/, '').replace(/^wissen\//, '')}`;
}

/** Umkehrung: Rest der Route wieder zum Daten-Pfad. */
export function artikelPfadAusRoute(rest: string): string {
  return rest ? `wissen/${rest.replace(/^wissen\//, '')}` : '';
}

export function dokumentRoute(pfad: string): string {
  return `dokumente/${pfad.replace(/^\/+/, '').replace(/^quellen\//, '')}`;
}

export function dokumentPfadAusRoute(rest: string): string {
  return rest ? `quellen/${rest.replace(/^quellen\//, '')}` : '';
}
