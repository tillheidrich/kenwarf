/**
 * Datenformen des Leitstands. Grundlage: O1, team2/o1_betrieb/v14-betrieb.md Abschnitt 1.4 (Schnittstelle für A1).
 * Alles, was hier über O1 hinausgeht, ist additiv (neue optionale Felder) und in NOTES/betrieb.md begründet.
 *
 * Grundregel: Die Betreiberseite sieht Betriebsdaten, nie Inhalte einer Kundeninstanz.
 */

export const PRODUKTNAME = process.env.KERN_PRODUKTNAME ?? 'Kern';

/** Wer ist das Konto? Bestimmt Abrechnung, Fristen und was die Heute-Seite meldet. */
export const KONTO_TYPEN = {
  selbstbucher: 'Selbstbucher (Mollie)',
  direkt: 'Selbst akquiriert',
  pitch: 'Pitch / Demo',
  systemhaus: 'Partner / Systemhaus',
  creator: 'Influencer / Creator',
  gemeinnuetzig: 'Schule / Verein (frei)',
  intern: 'Intern / Test',
} as const;
export type KontoTyp = keyof typeof KONTO_TYPEN;

export const KONTO_STATUS = {
  interessent: 'Interessent',
  test: 'In Testphase',
  kunde: 'Kunde',
  pausiert: 'Pausiert',
  beendet: 'Beendet',
} as const;
export type KontoStatus = keyof typeof KONTO_STATUS;

export type Herkunft = { art: 'mollie' | 'formular' | 'manuell' | 'pitch' | 'partner'; empfehlungscode?: string; notiz?: string };

/** O1 „Kunde“, erweitert um Typ, Quelle, Notizen, Status, Zuordnung (additiv). */
export interface Kunde {
  id: string;
  firma: string;
  ansprechpartner: string;
  mail: string;
  telefon?: string;
  rechnungsweg: 'mollie' | 'rechnung' | 'keiner';
  mollie_customer_id?: string;
  av_vertrag?: { version: string; am: string };
  erstellt: string;
  // additiv (A1)
  typ: KontoTyp;
  status: KontoStatus;
  quelle?: string; // z. B. „LinkedIn-Post Oktober“, „Empfehlung Steuerkanzlei“
  notizen?: string;
  /** Empfehlungscode, nur gespeichert, wenn die Person der Zuordnung zugestimmt hat. */
  zuordnung?: { code: string; weg: 'checkout' | 'link' | 'manuell'; zustimmung_am: string };
  /** Kundennummer im vorhandenen Rechnungswerkzeug; die Konsole zeigt nur den Link. */
  rechnung_ref?: string;
  /** Berufsgeheimnisträger (Kanzlei, Steuerberatung, Arztpraxis): Managed nur mit S-12 (CONTRACT v1.4 W33). */
  berufsgeheimnis?: boolean;
}

export const INSTANZ_STATUS = [
  'angelegt', 'test', 'demo', 'aktiv', 'zahlung_offen', 'test_abgelaufen', 'nur_lesen', 'pausiert',
  'umzug_laeuft', 'umgezogen', 'loeschung_geplant', 'geloescht', 'fehler',
  // additiv (A1, Nachtrag Till 06:03): Wechsel der Betriebsstufe läuft, alte Instanz nur lesend
  'wechsel_laeuft',
] as const;
export type InstanzStatus = (typeof INSTANZ_STATUS)[number];

export const STATUS_TEXT: Record<InstanzStatus, string> = {
  angelegt: 'Wird angelegt', test: 'Testphase', demo: 'Pitch / Demo', aktiv: 'Aktiv', zahlung_offen: 'Zahlung offen',
  test_abgelaufen: 'Test abgelaufen', nur_lesen: 'Nur lesen', pausiert: 'Pausiert', umzug_laeuft: 'Umzug läuft',
  umgezogen: 'Umgezogen', loeschung_geplant: 'Löschung geplant', geloescht: 'Gelöscht', fehler: 'Fehler',
  wechsel_laeuft: 'Stufenwechsel läuft',
};

