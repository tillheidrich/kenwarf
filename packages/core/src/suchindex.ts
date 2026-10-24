import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Abschnitt } from './abschnitte.js';
import { ftsText, sha256, stammformen, suchformen, suchNorm } from './util.js';

export const SCHEMA_VERSION = '8';

export interface DateiEintrag {
  pfad: string;
  art: 'wissen' | 'quelle';
  titel: string;
  sichtbarkeit: string;
  besitzer: string;
  sammlung: string;
  gruppe: string;
  status: string;
  hash: string;
  ersetzt: string | null;
  pruefen_bis: string | null;
  /** 0 = nicht in der Suche (ersetzte Quelle, Regel-Datei, veraltet). */
  aktiv: number;
  fehler: string | null;
  /** Quellen: Herkunft (Dateiname/URL) und Hash des Originals. */
  herkunft: string | null;
  quellhash: string | null;
  groesse: number;
  /** Artikel: `verantwortlich` aus dem Kopf (für die Ampel). */
  verantwortlich: string | null;
}

export interface FaktZeile {
  id: string;
  art: string;
  gegenstand: string;
  wert: string | number | boolean;
  einheit?: string | null;
  gilt_ab?: string | null;
  gilt_bis?: string | null;
  ersetzt?: string | null;
  fundstelle: string;
}

export interface AbschnittZeile {
  id: number;
  pfad: string;
  abschnitt: string;
  von: number;
  bis: number;
  text: string;
}

export interface RohTreffer extends AbschnittZeile {
  art: 'wissen' | 'quelle';
  titel: string;
  score: number;
  rangFts?: number;
  rangVek?: number;
}

