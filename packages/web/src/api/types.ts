// JSON-Formen aus CONTRACT.md v1. Felder, die über den Vertrag hinausgehen, sind optional
// und in kern/NOTES/web.md als Annahme notiert.

export type Rolle = 'leser' | 'autor' | 'freigeber' | 'admin';
export type Sichtbarkeit = 'ich' | `team:${string}` | 'betrieb';
export type Reichweite = 'ich' | 'team' | 'betrieb';

export interface User {
  id: string;
  name: string;
  rollen: Rolle[];
  teams: string[];
  /** Server F1: nach Zurücksetzen durch den Admin muss zuerst ein eigenes Passwort gesetzt werden */
  mussPasswortAendern?: boolean;
  /** v1.4 3.2, Annahme W2: Modus der Instanz kommt mit GET /api/ich */
  modus?: 'normal' | 'nur_lesen' | 'pausiert';
  /** S2 (GET /api/ich): Zusatzfelder für die Oberfläche */
  produkt?: { name: string };
  ki?: { status: KiStatus; weg: KiWeg | null; voreinstellung: string | null; vorher: boolean };
  einrichtung_offen?: boolean;
  konto_verfuegbar?: boolean;
  provider?: ProviderArt;
  hinweis?: string | null;
  darf?: { hinzufuegen: boolean; vorschlagen: boolean; entscheiden: boolean; verwalten: boolean };
}

export interface FundstelleKopf {
  /** v1.1: im Artikeltext als Fußnote [^id] referenziert */
  id?: string;
  quelle: string;
  abschnitt: string;
  zeilen: [number, number];
}

export interface Fundstelle extends FundstelleKopf {
  zitat: string;
  /** core (S1 M4): Beleg stammt aus einer Web-Quelle */
  web?: boolean;
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
  fundstellen: FundstelleKopf[];
  status: 'entwurf' | 'freigegeben' | 'veraltet';
  /** v1.1 (OKF-Nähe) */
  type?: 'Artikel' | 'Faktenblatt' | 'Quelle' | string;
  generated?: { by: string; at: string };
  verified?: { by: string; at: string; commit?: string }[];
  fakten?: Fakt[];
}

export type FaktArt = 'preis' | 'frist' | 'zustaendigkeit' | 'kennzahl' | 'kontakt' | 'regel';

/** v1.1 Faktenschicht. `artikel` ist eine Annahme für GET /api/fakten (woher der Fakt stammt). */
export interface Fakt {
  id: string;
  art: FaktArt;
  gegenstand: string;
  wert: string;
  einheit?: string;
  gilt_ab?: string | null;
  gilt_bis?: string | null;
  ersetzt?: string | null;
  fundstelle: string;
  artikel?: string;
}

/** v1.1 Ergebnis eines Prüflaufs. Form ist eine Annahme, siehe NOTES/web.md. */
export interface Befund {
  art: string;
  text: string;
  pfad?: string;
  schwere?: 'hinweis' | 'warnung' | 'fehler';
}

export interface PruefErgebnis {
  befunde: Befund[];
  vorschlaege: number;
}

export interface Artikel {
  pfad: string;
  kopf: ArtikelKopf;
  text: string;
}

export type QuellenArt = 'datei' | 'text' | 'web' | 'audio' | 'notiz';

export interface QuellenKopf {
  titel: string;
  art: QuellenArt;
  herkunft: string;
  erfasst_am: string;
  erfasst_von: string;
  sichtbarkeit: Sichtbarkeit;
  sammlung: string;
  hash: string;
  ersetzt: string | null;
  beobachtet: boolean;
  beobachtung?: Beobachtung;
}

