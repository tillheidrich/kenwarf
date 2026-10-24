import type { KernLike, User } from './types.js';

export interface PlanerOptionen {
  /** Abstand in Stunden; 0 schaltet ab. */
  stunden: number;
  /** Verzögerung des ersten Laufs in ms (Standard: 60 s nach Start). */
  ersterLaufMs?: number;
  log?: (s: string) => void;
  /** Titel und Adressen ins Log (Standard aus, P2). */
  logInhalte?: boolean;
}

/** Nur Zahlen aus dem Ergebnis der Beobachtung, keine Titel oder Adressen. */
export function zusammenfassung(r: unknown): string {
  if (!r || typeof r !== 'object') return 'fertig';
  const teile: string[] = [];
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (Array.isArray(v)) teile.push(`${k}: ${v.length}`);
    else if (typeof v === 'number') teile.push(`${k}: ${v}`);
  }
  return teile.join(', ') || 'fertig';
}

/**
 * v1.2 (F12): Planer für beobachtete Quellen. Ruft `beobachteQuellen(u)` von core auf
 * (Rückfall: `aktualisiereBeobachtete(u)`), als erster Admin. Läuft nie doppelt.
 * Sperrt eine Seite den Abruf, meldet core das als „nicht abrufbar“; der Planer umgeht nichts.
 */
export function startePlaner(kern: KernLike, opt: PlanerOptionen): { stop(): void; laufJetzt(): Promise<unknown> } {
  const log = opt.log ?? (() => {});
  const fn = kern.beobachteQuellen?.bind(kern) ?? kern.aktualisiereBeobachtete?.bind(kern);
  let laeuft = false;
  const lauf = async (): Promise<unknown> => {
    if (!fn || laeuft) return null;
    laeuft = true;
    try {
      const admin: User | undefined = (await kern.benutzer.liste()).find((u) => u.rollen.includes('admin'));
      if (!admin) { log('[kern] Quellenbeobachtung übersprungen: kein Admin angelegt.'); return null; }
      const r = await fn(admin);
      log(`[kern] Quellenbeobachtung: ${opt.logInhalte ? JSON.stringify(r)?.slice(0, 300) : zusammenfassung(r)}`);
      return r;
    } catch (e) {
      log(`[kern] Quellenbeobachtung fehlgeschlagen${opt.logInhalte ? `: ${(e as Error).message}` : ` (${(e as Error).name})`}`);
      return null;
    } finally {
      laeuft = false;
    }
  };
  if (!fn || opt.stunden <= 0) return { stop() {}, laufJetzt: lauf };
  const erster = setTimeout(() => { void lauf(); }, opt.ersterLaufMs ?? 60_000);
  const takt = setInterval(() => { void lauf(); }, opt.stunden * 3600_000);
  erster.unref();
  takt.unref();
  return { stop() { clearTimeout(erster); clearInterval(takt); }, laufJetzt: lauf };
}
