import path from 'node:path';
import { RESERVIERTE_NAMEN, type User } from './types.js';
import { ungueltig } from './fehler.js';

export type Aktion = 'lesen' | 'hinzufuegen' | 'vorschlagen' | 'entscheiden' | 'verwalten';

/**
 * Rollenmodell (Server-Seite, core prüft zusätzlich Sichtbarkeit je Datei):
 * leser: lesen, suchen, fragen · autor: + hinzufügen, vorschlagen
 * freigeber: + Eingang entscheiden · admin: alles, auch Einstellungen und Benutzer.
 */
export function darf(u: User, a: Aktion): boolean {
  const r = new Set(u.rollen);
  if (r.has('admin')) return true;
  switch (a) {
    case 'lesen':
      return r.size > 0;
    case 'hinzufuegen':
    case 'vorschlagen':
      return r.has('autor') || r.has('freigeber');
    case 'entscheiden':
      return r.has('freigeber');
    case 'verwalten':
      return false;
  }
}

/** v1.2: reservierte Namen und Regelordner schützen. Wirft bei Verstoß. */
export function pruefeZiel(ziel: string, u: User): void {
  if ((RESERVIERTE_NAMEN as readonly string[]).includes(path.posix.basename(ziel))) {
    throw ungueltig('index.md und log.md werden automatisch erzeugt und können nicht als Artikel angelegt werden.');
  }
  void u; // Vorschläge für Regeln sind erlaubt, freigeben darf nur admin (siehe /api/eingang/:id).
}