export interface Quelle {
  pfad: string;
  kopf: QuellenKopf;
  text: string;
}

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
  punkte: { text: string; belege: number[]; /** core: Stützprüfung des Punkttexts gegen das Zitat */ gestuetzt?: 'ja' | 'teilweise' | 'unklar' }[];
  belege: Fundstelle[];
  hinweis: string;
  /** v1.4 D-L13 (Art. 50 KI-VO) */
  ki_erzeugt?: boolean;
  modell?: KiModell | null;
}

export interface KiModell {
  anbieter: string;
  name: string;
}

export interface Vorschlag {
  id: string;
  art: 'neu' | 'aenderung' | 'loeschung';
  ziel: string;
  alt: string | null;
  neu: string;
  grund: string;
  von: string;
  erstellt: string;
  status: 'offen' | 'freigegeben' | 'abgelehnt' | 'konflikt';
  entscheidung?: { von: string; am: string; begruendung?: string };
  /** v1.2: Hash der Zieldatei beim Erstellen; weicht er bei Freigabe ab, wird der Status `konflikt`. */
  basis_hash?: string;
}

/** v1.2 Datenweg. Form ist eine Annahme für GET /api/datenweg, siehe NOTES/web.md. */
export interface Datenweg {
  art: ProviderArt;
  anbieter: string;
  endpunkt: string | null;
  region: string | null;
  lokal: boolean;
  /** Welche Daten gehen hin, in Klartext, z. B. "Frage und die gefundenen Abschnitte" */
  daten: string[];
  /** Was nie hingeht */
  nie?: string[];
  hinweis?: string;
  /** v1.4 6.4: verbundene Apps als eigene Datenwege (Annahme W2 zur Form) */
  apps?: { name: string; anbieter: string | null }[];
}

export type ImportArt = 'obsidian' | 'notion' | 'outline' | 'confluence' | 'markdown' | 'okf' | 'kern-zip';

/** v1.2 Status der Quellenbeobachtung. Annahme: optional im Quellen-Kopf. */
export interface Beobachtung {
  zuletzt_geprueft: string | null;
  status: 'ok' | 'geaendert' | 'nicht_abrufbar' | 'wartet';
  meldung?: string;
}

export interface Briefing {
  datum: string;
  text: string;
  entscheidungen: string[];
  links: string[];
}

export interface VerlaufEintrag {
  commit: string;
  von: string;
  am: string;
  grund: string;
}

export type ProviderArt = 'mock' | 'ollama' | 'openai' | 'anthropic';

/** Annahme (nicht im Vertrag): Form von GET/PUT /api/einstellungen. Schlüssel kommen nie zurück. */
export interface Einstellungen {
  betrieb: string;
  sprache: 'de' | 'en';
  teams: string[];
  sammlungen?: string[];
  provider: {
    art: ProviderArt;
    /** Für Nicht-Admins liefert der Server null (S1 N6) */
    url?: string | null;
    chatModell?: string | null;
    embedModell?: string | null;
    /** Managed-Betrieb: Eintrag aus der Anbieterliste von HD statt freier Adresse (S1 H2) */
    anbieter?: string;
    /** true, wenn ein API-Schlüssel gespeichert ist */
    hatSchluessel?: boolean;
    /** nur beim Speichern gesetzt */
    apiKey?: string;
  };
  marke?: { akzent?: string; logo?: string };
  /** v1.3.1: Standard-Lesestil für neue Nutzer (nie erzwungen) */
  standard_lesestil?: Lesestil;
  /** Server F1: Instanz wird von HD betrieben */
  managed?: boolean;
  /** Server F1: nur im Managed-Betrieb, freigegebene Anbieter */
  anbieterListe?: KiAnbieter[];
  /** v1.4 8.2: Prüfstatus des KI-Anbieters (aus kern.yaml ki.status); Annahme W2: kommt über GET /api/einstellungen */
  ki?: { status: KiStatus; weg?: KiWeg | null; voreinstellung?: string | null; vorher?: boolean };
  /** v1.4 5.1; Annahme W2: Liste der Voreinstellungen kommt mit GET /api/einstellungen */
  voreinstellungen?: KiVoreinstellung[];
}

