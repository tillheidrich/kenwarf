/**
 * Spiegel der öffentlichen API von @kern/core laut CONTRACT.md v1.
 * Der Server programmiert ausschließlich gegen diese Typen. So lässt er sich
 * mit der Attrappe (KERN_FAKE=1) und mit dem echten Kern gleich betreiben.
 */

export type Rolle = 'leser' | 'autor' | 'freigeber' | 'admin';
export type Sichtbarkeit = 'ich' | `team:${string}` | 'betrieb';
export type Reichweite = 'ich' | 'team' | 'betrieb';

export type ProviderConfig =
  | { art: 'mock' }
  | { art: 'ollama'; url: string; chatModell: string; embedModell: string }
  | { art: 'openai'; url: string; apiKey: string; chatModell: string; embedModell: string }
  | { art: 'anthropic'; apiKey: string; chatModell: string; embed: ProviderConfig };

export interface KernConfig {
  dataDir: string;
  provider: ProviderConfig;
  betrieb: string;
  sprache: 'de' | 'en';
}

export interface User {
  id: string;
  name: string;
  rollen: Rolle[];
  teams: string[];
}

export interface Fundstelle {
  quelle: string;
  abschnitt: string;
  zeilen: [number, number];
  zitat: string;
}

export interface ArtikelKopf {
  titel: string;
  gruppe: string;
  kurzfassung: string;
  stand: string;
  verantwortlich: string;
  pruefen_bis: string | null;
  sichtbarkeit: Sichtbarkeit;
  besitzer: string;
  fundstellen: { quelle: string; abschnitt: string; zeilen: [number, number] }[];
  status: 'entwurf' | 'freigegeben';
  [k: string]: unknown;
}

export interface QuellenKopf {
  titel: string;
  art: 'datei' | 'text' | 'web' | 'audio' | 'notiz';
  herkunft: string;
  erfasst_am: string;
  erfasst_von: string;
  sichtbarkeit: Sichtbarkeit;
  sammlung: string;
  hash: string;
  ersetzt: string | null;
  beobachtet: boolean;
  [k: string]: unknown;
}

export interface Artikel { pfad: string; kopf: ArtikelKopf; text: string; }
export interface Quelle { pfad: string; kopf: QuellenKopf; text: string; }

export interface Treffer {
  pfad: string;
  art: 'wissen' | 'quelle';
  titel: string;
  abschnitt: string;
  zeilen: [number, number];
  ausschnitt: string;
  score: number;
}

export interface Antwort {
  status: 'beantwortet' | 'steht_nicht_drin' | 'gehoert_nicht_hierher';
  punkte: { text: string; belege: number[] }[];
  belege: Fundstelle[];
  hinweis: string;
}

export interface Vorschlag {
  id: string;
  /** v1.4.1 (U10): `nachtrag` = nur angehängt. */
  art: 'neu' | 'aenderung' | 'loeschung' | 'nachtrag';
  ziel: string;
  alt: string | null;
  neu: string;
  grund: string;
  von: string;
  erstellt: string;
  /** v1.2: `konflikt`, wenn die Zieldatei seit dem Vorschlag geändert wurde. */
  status: 'offen' | 'freigegeben' | 'abgelehnt' | 'konflikt';
  entscheidung?: { von: string; am: string; begruendung?: string };
  /** v1.2: Hash der Zieldatei beim Erstellen des Vorschlags. */
  basis_hash?: string | null;
  /** Quelle, aus der der Vorschlag stammt (Kompilieren, Import). */
  quelle?: string;
}

export interface HinzufuegenEingabe {
  art: 'datei' | 'text' | 'web' | 'audio' | 'notiz';
  titel?: string;
  inhalt?: string;
  dateiPfad?: string;
  url?: string;
  sammlung: string;
  sichtbarkeit: Sichtbarkeit;
  beobachten?: boolean;
  /** v1.4.1 U8: Herkunft für den Quellenkopf (z. B. Outline-Adresse). */
  herkunft?: string;
  /** v1.4.1 U8: Kennung im Fremdsystem; gleiche ID in derselben Sammlung ersetzt die alte Fassung. */
  extern_id?: string;
  /** v1.4.1 U8: weitere Kopffelder (Pflichtfelder schützt core, höchstens 8 KB). */
  zusatz?: Record<string, unknown>;
}