/**
 * Betriebsstufen (Nachtrag Till 06:03). Geteilt: ein eigener Container mit eigenem Datenordner, eigener Datenbank
 * und eigenem Schlüssel je Kunde auf einem gemeinsamen HD-Host. Eigene Maschine: eigene Hetzner-Instanz je Kunde.
 * Test, Demo und Pitch laufen immer auf „geteilt“.
 */
export const STUFEN = { geteilt: 'Geteilt', eigen: 'Eigene Maschine' } as const;
export type Stufe = keyof typeof STUFEN;

export interface Host {
  id: string; // z. B. „geteilt-01“ oder „m-i_abc…“ für eine eigene Maschine
  name: string;
  stufe: Stufe;
  region: Region;
  /** Grenzen, ab denen der Leitstand keine neuen Container mehr auf den Host legt. */
  kapazitaet: { container_max: number; speicher_bytes: number; ram_mb: number };
  aktiv: boolean;
  /** v1.4 3.1: wofür der Host neue Container annimmt (host-01 nur Demo und Pitch). */
  zweck?: ('pitch' | 'test' | 'kunde')[];
  /** Bei eigener Maschine: zu welcher Instanz sie gehört. */
  instanz_id?: string;
  erstellt: string;
}

export interface HostLast {
  container: number;
  speicher_belegt: number;
  speicher_gesamt: number;
  ram_belegt_mb: number;
  ram_gesamt_mb: number;
  /** Quelle der Zahlen: „gemessen“ vom Bereitsteller oder „geschaetzt“ aus Paketgrößen. */
  quelle: 'gemessen' | 'geschaetzt';
}

export const PAKETE = { klein: 'Klein', betrieb: 'Betrieb', team: 'Team' } as const;
export type Paket = keyof typeof PAKETE;

export const REGIONEN = { 'de-nbg': 'Nürnberg (DE)', 'de-fsn': 'Falkenstein (DE)', 'fi-hel': 'Helsinki (FI)' } as const;
export type Region = keyof typeof REGIONEN;

/** Voreinstellung der KI-Anbindung beim Anlegen (additiv). Schlüssel setzt der Kunde selbst in seiner Instanz. */
export const KI_VORLAGEN = {
  mock: 'Ohne KI (Vorführmodus)',
  mistral: 'Mistral (EU, Paris)',
  ionos: 'IONOS AI Model Hub (DE)',
  stackit: 'STACKIT (DE)',
  ollama: 'Lokales Modell (Ollama, im Netz des Kunden)',
  eigener: 'Eigener Schlüssel (OpenAI-kompatibel)',
  anthropic: 'Anthropic (auf ausdrücklichen Wunsch)',
} as const;
export type KiVorlage = keyof typeof KI_VORLAGEN;

/** Beispieldaten für Pitches. „wendt“ liefert @kern/core, „behrens“ liegt in packages/betrieb/beispiele/. */
export const BEISPIELE = {
  'tischlerei-wendt': 'Tischlerei Wendt (Handwerk, 5 Personen)',
  'kanzlei-behrens': 'Kanzlei Behrens (Rechtsanwälte, § 203 StGB)',
} as const;
export type Beispiel = keyof typeof BEISPIELE;

export interface Betriebsdaten {
  /** v1.4 3.4: Modus, KI-Verbrauch und Kontingent, Zahl der OAuth-Zugänge. Weiter keine Pfade, keine Namen. */
  modus: 'normal' | 'nur_lesen' | 'pausiert';
  ki_verbrauch_cent_monat: number;
  ki_kontingent_cent_monat: number | null;
  zugaenge_oauth: number;
  speicher_bytes: number;
  benutzer: number;
  letzte_anmeldung_tag: string | null; // nur Datum, kein Name
  backup_letztes: string | null;
  backup_ok: boolean;
  health: 'ok' | 'warnung' | 'aus';
}