export type KiStatus = 'ohne_ki' | 'ungeprueft' | 'geprueft' | 'unter_schwelle';
export type KiWeg = 'hd_test' | 'eigener_schluessel' | 'app' | 'ohne';

/** v1.4 5.1 */
export interface KiVoreinstellung {
  id: 'hd_test' | 'mistral' | 'ionos' | 'stackit' | 'scaleway' | 'ovhcloud' | 'ollama' | 'llamacpp' | 'vllm' | 'anthropic' | 'openai' | 'google';
  name: string;
  art: ProviderArt;
  url: string;
  chatModelle: string[];
  embedModelle: string[];
  region: 'lokal' | 'eu' | 'usa' | 'unbekannt';
  quelle_geprueft: string | null;
  managed_erlaubt: boolean;
  /** S2: ein Satz zum Datenfluss (bei USA mit Drittland), neutral anzeigen */
  datenfluss?: string;
}

/** v1.4 4.1 */
export interface Einrichtung {
  schritt: 'ki' | 'unterlagen' | 'erste_frage' | 'fertig';
  ki: { weg: KiWeg | null; voreinstellung: string | null; status: KiStatus };
  beispiel_geladen: boolean;
  vorschlagsfragen: string[];
  erste_belegte_antwort: { am: string; sekunden_seit_start: number } | null;
  test_ki_verfuegbar: boolean;
  /** S2 additiv: MCP-Adresse für den Weg `app`, Berufsgeheimnis-Schalter (4.1) */
  mcp_adresse?: string;
  berufsgeheimnis?: boolean;
}

/** v1.4 3.5: GET /api/konto (nur admin, 404 im Selbstbetrieb) */
export interface Konto {
  status: 'angelegt' | 'test' | 'test_abgelaufen' | 'aktiv' | 'zahlung_offen' | 'nur_lesen' | 'umzug_laeuft' | 'umgezogen' | 'demo' | 'pausiert' | 'loeschung_geplant';
  paket: 'klein' | 'betrieb' | 'team';
  stufe: 'geteilt' | 'eigene_maschine';
  test_ende: string | null;
  loeschen_am: string | null;
  kuendigung_zum: string | null;
  test_selbst_verlaengert: boolean;
  preise: unknown | null;
  kauf_offen: boolean;
}
export type KontoAktion = 'kaufen' | 'stufe' | 'kuendigen' | 'kuendigung-zuruecknehmen' | 'test-verlaengern' | 'loeschen' | 'umzug' | 'egress-anfrage';

/** v1.4 7.1 */
export type ExportArt = 'okf' | 'zip' | 'umzugspaket';
export interface ExportAuftrag {
  status: 'laeuft' | 'fertig' | 'fehler';
  bytes?: number;
  sha256?: string;
  link?: string;
  bereit_bis?: string;
}

/** v1.4 7.3 (vereinfacht für die Anzeige) */
export interface Ausstiegsprobe {
  am: string;
  kernZuKern: { bestanden: boolean; pruefsummen_ok: boolean; git_fsck_ok: boolean; head_gleich: boolean };
  offen: { bestanden: boolean; dateien: number; ohneGueltigenKopf: string[]; fundstellenKaputt: number };
  bestanden: boolean;
}

/** v1.4 6.3: GET /api/ich/apps (Annahme W2 zu den Feldern) */
export interface VerbundeneApp {
  clientId: string;
  name: string;
  anbieter: string | null;
  scopes: TokenScope[];
  verbunden: string;
  zuletzt: string | null;
}

/** v1.4 8.1/8.2 (Annahme W2 zur Kurzform von GET /api/pruefbank) */
export interface PruefbankLauf {
  id: string;
  am: string;
  status: 'laeuft' | 'fertig';
  anbieter: string | null;
  modell: string | null;
  belegtreue: number | null;
  lecks: number | null;
  injektion: number | null;
  bestanden: boolean | null;
}