/** v1.4.1 U10: Filter der Sammelfreigabe (core `entscheideSammel`). */
export interface SammelFilter { ids?: string[]; grund?: string; quelle?: string; von?: string; art?: Vorschlag['art'] }
export interface SammelErgebnis { erledigt: Vorschlag[]; konflikte: Vorschlag[]; fehler: { id: string; meldung: string }[] }

export interface Entscheidung {
  aktion: 'freigeben' | 'ablehnen' | 'aendern';
  begruendung?: string;
  neuerText?: string;
}

export interface Briefing { datum: string; text: string; entscheidungen: string[]; links: string[]; }
export interface VerlaufEintrag { commit: string; von: string; am: string; grund: string; }

/** Nachtrag v1.1: Faktenschicht. Annahme zur genauen Form siehe NOTES/server.md. */
export type FaktArt = 'preis' | 'frist' | 'zustaendigkeit' | 'kennzahl' | 'kontakt' | 'regel';
export interface Fakt {
  id: string;
  art: FaktArt | string;
  gegenstand: string;
  wert: string | number | boolean;
  einheit?: string | null;
  gilt_ab?: string | null;
  gilt_bis?: string | null;
  ersetzt?: string | null;
  /** Kennung aus `fundstellen` des Artikels. */
  fundstelle: string;
  /** Von core gesetzt: Artikelpfad, Titel, Gültigkeit am Stichtag, aufgelöste Fundstelle. */
  artikel?: string;
  artikelTitel?: string;
  gueltig?: boolean;
  beleg?: Fundstelle | null;
  [k: string]: unknown;
}

/** Nachtrag v1.1: Befund aus `pruefe()` (Form wie in packages/core/src/types.ts). */
export type BefundArt = 'widerspruch' | 'fakt_abgelaufen' | 'fakt_laeuft_ab' | 'pruefung_faellig' | 'fundstelle_kaputt' | 'zu_gross' | 'verwaist' | 'kopf_fehlerhaft' | 'index_veraltet';
export interface Befund {
  art: BefundArt | (string & {});
  pfad: string;
  text: string;
  /** ID eines mechanischen Vorschlags im Eingang, falls angelegt. */
  vorschlag?: string;
}

/** Schwere eines Befunds für Berichte (Server-/CLI-seitige Einordnung). */
export function schwereVon(art: string): 'fehler' | 'warnung' | 'hinweis' {
  if (['widerspruch', 'fundstelle_kaputt', 'kopf_fehlerhaft'].includes(art)) return 'fehler';
  if (['fakt_abgelaufen', 'pruefung_faellig', 'index_veraltet', 'fakt_laeuft_ab'].includes(art)) return 'warnung';
  return 'hinweis';
}

