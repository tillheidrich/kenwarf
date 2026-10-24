import type { Rolle, Sichtbarkeit, User } from './types.js';
import { KernFehler } from './types.js';

/**
 * Rechte-Modell:
 * - `ich`: nur der Besitzer (Artikel: `besitzer`, Quelle: `erfasst_von`). Auch Admins sehen fremde `ich`-Dateien nicht.
 * - `team:<name>`: Mitglieder des Teams und der Besitzer.
 * - `betrieb`: alle angemeldeten Benutzer.
 * Reichweite schränkt zusätzlich ein: `ich` = nur eigene `ich`-Dateien, `team` = eigene + Teams, `betrieb` = alles Sichtbare.
 */
export function darfSehen(u: User, sichtbarkeit: string, besitzer: string): boolean {
  if (besitzer === u.id) return true;
  if (sichtbarkeit === 'betrieb') return true;
  if (sichtbarkeit.startsWith('team:')) return u.teams.includes(sichtbarkeit.slice(5));
  return false;
}

export function inReichweite(u: User, sichtbarkeit: string, besitzer: string, reichweite?: 'ich' | 'team' | 'betrieb'): boolean {
  if (!darfSehen(u, sichtbarkeit, besitzer)) return false;
  if (!reichweite || reichweite === 'betrieb') return true;
  if (reichweite === 'ich') return sichtbarkeit === 'ich' && besitzer === u.id;
  return sichtbarkeit === 'ich' ? besitzer === u.id : sichtbarkeit.startsWith('team:');
}

const RANG: Record<Rolle, number> = { leser: 0, autor: 1, freigeber: 2, admin: 3 };

/** Rollen sind gestuft: admin ⊃ freigeber ⊃ autor ⊃ leser. */
export function hatRolle(u: User, rolle: Rolle): boolean {
  return u.rollen.some((r) => RANG[r] >= RANG[rolle]);
}

export function brauchtRolle(u: User, rolle: Rolle, was: string): void {
  if (!hatRolle(u, rolle)) throw new KernFehler('keine_rechte', `${u.name} darf nicht ${was} (Rolle ${rolle} nötig)`);
}

/** Darf `u` die Sichtbarkeit `s` vergeben? (Nur Teams, in denen u ist; Admin darf alle.) */
export function darfSichtbarkeitSetzen(u: User, s: Sichtbarkeit): boolean {
  if (s === 'ich' || s === 'betrieb') return true;
  return hatRolle(u, 'admin') || u.teams.includes(s.slice(5));
}