/** v1.4 9 */
export interface Kontextbilanz {
  stand: string;
  bestand: { artikel: number; quellen: number; fakten: number; entscheidungen: number };
  pflege: { mitVerantwortlich: number; mitPruefdatum: number; faellig: number; veraltet: number; faktenMitGueltigkeit: number };
  antworten: { belegt: number; stehtNichtDrin: number; zeitraum: { von: string; bis: string } };
  ersteBelegteAntwort: { am: string; sekundenSeitStart: number } | null;
  bemerkt: { befundeOffen: number; befundeErledigt: number; abgelaufeneFristen: number; vorAblaufGemeldet: number };
  eingang: { offen: number; freigegebenSeit: number; abgelehntSeit: number };
  anbindungen: { verbundeneApps: number; agentenZugaenge: number };
  luecken: number;
  ausstieg: { letzteProbe: string | null; bestanden: boolean | null };
  pruefbank: { letzterLauf: string | null; anbieter: string | null; modell: string | null; belegtreue: number | null; lecks: number | null; kiStatus: KiStatus };
}

export interface KiAnbieter {
  id: string;
  name: string;
  art: ProviderArt;
  /** Annahme W2: Region und Hinweis zur Anzeige, optional */
  region?: string;
  hinweis?: string;
}

// ---------- Sicherheit (S1 M2, M3, M5; Server F1) ----------

export type TokenScope = 'kern:lesen' | 'kern:fragen' | 'kern:vorschlagen' | 'kern:bericht' | 'kern:verwalten';

export interface ZugangsToken {
  id: string;
  art: 'mcp' | 'api';
  bezeichnung: string;
  geraet?: string | null;
  scopes: TokenScope[];
  erstellt: string;
  laeuftAb: string | null;
  zuletzt: string | null;
}

export interface NeuesToken {
  token: string;
  eintrag: ZugangsToken;
  hinweis?: string;
}

export interface Geraet {
  id: string;
  geraet: string;
  erstellt: string;
  zuletzt: string;
  aktuell: boolean;
}



export interface HinzufuegenEingabe {
  art: QuellenArt;
  titel?: string;
  inhalt?: string;
  url?: string;
  datei?: File | Blob;
  dateiname?: string;
  sammlung: string;
  sichtbarkeit: Sichtbarkeit;
  beobachten?: boolean;
}

export interface Entscheidung {
  aktion: 'freigeben' | 'ablehnen' | 'aendern';
  begruendung?: string;
  neuerText?: string;
}

export class ApiFehler extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiFehler';
  }
}

// ---------- v1.3: Lese-Engpass ----------

export type PunktBlock = 'unsicher' | 'entscheiden' | 'aendert_sich' | 'ignorieren';
export interface LeseAmpel {
  farbe: 'rot' | 'gelb' | 'gruen';
  grund: string;
  regel: string;
}

/** Punkt einer Ansicht. Annahme: `belege` kommen über die API aufgelöst als Fundstellen mit Zitat. */
export interface Punkt {
  id: string;
  block: PunktBlock;
  satz: string;
  absatz: string | null;
  belege: Fundstelle[];
  ampel: LeseAmpel;
  neu_seit?: string | null;
}

export interface AnsichtKopf {
  id: string;
  zweck: 'briefing' | 'thema' | 'entscheidungsvorlage' | 'vertretung' | 'agentenbericht' | 'antwort';
  titel: string;
  generated: { by: string; at: string };
  gilt_bis: string;
  basis_stand: string;
  lesezeit_min: number;
  status: 'aktuell' | 'abgelaufen' | 'basis_geaendert';
  /** v1.4 D-L13 */
  ki_erzeugt?: boolean;
  modell?: KiModell | null;
}