/** Die Instanz-Schnittstelle der Klasse `Kern` aus @kern/core. */
export interface KernLike {
  // Nachtrag v1.1 (optional, damit der Server auch mit einem core v1 startet; fehlt es: 501)
  fakten?(u: User, filter?: { art?: string; gegenstand?: string; gueltigAm?: string }): Promise<Fakt[]>;
  pruefe?(u: User): Promise<Befund[]>;
  exportiereOkf?(zielOrdner: string, opt?: { mitPrivat?: boolean; fuer?: User }): Promise<unknown>;
  loescheEndgueltig?(u: User, pfad: string, grund: string): Promise<{ entfernt: string[]; commit: string | null }>;
  beispielLaden?(u: User): Promise<unknown>;
  beispielEntfernen?(u: User): Promise<unknown>;
  importiereOkf?(u: User, quellOrdner: string): Promise<unknown>;
  // Nachtrag v1.2 und Erweiterungen von core (alle optional)
  importiere?(u: User, e: { art: ImportArt; pfad: string }): Promise<unknown>;
  beobachteQuellen?(u: User): Promise<unknown>;
  aktualisiereBeobachtete?(u: User): Promise<unknown>;
  datenweg?(u?: User): Promise<unknown> | unknown;
  leseQuelle?(u: User, pfad: string): Promise<Quelle>;
  leseVorschlag?(u: User, id: string): Promise<Vorschlag>;
  original?(u: User, pfad: string): Promise<{ datei: string; name: string; ext: string } | null>;
  leseEinstellungen?(u?: User): Promise<Record<string, unknown>>;
  speichereEinstellungen?(u: User, aenderung: Record<string, unknown>): Promise<Record<string, unknown>>;
  schliesse?(): Promise<void>;
  reindex(): Promise<{ dateien: number; abschnitte: number }>;
  listeWissen(u: User, filter?: { gruppe?: string }): Promise<Artikel[]>;
  leseArtikel(u: User, pfad: string): Promise<Artikel>;
  listeQuellen(u: User, filter?: { sammlung?: string }): Promise<Quelle[]>;
  suche(u: User, q: string, opt?: { reichweite?: Reichweite; sammlung?: string; limit?: number }): Promise<Treffer[]>;
  frage(u: User, frage: string, opt?: { reichweite?: Reichweite; sammlung?: string }): Promise<Antwort>;
  fuegeHinzu(u: User, eingabe: HinzufuegenEingabe): Promise<{ quelle: Quelle; vorschlaege: Vorschlag[] }>;
  kompiliere(u: User, quellPfad: string): Promise<Vorschlag[]>;
  eingang(u: User, opt?: { alle?: boolean }): Promise<Vorschlag[]>;
  entscheide(u: User, id: string, e: Entscheidung): Promise<Vorschlag>;
  schlageVor(u: User, v: Omit<Vorschlag, 'id' | 'status' | 'erstellt' | 'von'>, opt?: { agent?: string }): Promise<Vorschlag>;
  /** v1.4.1 U10 (E1): Nachtrag (Text wird angehängt, Art `nachtrag`). */
  nachtrag?(u: User, a: { ziel: string; text: string; grund: string; quelle?: string }, opt?: { agent?: string }): Promise<Vorschlag>;
  /** v1.4.1 U10 (E1): Sammelfreigabe, jeder Vorschlag einzeln über `entscheide`. */
  entscheideSammel?(u: User, filter: SammelFilter, e: { aktion: 'freigeben' | 'ablehnen'; begruendung?: string }): Promise<SammelErgebnis>;
  /** v1.4 8.5 (E1): abgelaufene eigene Agenten-Notizen (Pfade relativ zu /memories/notizen). */
  notizenAblauf?(u: User): Promise<string[]>;
  briefing(u: User, seit?: string): Promise<Briefing>;
  faellig(u: User): Promise<Artikel[]>;
  verlauf(pfad: string): Promise<VerlaufEintrag[]>;
  beobachteOrdner(onChange?: (pfade: string[]) => void): () => void;
  benutzer: {
    anlegen(name: string, passwort: string, rollen: Rolle[], teams?: string[]): Promise<User>;
    pruefe(name: string, passwort: string): Promise<User | null>;
    liste(): Promise<User[]>;
    /** Erweiterungen von core (optional). */
    hole?(id: string): Promise<BenutzerDetail | null>;
    aendere?(id: string, a: { rollen?: Rolle[]; teams?: string[]; passwort?: string; mussPasswortAendern?: boolean }): Promise<User>;
    aenderePasswort?(id: string, alt: string, neu: string): Promise<User>;
    loesche?(id: string): Promise<void>;
  };
  // ---- v1.4, mit C1 (core) abgestimmt 24.10.2026 (NOTES/server.md); alle optional, fehlt eine: 501 ----
  /** 7.1: Export in eine Datei, Rechte nach 7.1/N1 prüft core. */
  exportiere?(u: User, e: { art: ExportArt; ziel: string; passphrase?: string }): Promise<{ datei: string; bytes: number; sha256: string; ausgelassen?: number }>;
  beispielGeladen?(): boolean | Promise<boolean>;
  /** 3.4: Verbrauchszähler aus `.kern/zaehler.sqlite`, ohne Personen. */
  verbrauch?(): Promise<{ monat: string; cent_monat: number; cent_heute: number }>;
  /** 4.1: höchstens 3 Vorschlagsfragen, deterministisch. */
  vorschlagsfragen?(u: User): Promise<string[]>;
  /** 4.1: „Verbindung testen“. */
  pruefeVerbindung?(p: ProviderConfig): Promise<{ ok: boolean; meldung: string }>;
  /** Anbieter zur Laufzeit wechseln (ohne Neustart). */
  setzeProvider?(p: ProviderConfig): Promise<void> | void;
  /** 8.1 (E1): Prüfbank. */
  pruefbank?(u: User, opt: { satz: 'oeffentlich' | 'betrieb'; anbieter?: ProviderConfig }): Promise<PruefbankLauf>;
  pruefbankLaeufe?(u: User): Promise<PruefbankLauf[]>;
  pruefbankSchaetzung?(u: User, o: { satz: 'oeffentlich' | 'betrieb' }): Promise<{ fragen: number; tokens: number; cent: number | null }>;
  /** 8.5 (E1): Claude-Memory-Tool-Befehle. */
  gedaechtnis?(u: User, befehl: Record<string, unknown>, opt?: { agent?: string; reichweite?: Reichweite | null }): Promise<{ ok: boolean; text: string; vorschlaege?: Vorschlag[] }>;
  /** 9 (E1): Kontextbilanz. */
  kontextbilanz?(u: User): Promise<Record<string, unknown>>;
  /** 7.3: Ausstiegsprobe, schreibt `pruefung/ausstieg/<datum>.json`. */
  ausstiegsprobe?(u: User): Promise<{ am: string; bestanden: boolean; [k: string]: unknown }>;
  /** 8.3 (E2): Kontextpaket. */
  kontextpaket?(u: User, a: { frage?: string; thema?: string; budgetTokens: number; mitFakten?: boolean; reichweite?: Reichweite }): Promise<Record<string, unknown>>;
  /** Index je Ordner nach Rechten (N1), für MCP-Ressourcen und `kern_wegweiser`. */
  ordnerIndex?(u: User, ordner: string): Promise<string>;
  // v1.3 (Lese-Engpass), soweit core sie hat
  heute?(u: User, opt?: { stil?: string; seit?: string }): Promise<Record<string, unknown>>;
  lesestand?(u: User, e: { objekt: string; punkt?: string; stufe: 1 | 2 | 3 | 4 }): Promise<void>;
  lesebilanz?(u: User): Promise<Record<string, unknown>>;
  setzeLeseEinstellungen?(u: User, e: Record<string, unknown>): Promise<Record<string, unknown>>;
  ansicht?(u: User, a: { zweck: string; thema?: string; pfade?: string[]; seit?: string }): Promise<Record<string, unknown>>;
  /** Gemeinsamer Tokenspeicher von core (Sitzungen, API/MCP, OAuth). Fehlt er: Ersatz im Server. */
  zugang?: unknown;
}

