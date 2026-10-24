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

/* ---------- v1.4 8.4: Agenten-Zugänge (gleiche Regeln wie core `alsAgent`, `agentenScopes`) ---------- */

export type AgentenProfil = 'leser' | 'autor';
type ScopeName = 'kern:lesen' | 'kern:fragen' | 'kern:vorschlagen' | 'kern:bericht' | 'kern:verwalten';

/** Scopes je Agentenprofil; `kern:verwalten` nie für Agenten. */
export function agentenScopes(profil: AgentenProfil): ScopeName[] {
  return profil === 'autor' ? ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht'] : ['kern:lesen', 'kern:fragen'];
}

/** Profil, das genau zu diesen Scopes passt, sonst null (dann kein Agenten-Zugang). */
export function profilVonScopes(scopes: readonly string[]): AgentenProfil | null {
  const s = [...new Set(scopes)].sort().join(' ');
  for (const p of ['leser', 'autor'] as const) if ([...agentenScopes(p)].sort().join(' ') === s) return p;
  return null;
}

/**
 * Effektiver Benutzer hinter einem Agenten-Zugang: nie mehr als der Mensch, höchstens autor (Agenten geben nie frei),
 * ohne `kern:vorschlagen` leser. Teams bleiben (Sichtbarkeit wie beim Menschen), die Reichweite filtert zusätzlich.
 */
export function alsAgent(u: User, scopes: readonly string[]): User {
  const autor = scopes.includes('kern:vorschlagen') && darf(u, 'vorschlagen');
  return { ...u, rollen: [autor ? 'autor' : 'leser'] };
}

const RANG_REICHWEITE = { ich: 0, team: 1, betrieb: 2 } as const;
type R = keyof typeof RANG_REICHWEITE;
/** Engere von angefragter Reichweite und Reichweite des Zugangs (Einschränkung, nie Erweiterung). */
export function engereReichweite(angefragt: R | undefined, zugang: R | null | undefined): R | undefined {
  if (!zugang) return angefragt;
  if (!angefragt) return zugang;
  return RANG_REICHWEITE[angefragt] <= RANG_REICHWEITE[zugang] ? angefragt : zugang;
}

/** Liegt eine Datei in der Reichweite eines Zugangs? (zusätzlich zu den Rechten des Menschen, wie core `inReichweite`). */
export function inReichweite(u: User, sichtbarkeit: string, besitzer: string, r: R | null | undefined): boolean {
  if (!r || r === 'betrieb') return true;
  if (r === 'ich') return sichtbarkeit === 'ich' && besitzer === u.id;
  return sichtbarkeit === 'ich' ? besitzer === u.id : sichtbarkeit.startsWith('team:');
}