/** Annahme für GET /api/heute (Contract v1.3 nennt den Typ, nicht die Felder). */
export interface Heute {
  datum: string;
  ansicht: AnsichtKopf;
  budget: { minuten: number; woerter_pro_minute: number };
  punkte: Punkt[];
  ignorieren_anzahl: number;
  zurueckgestellt: number;
  /** v1.3.1: klassische Zusammenfassung (Markdown) und Fassung „nur Abweichungen“. Annahme zu den Feldnamen. */
  zusammenfassung?: string;
  abweichungen?: string;
  zu_entscheiden?: { frage: string; optionen: string[]; empfehlung: string; frist: string | null; wenn_nichts: string }[];
}

export interface LeseRegel {
  id: string;
  wenn: 'fakt_aendert' | 'frist_naht' | 'artikel_aendert' | 'neue_quelle' | 'zustaendig_fuer' | 'agent_risiko';
  filter: { gruppe?: string; gegenstand?: string; art?: string; tage?: number; risiko?: string };
  dann: 'melden' | 'sammeln';
}

export type Lesestil = 'zusammenfassung' | 'entscheidung' | 'fokus';

export interface LeseEinstellungen {
  /** v1.3.1: Standard für neue Nutzer ist „zusammenfassung“ */
  stil: Lesestil;
  /** v1.3.1: Lesebudget ist optional, Standard aus */
  lesebudget_an: boolean;
  /** harte Grenze nur, wenn der Nutzer sie selbst wählt; sonst weiche Grenze mit Hinweis */
  budget_hart: boolean;
  lesebudget_min_tag: number;
  woerter_pro_minute: number;
  max_offene_vorschlaege: number;
  zustellzeiten: string[];
  modus_erst_ich: boolean;
  nur_abweichungen: boolean;
  verstaendnisfrage: 'aus' | 'stichprobe' | 'immer_bei_fakten';
  regeln: LeseRegel[];
}

export interface Lesebilanz {
  /** v1.3.1: sanfter Hinweis nur für den Nutzer selbst, z. B. Minuten mit Zusammenfassungen diese Woche */
  hinweis?: { text: string; vorschlag: Lesestil } | null;
  nieGeoeffnet: { zweck: string; regel?: string; anzahl: number; von?: number }[];
  vorschlaege: string[];
}

export interface Abgleich {
  fehlt: Punkt[];
  widerspricht: Punkt[];
  uebereinstimmend_anzahl: number;
}

export interface FehlerMeldung {
  art: 'falsche_antwort' | 'falscher_vorschlag' | 'fehlende_antwort' | 'falsche_ampel' | 'falsche_zusammenfassung';
  frage: string | null;
  bezug: string | null;
  falsch: string;
  richtig: string | null;
  fundstelle: string | null;
}