export interface Instanz {
  id: string;
  kunde_id: string | null;
  subdomain: string;
  url: string;
  status: InstanzStatus;
  herkunft: Herkunft;
  paket: Paket;
  region: Region;
  test_ende: string | null;
  loeschen_am: string | null;
  erstellt: string;
  geaendert: string;
  version: string;
  betrieb: Betriebsdaten;
  // additiv (A1)
  ki_vorlage: KiVorlage;
  beispiel: Beispiel | null;
  /** Status vor pausiert / loeschung_geplant, damit Fortsetzen und Abbruch zurückfinden. */
  vorher: InstanzStatus | null;
  zahlung: 'mollie' | 'rechnung' | 'test' | 'frei';
  kulanz_bis: string | null;
  stufe: Stufe;
  host: string;
  // v1.4 3.2 additiv
  kuendigung_zum: string | null;
  test_selbst_verlaengert: boolean;
  ki: { weg: 'hd_test' | 'eigener_schluessel' | 'app' | 'ohne'; egress_freigaben: string[] };
}

export interface Schritt { name: string; status: 'wartet' | 'laeuft' | 'fertig' | 'fehler' | 'uebersprungen'; am?: string; meldung?: string }
export interface Vorgang {
  id: string;
  art: 'instanz_anlegen' | 'export' | 'umzug' | 'loeschen' | 'update' | 'wiederherstellen_test' | 'stufenwechsel';
  instanz_id: string;
  status: 'wartet' | 'laeuft' | 'fertig' | 'fehler';
  schritte: Schritt[];
  ausgeloest_von: string;
  erstellt: string;
  ergebnis?: Record<string, unknown>;
}

export const PARTNER_ARTEN = { influencer: 'Influencer / Creator', systemhaus: 'Systemhaus', empfehler: 'Empfehler', kunde: 'Kunde empfiehlt' } as const;
export interface Partner {
  code: string;
  name: string;
  art: keyof typeof PARTNER_ARTEN;
  mail?: string;
  vereinbarung?: string;
  aktiv: boolean;
  // additiv (A1): Grundlage der Auszahlungsliste, ausgezahlt wird von Hand
  provision_prozent: number;
  laufzeit_monate: number;
  kunde_id?: string;
}

export interface Ereignis { id: number; am: string; wer: string; was: string; instanz_id?: string; daten?: Record<string, unknown> }

export interface Loeschbeleg {
  id: number;
  instanz_id: string;
  subdomain: string;
  firma: string | null;
  grund: string;
  angekuendigt_am: string | null;
  geloescht_am: string;
  von: string;
  export_angeboten: boolean;
  nachweis: string; // was gelöscht wurde: Container, Volume, Schlüssel, Backups (Frist)
}

export interface Zahlung {
  id: string; // tr_…
  kunde_id: string | null;
  instanz_id: string | null;
  abo_id: string | null;
  betrag_cent: number;
  waehrung: string;
  status: 'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired';
  art: 'first' | 'recurring' | 'oneoff';
  am: string;
  /** Entwurf im Rechnungswerkzeug (v1.4 3.6); festgeschrieben nur mit S-9. */
  rechnung?: { entwurf: string; link?: string; festgeschrieben: boolean };
}
export interface Abo { id: string; kunde_id: string | null; status: 'pending' | 'active' | 'canceled' | 'suspended' | 'completed'; betrag_cent: number; intervall: string; naechste: string | null }

export interface Auszahlungszeile { partner: string; name: string; monat: string; kunde: string; zahlung_id: string; betrag_cent: number; provision_cent: number; status: 'offen' | 'ausgezahlt'; ausgezahlt_am: string | null }

export class LeitstandFehler extends Error {
  constructor(public code: 'ungueltig' | 'nicht_gefunden' | 'konflikt' | 'nicht_erlaubt' | 'intern', meldung: string) {
    super(meldung);
  }
}
