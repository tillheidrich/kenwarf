import type { KernConfig, KernLike, Quelle, User } from './types.js';
import { nichtGefunden } from './fehler.js';
import { FakeKern } from './testing/fake-kern.js';

/**
 * Öffnet den Kern. Mit `fake` (Env KERN_FAKE=1) die Attrappe, sonst @kern/core.
 * Der Import ist dynamisch, damit Server und CLI auch ohne gebautes core starten.
 */
export async function oeffneKern(cfg: KernConfig, fake: boolean): Promise<KernLike> {
  if (fake) return FakeKern.open(cfg);
  const modName = '@kern/core';
  let mod: { Kern?: { open(c: KernConfig): Promise<KernLike> } };
  try {
    mod = (await import(modName)) as typeof mod;
  } catch (e) {
    throw new Error(`@kern/core konnte nicht geladen werden (${(e as Error).message}). Zum Testen ohne core: KERN_FAKE=1.`);
  }
  if (!mod.Kern || typeof mod.Kern.open !== 'function') throw new Error('@kern/core exportiert keine Klasse "Kern" mit open().');
  return mod.Kern.open(cfg);
}

/**
 * Liest eine Quelle mit Rechteprüfung. Der CONTRACT kennt keine Einzel-Lesefunktion
 * für Quellen; ist `leseQuelle` vorhanden, wird sie genutzt, sonst die Liste gefiltert.
 */
export async function leseQuelle(kern: KernLike, u: User, pfad: string): Promise<Quelle> {
  const k = kern as KernLike & { leseQuelle?: (u: User, p: string) => Promise<Quelle> };
  if (typeof k.leseQuelle === 'function') return k.leseQuelle(u, pfad);
  const q = (await kern.listeQuellen(u)).find((x) => x.pfad === pfad);
  if (!q) throw nichtGefunden('Quelle nicht gefunden.');
  return q;
}