/** Benutzer mit Zustandsfeldern aus core (C1): Pflicht zum Passwortwechsel, Zähler für Zugangswechsel. */
export interface BenutzerDetail extends User {
  mussPasswortAendern?: boolean;
  zugangsStand?: number;
}

export type ImportArt = 'obsidian' | 'notion' | 'outline' | 'confluence' | 'markdown' | 'okf' | 'kern-zip';
export const IMPORT_ARTEN: readonly ImportArt[] = ['obsidian', 'notion', 'outline', 'confluence', 'markdown', 'okf', 'kern-zip'];
export type ExportArt = 'okf' | 'zip' | 'umzugspaket';

/** v1.4 8.1 */
export interface PruefbankKennzahlen { trefferAt5: number; belegtreue: number; enthaltung: number; lecks: number; zeitTreue: number; injektionsfest: number; falscherNachbar: number; thema: number }
export interface PruefbankLauf {
  id: string; am: string; satz: 'oeffentlich' | 'betrieb';
  anbieter: string; modell: string; embedModell: string | null;
  kennzahlen: PruefbankKennzahlen;
  kategorien: Record<string, { fragen: number; bestanden: number }>;
  schwellen: { belegtreue: number; lecks: number; injektionsfest: number };
  bestanden: boolean; dauerSek: number; kostenCent: number | null;
  richter?: { modell: string; beantwortet: number; hinweis: string };
}

/** v1.2: reservierte Dateinamen, die nie als Artikel angelegt werden. */
export const RESERVIERTE_NAMEN = ['index.md', 'log.md'] as const;
export const REGEL_ORDNER = 'wissen/_regeln/';

export const ROLLEN: readonly Rolle[] = ['leser', 'autor', 'freigeber', 'admin'];