const f32 = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const vonBlob = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export function kosinus(a: Float32Array, b: Float32Array): number {
  let s = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    s += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

/** SQLite-Index: Dateien, Abschnitte, FTS5 (deutsch normalisiert), Vektoren (sqlite-vec oder JS). Wegwerfbar. */
export class SuchIndex {
  db: Database.Database;
  vecAktiv = false;

  private constructor(pfad: string) {
    if (pfad !== ':memory:') mkdirSync(dirname(pfad), { recursive: true });
    this.db = new Database(pfad);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  static async oeffne(pfad: string, opt: { vektorErweiterung?: boolean } = {}): Promise<SuchIndex> {
    const ix = new SuchIndex(pfad);
    if (opt.vektorErweiterung !== false) {
      try {
        const sv = await import('sqlite-vec');
        sv.load(ix.db);
        ix.db.prepare('select vec_version()').get();
        ix.vecAktiv = true;
      } catch {
        ix.vecAktiv = false; // Rückfall: JS-Kosinus
      }
    }
    ix.schema();
    return ix;
  }

  private schema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS emb_cache (schluessel TEXT PRIMARY KEY, vec BLOB NOT NULL);
    `);
    const v = this.meta('schema');
    if (v !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS abschnitte_vocab; DROP TABLE IF EXISTS fakten; DROP TABLE IF EXISTS abschnitte_tri; DROP TABLE IF EXISTS abschnitte_fts; DROP TABLE IF EXISTS abschnitte; DROP TABLE IF EXISTS dateien;
      `);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dateien (
        pfad TEXT PRIMARY KEY, art TEXT NOT NULL, titel TEXT NOT NULL, sichtbarkeit TEXT NOT NULL, besitzer TEXT NOT NULL,
        sammlung TEXT NOT NULL DEFAULT '', gruppe TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL,
        ersetzt TEXT, pruefen_bis TEXT, aktiv INTEGER NOT NULL DEFAULT 1, fehler TEXT, herkunft TEXT, quellhash TEXT, groesse INTEGER NOT NULL DEFAULT 0, verantwortlich TEXT
      );
      CREATE TABLE IF NOT EXISTS abschnitte (
        id INTEGER PRIMARY KEY, pfad TEXT NOT NULL REFERENCES dateien(pfad) ON DELETE CASCADE, nr INTEGER NOT NULL,
        abschnitt TEXT NOT NULL, von INTEGER NOT NULL, bis INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB
      );
      CREATE INDEX IF NOT EXISTS abschnitte_pfad ON abschnitte(pfad);
      CREATE TABLE IF NOT EXISTS fakten (
        pfad TEXT NOT NULL REFERENCES dateien(pfad) ON DELETE CASCADE, id TEXT NOT NULL, art TEXT NOT NULL, gegenstand TEXT NOT NULL,
        wert TEXT NOT NULL, einheit TEXT, gilt_ab TEXT, gilt_bis TEXT, ersetzt TEXT, fundstelle TEXT NOT NULL, PRIMARY KEY (pfad, id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS abschnitte_fts USING fts5(inhalt, kopf, tokenize = 'unicode61 remove_diacritics 2');
      CREATE VIRTUAL TABLE IF NOT EXISTS abschnitte_tri USING fts5(inhalt, tokenize = 'trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS abschnitte_vocab USING fts5vocab(abschnitte_fts, 'row');
    `);
    this.setzeMeta('schema', SCHEMA_VERSION);
  }

  meta(k: string): string | undefined {
    return (this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined)?.v;
  }
  setzeMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  leeren(): void {
    this.db.exec('DELETE FROM fakten; DELETE FROM abschnitte_tri; DELETE FROM abschnitte_fts; DELETE FROM abschnitte; DELETE FROM dateien;');
  }

  dateien(): DateiEintrag[] {
    return this.db.prepare('SELECT * FROM dateien ORDER BY pfad').all() as DateiEintrag[];
  }
  datei(pfad: string): DateiEintrag | undefined {
    return this.db.prepare('SELECT * FROM dateien WHERE pfad = ?').get(pfad) as DateiEintrag | undefined;
  }
  abschnitteVon(pfad: string): AbschnittZeile[] {
    return this.db.prepare('SELECT id, pfad, abschnitt, von, bis, text FROM abschnitte WHERE pfad = ? ORDER BY nr').all(pfad) as AbschnittZeile[];
  }
  anzahlAbschnitte(): number {
    return (this.db.prepare('SELECT count(*) n FROM abschnitte').get() as { n: number }).n;
  }

  /** Embeddings mit Cache (Schlüssel = Modell-Kennung + Text-Hash). */
  async embedMitCache(texte: string[], kennung: string, embed: (t: string[]) => Promise<Float32Array[]>): Promise<Float32Array[]> {
    const schluessel = texte.map((t) => sha256(kennung + '\0' + t));
    const get = this.db.prepare('SELECT vec FROM emb_cache WHERE schluessel = ?');
    const out: (Float32Array | null)[] = schluessel.map((s) => {
      const r = get.get(s) as { vec: Buffer } | undefined;
      return r ? vonBlob(r.vec) : null;
    });
    const fehlend = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    if (fehlend.length) {
      const neu = await embed(fehlend.map((i) => texte[i]!));
      const put = this.db.prepare('INSERT OR REPLACE INTO emb_cache(schluessel, vec) VALUES (?, ?)');
      const tx = this.db.transaction(() => {
        fehlend.forEach((i, k) => {
          const v = neu[k];
          if (!v) throw new Error('Anbieter lieferte zu wenige Embeddings');
          out[i] = v;
          put.run(schluessel[i]!, f32(v));
        });
      });
      tx();
    }
    return out as Float32Array[];
  }

  schreibeDatei(e: DateiEintrag, abschnitte: Abschnitt[], vektoren: Float32Array[], fakten: FaktZeile[] = []): void {
    const tx = this.db.transaction(() => {
      this.entferneIntern(e.pfad);
      this.db
        .prepare(
          `INSERT INTO dateien (pfad, art, titel, sichtbarkeit, besitzer, sammlung, gruppe, status, hash, ersetzt, pruefen_bis, aktiv, fehler, herkunft, quellhash, groesse, verantwortlich)
           VALUES (@pfad, @art, @titel, @sichtbarkeit, @besitzer, @sammlung, @gruppe, @status, @hash, @ersetzt, @pruefen_bis, @aktiv, @fehler, @herkunft, @quellhash, @groesse, @verantwortlich)`,
        )
        .run(e);
      const ins = this.db.prepare('INSERT INTO abschnitte (pfad, nr, abschnitt, von, bis, text, vec) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const fts = this.db.prepare('INSERT INTO abschnitte_fts (rowid, inhalt, kopf) VALUES (?, ?, ?)');
      const tri = this.db.prepare('INSERT INTO abschnitte_tri (rowid, inhalt) VALUES (?, ?)');
      abschnitte.forEach((a, i) => {
        const v = vektoren[i];
        const r = ins.run(e.pfad, i, a.abschnitt, a.von, a.bis, a.text, v && v.length ? f32(v) : null);
        fts.run(r.lastInsertRowid, ftsText(a.text), ftsText(`${e.titel} ${a.abschnitt}`));
        tri.run(r.lastInsertRowid, suchNorm(`${e.titel} ${a.abschnitt}\n${a.text}`));
      });
      const fi = this.db.prepare(
        'INSERT OR REPLACE INTO fakten (pfad, id, art, gegenstand, wert, einheit, gilt_ab, gilt_bis, ersetzt, fundstelle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const f of fakten) fi.run(e.pfad, f.id, f.art, f.gegenstand, JSON.stringify(f.wert), f.einheit ?? null, f.gilt_ab ?? null, f.gilt_bis ?? null, f.ersetzt ?? null, f.fundstelle);
    });
    tx();
  }

  private entferneIntern(pfad: string): void {
    const ids = this.db.prepare('SELECT id FROM abschnitte WHERE pfad = ?').all(pfad) as { id: number }[];
    const del = this.db.prepare('DELETE FROM abschnitte_fts WHERE rowid = ?');
    const delTri = this.db.prepare('DELETE FROM abschnitte_tri WHERE rowid = ?');
    for (const { id } of ids) {
      del.run(id);
      delTri.run(id);
    }
    this.db.prepare('DELETE FROM abschnitte WHERE pfad = ?').run(pfad);
    this.db.prepare('DELETE FROM fakten WHERE pfad = ?').run(pfad);
    this.db.prepare('DELETE FROM dateien WHERE pfad = ?').run(pfad);
  }

  entferne(pfad: string): void {
    this.db.transaction(() => this.entferneIntern(pfad))();
  }

  /** Ersetzte Quellen inaktiv setzen (eine neue Fassung verdrängt die alte in der Suche). */
  aktualisiereErsetzt(): void {
    this.db.exec(`
      UPDATE dateien SET aktiv = 1 WHERE art = 'quelle';
      UPDATE dateien SET aktiv = 0 WHERE art = 'quelle' AND pfad IN (SELECT ersetzt FROM dateien WHERE ersetzt IS NOT NULL);
    `);
  }

  /** Volltextsuche: nur in erlaubten Pfaden (Rechtefilter vor dem Ranking). */
  /**
   * Komposita zerlegen mit dem eigenen Wortschatz des Index: „urlaubsantrag“ → „urlaub“, „antrag“, wenn diese Wörter
   * im Wissensordner vorkommen (Fugen-s wird mitgedacht). Nur für die Anfrage; Treffer bleiben rechtegefiltert.
   */
  teilwoerter(wort: string): string[] {
    if (wort.length < 8) return [];
    const rows = this.db
      .prepare(
        `SELECT term FROM abschnitte_vocab WHERE length(term) >= 4 AND length(term) <= ? - 3 AND (substr(?, 1, length(term)) = term OR substr(?, -length(term)) = term) ORDER BY length(term) DESC LIMIT 40`,
      )
      .all(wort.length, wort, wort) as { term: string }[];
    const terme = rows.map((r) => r.term);
    const vorn = terme.filter((t) => wort.startsWith(t));
    const hinten = terme.filter((t) => wort.endsWith(t));
    // nur echte Zerlegungen: Vorderteil + (Fuge) + Hinterteil ergibt genau das Wort
    const out = new Set<string>();
    for (const a of vorn) for (const b of hinten) {
      const fuge = wort.slice(a.length, wort.length - b.length);
      if (wort.length - b.length >= a.length && ['', 's', 'es', 'n', 'en', 'e', 'er'].includes(fuge)) { out.add(a); out.add(b); }
    }
    return [...out];
  }

  private anfrageFormen(anfrage: string): string[] {
    const basis = suchformen(anfrage).filter((t) => t.length >= 2);
    const teile = basis.flatMap((t) => this.teilwoerter(t));
    return [...new Set([...basis, ...teile])].slice(0, 32);
  }

  fts(anfrage: string, erlaubt: string[], limit = 50): RohTreffer[] {
    const toks = this.anfrageFormen(anfrage);
    if (!toks.length || !erlaubt.length) return [];
    const match = toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT a.id, a.pfad, a.abschnitt, a.von, a.bis, a.text, d.art, d.titel, bm25(abschnitte_fts, 1.0, 0.6) AS r
         FROM abschnitte_fts JOIN abschnitte a ON a.id = abschnitte_fts.rowid JOIN dateien d ON d.pfad = a.pfad
         WHERE abschnitte_fts MATCH ? AND d.aktiv = 1 AND d.pfad IN (SELECT value FROM json_each(?))
         ORDER BY r, a.id LIMIT ?`,
      )
      .all(match, JSON.stringify(erlaubt), limit) as (RohTreffer & { r: number })[];
    return rows.map((r, i) => ({ ...r, score: -r.r, rangFts: i + 1 }));
  }

  /**
   * Trigramm-Suche für deutsche Komposita („Einbauküche“ findet „Küche“, „Lackraumlüftung“ findet „Lüftung“):
   * Wortteile ab 4 Zeichen als Teilzeichenketten, ODER-verknüpft.
   */
  trigramm(anfrage: string, erlaubt: string[], limit = 50): RohTreffer[] {
    const teile = [...new Set([...stammformen(anfrage), ...suchformen(anfrage)])].filter((t) => t.length >= 4).slice(0, 24);
    if (!teile.length || !erlaubt.length) return [];
    const match = teile.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT a.id, a.pfad, a.abschnitt, a.von, a.bis, a.text, d.art, d.titel, bm25(abschnitte_tri) AS r
         FROM abschnitte_tri JOIN abschnitte a ON a.id = abschnitte_tri.rowid JOIN dateien d ON d.pfad = a.pfad
         WHERE abschnitte_tri MATCH ? AND d.aktiv = 1 AND d.pfad IN (SELECT value FROM json_each(?))
         ORDER BY r, a.id LIMIT ?`,
      )
      .all(match, JSON.stringify(erlaubt), limit) as (RohTreffer & { r: number })[];
    return rows.map((r, i) => ({ ...r, score: -r.r, rangFts: i + 1 }));
  }

  /** Vektorsuche (sqlite-vec `vec_distance_cosine`, sonst JS-Kosinus), nur in erlaubten Pfaden. */
  vektor(q: Float32Array, erlaubt: string[], limit = 50, erzwingeJs = false): RohTreffer[] {
    if (!erlaubt.length) return [];
    let rows: (RohTreffer & { sim: number })[];
    if (this.vecAktiv && !erzwingeJs) {
      rows = this.db
        .prepare(
          `SELECT a.id, a.pfad, a.abschnitt, a.von, a.bis, a.text, d.art, d.titel, 1 - vec_distance_cosine(a.vec, ?) AS sim
           FROM abschnitte a JOIN dateien d ON d.pfad = a.pfad
           WHERE a.vec IS NOT NULL AND length(a.vec) = ? AND d.aktiv = 1 AND d.pfad IN (SELECT value FROM json_each(?))
           ORDER BY sim DESC, a.id LIMIT ?`,
        )
        .all(f32(q), q.byteLength, JSON.stringify(erlaubt), limit) as (RohTreffer & { sim: number })[];
    } else {
      const alle = this.db
        .prepare(
          `SELECT a.id, a.pfad, a.abschnitt, a.von, a.bis, a.text, a.vec, d.art, d.titel
           FROM abschnitte a JOIN dateien d ON d.pfad = a.pfad
           WHERE a.vec IS NOT NULL AND d.aktiv = 1 AND d.pfad IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(erlaubt)) as (RohTreffer & { vec: Buffer })[];
      rows = alle
        .filter((r) => r.vec.byteLength === q.byteLength)
        .map(({ vec, ...r }) => ({ ...r, sim: kosinus(q, vonBlob(vec)) }))
        .sort((a, b) => b.sim - a.sim || a.id - b.id)
        .slice(0, limit);
    }
    return rows.map((r, i) => ({ ...r, score: r.sim, rangVek: i + 1 }));
  }

  /** Alle Fakten aus erlaubten Pfaden. */
  fakten(erlaubt: string[]): (FaktZeile & { pfad: string; titel: string })[] {
    if (!erlaubt.length) return [];
    const rows = this.db
      .prepare(
        `SELECT f.*, d.titel FROM fakten f JOIN dateien d ON d.pfad = f.pfad
         WHERE d.pfad IN (SELECT value FROM json_each(?)) ORDER BY f.gegenstand, f.gilt_ab`,
      )
      .all(JSON.stringify(erlaubt)) as (Omit<FaktZeile, 'wert'> & { wert: string; pfad: string; titel: string })[];
    return rows.map((r) => ({ ...r, wert: JSON.parse(r.wert) as FaktZeile['wert'] }));
  }

  schliessen(): void {
    this.db.close();
  }
}

/** Reciprocal Rank Fusion über mehrere Ranglisten. */
export function rrf(listen: RohTreffer[][], k = 60): RohTreffer[] {
  const m = new Map<number, RohTreffer>();
  for (const liste of listen) {
    liste.forEach((t, i) => {
      const alt = m.get(t.id);
      const beitrag = 1 / (k + i + 1);
      if (alt) {
        alt.score += beitrag;
        if (t.rangFts) alt.rangFts = t.rangFts;
        if (t.rangVek) alt.rangVek = t.rangVek;
      } else m.set(t.id, { ...t, score: beitrag });
    });
  }
  return [...m.values()].sort((a, b) => b.score - a.score || a.id - b.id);
}
