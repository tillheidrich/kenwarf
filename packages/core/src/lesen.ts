/**
 * v1.3 / v1.3.1: Leseeinstellungen (nutzer/<id>/lesen.yaml, in git) und Lesestand (.kern/lesen.sqlite, nur für den Lesenden,
 * Einträge älter als 30 Tage werden gelöscht, nie in git, kein Bericht über andere Personen).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { LeseEinstellungen, Lesestil } from './types.js';

export const LESESTILE: readonly Lesestil[] = ['zusammenfassung', 'entscheidung', 'fokus'];

export function standardLesen(stil: Lesestil = 'zusammenfassung'): LeseEinstellungen {
  return {
    stil,
    lesebudget_an: false,
    lesebudget_hart: false,
    lesebudget_min_tag: 10,
    woerter_pro_minute: 200,
    max_offene_vorschlaege: 3,
    zustellzeiten: ['07:30'],
    modus_erst_ich: false,
    nur_abweichungen: stil === 'fokus',
    verstaendnisfrage: 'stichprobe',
    regeln: [],
  };
}

export const leseEinstellungenSchema = z.object({
  stil: z.enum(['zusammenfassung', 'entscheidung', 'fokus']),
  lesebudget_an: z.boolean(),
  lesebudget_hart: z.boolean(),
  lesebudget_min_tag: z.number().min(1).max(240),
  woerter_pro_minute: z.number().min(50).max(600),
  max_offene_vorschlaege: z.number().int().min(1).max(100),
  zustellzeiten: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1).max(3),
  modus_erst_ich: z.boolean(),
  nur_abweichungen: z.boolean(),
  verstaendnisfrage: z.enum(['aus', 'stichprobe', 'immer_bei_fakten']),
  regeln: z.array(
    z.object({
      id: z.string().min(1),
      wenn: z.enum(['fakt_aendert', 'frist_naht', 'artikel_aendert', 'neue_quelle', 'zustaendig_fuer', 'agent_risiko']),
      filter: z.object({ gruppe: z.string().optional(), gegenstand: z.string().optional(), art: z.string().optional(), tage: z.number().optional(), risiko: z.string().optional() }).optional(),
      dann: z.enum(['melden', 'sammeln']),
    }),
  ),
});

export class LeseStand {
  private db: Database.Database;
  constructor(pfad: string, heute: () => Date) {
    mkdirSync(dirname(pfad), { recursive: true });
    this.db = new Database(pfad);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS gelesen (nutzer TEXT NOT NULL, objekt TEXT NOT NULL, punkt TEXT NOT NULL DEFAULT '', stufe INTEGER NOT NULL, am TEXT NOT NULL,
      PRIMARY KEY (nutzer, objekt, punkt, stufe));`);
    const grenze = new Date(heute().getTime() - 30 * 86400_000).toISOString();
    this.db.prepare('DELETE FROM gelesen WHERE am < ?').run(grenze);
  }
  merke(nutzer: string, objekt: string, punkt: string, stufe: number, am: string): void {
    this.db.prepare('INSERT INTO gelesen (nutzer, objekt, punkt, stufe, am) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET am = excluded.am').run(nutzer, objekt, punkt, stufe, am);
  }
  geoeffnet(nutzer: string, objekt: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM gelesen WHERE nutzer = ? AND objekt = ? LIMIT 1').get(nutzer, objekt);
  }
  objekte(nutzer: string): Set<string> {
    return new Set((this.db.prepare('SELECT DISTINCT objekt FROM gelesen WHERE nutzer = ?').all(nutzer) as { objekt: string }[]).map((r) => r.objekt));
  }
  /** Für `nie_gelesen` im Aufräumlauf: wurde ein Objekt von irgendwem aufgerufen (ohne Personenbezug)? */
  irgendwerGeoeffnet(objekt: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM gelesen WHERE objekt = ? LIMIT 1').get(objekt);
  }
  loescheNutzer(nutzer: string): void {
    this.db.prepare('DELETE FROM gelesen WHERE nutzer = ?').run(nutzer);
  }
  schliessen(): void {
    this.db.close();
  }
}