export interface KernApi {
  login(name: string, passwort: string): Promise<User>;
  logout(): Promise<void>;
  ich(): Promise<User | null>;
  wissen(gruppe?: string): Promise<Artikel[]>;
  artikel(pfad: string): Promise<Artikel>;
  verlauf(pfad: string): Promise<VerlaufEintrag[]>;
  quellen(sammlung?: string): Promise<Quelle[]>;
  quelle(pfad: string): Promise<Quelle>;
  originalUrl(pfad: string): string;
  suche(q: string, opt?: { reichweite?: Reichweite; sammlung?: string }): Promise<Treffer[]>;
  frage(frage: string, opt?: { reichweite?: Reichweite; sammlung?: string }): Promise<Antwort>;
  hinzufuegen(e: HinzufuegenEingabe): Promise<{ quelle: Quelle; vorschlaege: Vorschlag[] }>;
  eingang(): Promise<Vorschlag[]>;
  entscheide(id: string, e: Entscheidung): Promise<Vorschlag>;
  vorschlag(v: Pick<Vorschlag, 'art' | 'ziel' | 'alt' | 'neu' | 'grund'>): Promise<Vorschlag>;
  briefing(seit?: string): Promise<Briefing>;
  faellig(): Promise<Artikel[]>;
  fakten(filter?: { art?: string; gegenstand?: string; gueltig_am?: string }): Promise<Fakt[]>;
  pruefen(): Promise<PruefErgebnis>;
  datenweg(): Promise<Datenweg>;
  heute(): Promise<Heute>;
  gelesen(e: { objekt: string; punkt?: string; stufe: 1 | 2 | 3 | 4 }): Promise<void>;
  lesen(): Promise<LeseEinstellungen>;
  speichereLesen(e: LeseEinstellungen): Promise<LeseEinstellungen>;
  lesebilanz(): Promise<Lesebilanz>;
  neueAnsicht(e: { zweck: AnsichtKopf['zweck'] }): Promise<AnsichtKopf>;
  einschaetzung(e: { bezug: string; text: string }): Promise<Abgleich>;
  meldeFehler(f: FehlerMeldung): Promise<{ id: string }>;
  importieren(e: { art: ImportArt; datei?: File; pfad?: string; sammlung: string; sichtbarkeit: Sichtbarkeit }): Promise<{ quellen: number; vorschlaege: number; hinweise?: string[] }>;
  einstellungen(): Promise<Einstellungen>;
  speichereEinstellungen(e: Einstellungen): Promise<Einstellungen>;
  benutzer(): Promise<User[]>;
  legeBenutzerAn(b: { name: string; passwort: string; rollen: Rolle[]; teams: string[] }): Promise<User>;
  /** Admin: Einmalpasswort, Person muss es beim nächsten Anmelden ändern */
  setzePasswortZurueck(id: string): Promise<{ einmalPasswort: string }>;
  widerrufeTokensVon(id: string): Promise<void>;
  // eigenes Konto
  aenderePasswort(alt: string, neu: string): Promise<void>;
  abmeldenUeberall(): Promise<{ tokensWiderrufen: number }>;
  geraete(): Promise<Geraet[]>;
  meldeGeraetAb(id: string): Promise<void>;
  tokens(): Promise<ZugangsToken[]>;
  legeTokenAn(e: { bezeichnung?: string; scopes?: TokenScope[]; gueltigTage?: number; geraet?: string }): Promise<NeuesToken>;
  widerrufeToken(id: string): Promise<void>;
  // v1.4 4.1 Einrichtung (admin)
  einrichtung(): Promise<Einrichtung | null>;
  einrichtungKi(e: { weg: KiWeg; voreinstellung?: string; url?: string; chatModell?: string; embedModell?: string; schluessel?: string }): Promise<{ verbindung: 'ok' | 'fehler'; meldung: string }>;
  einrichtungBeispiel(aktion: 'laden' | 'entfernen'): Promise<void>;
  einrichtungFertig(): Promise<void>;
  // v1.4 5.2, 8.1, 8.2
  speichereKiSchluessel(anbieter: string, schluessel: string): Promise<void>;
  kiZurueck(): Promise<Einstellungen>;
  pruefbankLauf(): Promise<PruefbankLauf>;
  pruefbank(): Promise<PruefbankLauf | null>;
  // v1.4 3.5 Konto (admin, managed)
  konto(): Promise<Konto | null>;
  kontoAktion(a: KontoAktion, body?: Record<string, unknown>): Promise<Record<string, unknown>>;
  // v1.4 7.1, 7.3
  starteExport(art: ExportArt, passphrase?: string): Promise<{ id: string }>;
  exportStand(id: string): Promise<ExportAuftrag>;
  starteAusstiegsprobe(): Promise<void>;
  ausstiegsprobe(): Promise<Ausstiegsprobe | null>;
  // v1.4 6.3/6.4
  apps(): Promise<VerbundeneApp[]>;
  trenneApp(clientId: string): Promise<void>;
  // v1.4 9
  kontextbilanz(): Promise<Kontextbilanz>;
}
