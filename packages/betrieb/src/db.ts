/**
 * leitstand.sqlite: Kunden, Instanzen, Vorgänge, Partner, Zahlungen (Spiegel von Mollie), Prüfprotokoll, Löschbelege.
 * Objekte liegen als JSON je Zeile; die Mengen sind klein (Dutzende bis wenige Hundert), gefiltert wird im Code.
 * Prüfprotokoll und Löschbelege sind nur anhängbar (Trigger verhindern UPDATE und DELETE).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

export function oeffneDb(datei: string): DB {
  if (datei !== ':memory:') fs.mkdirSync(path.dirname(datei), { recursive: true });
  const db = new Database(datei);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kunden (id TEXT PRIMARY KEY, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS instanzen (id TEXT PRIMARY KEY, subdomain TEXT NOT NULL UNIQUE, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS vorgaenge (id TEXT PRIMARY KEY, instanz_id TEXT NOT NULL, erstellt TEXT NOT NULL, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS einstellungen (schluessel TEXT PRIMARY KEY, wert TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS konto_tokens (hash TEXT PRIMARY KEY, instanz_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS loesch_links (hash TEXT PRIMARY KEY, instanz_id TEXT NOT NULL, bis TEXT NOT NULL, benutzt TEXT);
    CREATE TABLE IF NOT EXISTS egress_anfragen (id INTEGER PRIMARY KEY AUTOINCREMENT, instanz_id TEXT NOT NULL, host TEXT NOT NULL, zweck TEXT NOT NULL, am TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offen');
    CREATE TABLE IF NOT EXISTS geplante_wechsel (instanz_id TEXT PRIMARY KEY, nach TEXT NOT NULL, ab TEXT NOT NULL, von TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, admin TEXT NOT NULL, daten TEXT NOT NULL, erstellt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rueckfall (instanz_id TEXT NOT NULL, host TEXT NOT NULL, loeschen_am TEXT NOT NULL, erledigt TEXT, PRIMARY KEY (instanz_id, host));
    CREATE TABLE IF NOT EXISTS partner (code TEXT PRIMARY KEY, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS zahlungen (id TEXT PRIMARY KEY, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS abos (id TEXT PRIMARY KEY, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auszahlungen (partner TEXT NOT NULL, monat TEXT NOT NULL, betrag_cent INTEGER NOT NULL, am TEXT NOT NULL, von TEXT NOT NULL, vermerk TEXT, PRIMARY KEY (partner, monat));
    CREATE TABLE IF NOT EXISTS idempotenz (schluessel TEXT PRIMARY KEY, antwort TEXT NOT NULL, am TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhooks (zahlung_id TEXT NOT NULL, status TEXT NOT NULL, am TEXT NOT NULL, ergebnis TEXT NOT NULL, PRIMARY KEY (zahlung_id, status));
    CREATE TABLE IF NOT EXISTS postausgang (id INTEGER PRIMARY KEY AUTOINCREMENT, schluessel TEXT UNIQUE, an TEXT NOT NULL, betreff TEXT NOT NULL, text TEXT NOT NULL, instanz_id TEXT, am TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'vorgemerkt');
    CREATE TABLE IF NOT EXISTS ereignisse (id INTEGER PRIMARY KEY AUTOINCREMENT, am TEXT NOT NULL, wer TEXT NOT NULL, was TEXT NOT NULL, instanz_id TEXT, daten TEXT);
    CREATE TABLE IF NOT EXISTS loeschbelege (id INTEGER PRIMARY KEY AUTOINCREMENT, daten TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (name TEXT PRIMARY KEY, pw_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, totp_letzter INTEGER NOT NULL DEFAULT 0, erstellt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, name TEXT NOT NULL, erstellt TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS ereignisse_nur_anhaengen_u BEFORE UPDATE ON ereignisse BEGIN SELECT RAISE(ABORT, 'Prüfprotokoll ist nur anhängbar'); END;
    CREATE TRIGGER IF NOT EXISTS ereignisse_nur_anhaengen_d BEFORE DELETE ON ereignisse BEGIN SELECT RAISE(ABORT, 'Prüfprotokoll ist nur anhängbar'); END;
    CREATE TRIGGER IF NOT EXISTS loeschbelege_nur_anhaengen_u BEFORE UPDATE ON loeschbelege BEGIN SELECT RAISE(ABORT, 'Löschbelege sind nur anhängbar'); END;
    CREATE TRIGGER IF NOT EXISTS loeschbelege_nur_anhaengen_d BEFORE DELETE ON loeschbelege BEGIN SELECT RAISE(ABORT, 'Löschbelege sind nur anhängbar'); END;
  `);
  return db;
}
