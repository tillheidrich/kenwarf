/**
 * v1.4 3.4 und 9: Tageszähler ohne Personenbezug in `.kern/zaehler.sqlite` (nicht in git, nicht im Export).
 * KI-Verbrauch je Tag (Aufrufe, Tokens, Kosten in Hundertstel-Cent) und Ereigniszähler (z. B. belegte Antworten).
 * Keine Benutzer-IDs, keine Fragen, keine Pfade (Schema-Test).
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Verbrauch {
  monat: string;
  cent_monat: number;
  cent_heute: number;
  aufrufe_heute: number;
  aufrufe_monat: number;
  tokens_monat: { ein: number; aus: number };
  /** false, wenn für den Anbieter kein Preis hinterlegt ist (dann zählen nur Tokens). */
  preis_bekannt: boolean;
}

export class Zaehler {
  private db: Database.Database;
  constructor(pfad: string, private heute: () => string) {
    mkdirSync(dirname(pfad), { recursive: true });
    this.db = new Database(pfad);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ki_tag (tag TEXT PRIMARY KEY, aufrufe INTEGER NOT NULL DEFAULT 0, ein INTEGER NOT NULL DEFAULT 0, aus INTEGER NOT NULL DEFAULT 0, centhundertstel INTEGER NOT NULL DEFAULT 0, ohne_preis INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ereignis_tag (tag TEXT NOT NULL, art TEXT NOT NULL, anzahl INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tag, art));
    `);
  }

  /** Einen KI-Aufruf zählen; `preis` in Cent je Million Tokens (ein/aus) oder null. */
  ki(v: { eingabeTokens: number; ausgabeTokens: number }, preis: { ein: number; aus: number } | null): void {
    const ein = Math.max(0, Math.round(v.eingabeTokens || 0));
    const aus = Math.max(0, Math.round(v.ausgabeTokens || 0));
    const ch = preis ? Math.round(((ein * preis.ein + aus * preis.aus) / 1_000_000) * 100) : 0;
    this.db
      .prepare(`INSERT INTO ki_tag (tag, aufrufe, ein, aus, centhundertstel, ohne_preis) VALUES (?, 1, ?, ?, ?, ?)
        ON CONFLICT(tag) DO UPDATE SET aufrufe = aufrufe + 1, ein = ein + excluded.ein, aus = aus + excluded.aus, centhundertstel = centhundertstel + excluded.centhundertstel, ohne_preis = ohne_preis + excluded.ohne_preis`)
      .run(this.heute(), ein, aus, ch, preis ? 0 : 1);
  }

  /** Ereignis ohne Inhalt zählen (Art ist ein fester Bezeichner, nie Nutzertext). */
  ereignis(art: 'antwort_belegt' | 'antwort_steht_nicht_drin' | 'antwort_gehoert_nicht_hierher' | 'frage_ohne_ki' | 'suche' | 'vorschlag_freigegeben' | 'vorschlag_abgelehnt'): void {
    this.db.prepare('INSERT INTO ereignis_tag (tag, art, anzahl) VALUES (?, ?, 1) ON CONFLICT(tag, art) DO UPDATE SET anzahl = anzahl + 1').run(this.heute(), art);
  }

  ereignisse(von: string, bis: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT art, SUM(anzahl) AS n FROM ereignis_tag WHERE tag >= ? AND tag <= ? GROUP BY art').all(von, bis) as { art: string; n: number }[]) out[r.art] = r.n;
    return out;
  }

  verbrauch(): Verbrauch {
    const tag = this.heute();
    const monat = tag.slice(0, 7);
    const m = this.db.prepare("SELECT COALESCE(SUM(aufrufe),0) a, COALESCE(SUM(ein),0) e, COALESCE(SUM(aus),0) o, COALESCE(SUM(centhundertstel),0) c, COALESCE(SUM(ohne_preis),0) p FROM ki_tag WHERE substr(tag, 1, 7) = ?").get(monat) as { a: number; e: number; o: number; c: number; p: number };
    const h = this.db.prepare('SELECT aufrufe a, centhundertstel c FROM ki_tag WHERE tag = ?').get(tag) as { a: number; c: number } | undefined;
    return { monat, cent_monat: m.c / 100, cent_heute: (h?.c ?? 0) / 100, aufrufe_heute: h?.a ?? 0, aufrufe_monat: m.a, tokens_monat: { ein: m.e, aus: m.o }, preis_bekannt: m.p === 0 };
  }

  /** Für den Schema-Test: Spaltennamen aller Tabellen. */
  spalten(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).flatMap((t) =>
      (this.db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => `${t.name}.${c.name}`),
    );
  }

  schliessen(): void {
    if (this.db.open) this.db.close();
  }
}
