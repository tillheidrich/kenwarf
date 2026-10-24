/**
 * Bereitsteller: die einzige Stelle, an der der Leitstand Instanzen physisch anfasst.
 * Abgeleitet aus O1 v14-betrieb.md 1.2 (Schritte von instanz_anlegen) und 1.7 (Betriebs-Endpunkte je Instanz).
 *
 * Harte Regel: Keine Methode liefert Inhalte (Titel, Dateinamen, Texte, Fragen). `status()` gibt nur Zahlen zurück,
 * der Leitstand filtert zusätzlich über `nurBetriebsdaten()`, damit auch eine fehlerhafte Umsetzung nichts durchreicht.
 */
import type { Beispiel, Betriebsdaten, HostLast, KiVorlage, Paket, Region, Stufe } from '../typen.js';

export interface Auftrag {
  id: string; // i_xxxxxxxxxx, auch Container- und Volume-Name
  subdomain: string;
  paket: Paket;
  region: Region;
  ki_vorlage: KiVorlage;
  beispiel: Beispiel | null;
  admin_mail: string | null;
  stufe: Stufe;
  /** Host, auf dem der Container laufen soll. Bei „eigen“ legt der Schritt `volume_anlegen` die Maschine an. */
  host: string;
  /** v1.4 3.5: Konto-Token der Instanz im Klartext (geht nur in die Umgebung der Instanz, im Leitstand nur der Hash). */
  konto_token: string;
}

export interface Grenzen { nutzer_max: number; speicher_max_bytes: number; upload_max_bytes: number; ki_kontingent_cent_monat: number | null; ki_tagesdeckel_cent: number | null }

/** Stufenwechsel Geteilt ↔ Eigene Maschine: derselbe Ablauf wie ein Umzug, nur innerhalb von HD. */
export interface Wechselauftrag {
  id: string;
  subdomain: string;
  paket: Paket;
  region: Region;
  von: { stufe: Stufe; host: string };
  nach: { stufe: Stufe; host: string };
}

export interface StatusAntwort extends Betriebsdaten {
  version: string;
}

export type Modus = 'normal' | 'nur_lesen' | 'pausiert';

/**
 * Ergebnis eines Anlage-Schritts. `einladung` trägt das Einmalpasswort des ersten Admins; der Leitstand schickt es nur
 * per Mail an die Admin-Adresse und speichert es nicht im Vorgang (der Postausgang leert den Text nach dem Versand).
 */
export interface SchrittErgebnis {
  meldung?: string; url?: string; version?: string; einladung?: { mail: string; einmalPasswort: string };
  /** Zufällige Passwörter der Demo-Zugänge (Pitch). Der Leitstand zeigt sie genau einmal in der Konsole, speichert und protokolliert sie nie. */
  demo_zugaenge?: DemoZugang[];
}
export interface DemoZugang { name: string; passwort: string; rollen: string[] }

export interface Bereitsteller {
  readonly name: string;
  /** Schrittnamen in Reihenfolge (für die Vorgangsanzeige). */
  readonly schritte: readonly string[];
  /** Schritte je Stufe (Eigene Maschine hat andere Schritte als ein Container). Fehlt die Methode, gilt `schritte`. */
  schritteFuer?(stufe: Stufe): readonly string[];
  /** Regelmäßige Wartung (z. B. verwaiste Server nach 30 Minuten löschen). Liefert Meldungen ohne Inhalte. */
  wartung?(): Promise<string[]>;
  /** Führt einen Schritt aus. Muss wiederholbar sein (idempotent), weil ein gescheiterter Vorgang wiederholt wird. */
  schritt(name: string, a: Auftrag): Promise<SchrittErgebnis>;
  status(id: string): Promise<StatusAntwort>;
  modus(id: string, m: Modus): Promise<void>;
  /** Legt das Paket in der Instanz ab; der Download-Link geht nur an den Admin der Instanz, nie an den Leitstand. */
  export(id: string, art: 'umzugspaket' | 'okf'): Promise<{ bytes: number; sha256: string }>;
  beispiel(id: string, aktion: 'laden' | 'entfernen', satz: Beispiel | null): Promise<void>;
  einladung(id: string, mail: string): Promise<void>;
  /** Löscht Container, Volume, Schlüssel. Liefert eine Liste dessen, was gelöscht wurde (für den Löschbeleg). */
  loeschen(id: string): Promise<string[]>;

  /** Schritte eines Stufenwechsels in Reihenfolge. */
  readonly wechselSchritte: readonly string[];
  /**
   * Führt einen Wechselschritt aus. `pruefen` muss die Prüfsumme des Datenbestands an beiden Orten liefern
   * (`ergebnis.alt`, `ergebnis.neu`); der Leitstand vergleicht und schaltet nur bei Gleichheit um.
   */
  wechselSchritt(name: string, w: Wechselauftrag): Promise<{ meldung?: string; ergebnis?: Record<string, string | number> }>;
  /** Macht einen gescheiterten Wechsel rückgängig: Ziel weg, Quelle wieder normal. */
  wechselRueckbau(w: Wechselauftrag): Promise<void>;
  /** Löscht die angehaltene alte Instanz nach Ablauf der Rückfallfrist. */
  altLoeschen(id: string, host: string): Promise<string[]>;
  /** v1.4 3.4: `POST /_betrieb/grenzen`. */
  grenzen(id: string, g: Grenzen): Promise<void>;
  /** v1.4 3.6/3.7: erlaubte zusätzliche KI-Ziele für den Egress-Proxy dieser Instanz. */
  egress(id: string, hosts: string[]): Promise<void>;
  /** Gemessene Auslastung eines Hosts, falls der Bereitsteller sie kennt. */
  hostLast?(host: string): Promise<Partial<HostLast> | null>;
}

export const WECHSEL_SCHRITTE = [
  'ziel_bereitstellen', 'alt_nur_lesen', 'paket_bauen', 'uebertragen', 'einspielen', 'pruefen', 'umschalten', 'alt_anhalten',
] as const;

export const STANDARD_SCHRITTE = [
  'subdomain_pruefen', 'schluessel_erzeugen', 'volume_anlegen', 'container_starten', 'healthz_warten', 'admin_einladen', 'beispiel_laden',
] as const;

/** Schneidet alles ab, was keine Betriebszahl ist. */
export function nurBetriebsdaten(s: Partial<StatusAntwort> & Record<string, unknown>): StatusAntwort {
  const zahl = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
  const tag = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  const iso = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : null);
  const health = s.health === 'ok' || s.health === 'warnung' || s.health === 'aus' ? s.health : 'warnung';
  const version = typeof s.version === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(s.version) ? s.version : 'unbekannt';
  const modus = s.modus === 'nur_lesen' || s.modus === 'pausiert' ? s.modus : 'normal';
  return {
    version,
    modus,
    ki_verbrauch_cent_monat: zahl(s.ki_verbrauch_cent_monat),
    ki_kontingent_cent_monat: s.ki_kontingent_cent_monat === null || s.ki_kontingent_cent_monat === undefined ? null : zahl(s.ki_kontingent_cent_monat),
    zugaenge_oauth: zahl(s.zugaenge_oauth),
    speicher_bytes: zahl(s.speicher_bytes),
    benutzer: zahl(s.benutzer),
    letzte_anmeldung_tag: tag(s.letzte_anmeldung_tag),
    backup_letztes: iso(s.backup_letztes),
    backup_ok: s.backup_ok === true,
    health,
  };
}
