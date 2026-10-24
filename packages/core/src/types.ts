import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Öffentliche Typen laut CONTRACT.md (v1, 24.10.2026)                  */
/* ------------------------------------------------------------------ */

export type Rolle = 'leser' | 'autor' | 'freigeber' | 'admin';
export const ROLLEN: readonly Rolle[] = ['leser', 'autor', 'freigeber', 'admin'] as const;

export type ProviderConfig =
  | { art: 'mock' }
  | { art: 'ollama'; url: string; chatModell: string; embedModell: string }
  | { art: 'openai'; url: string; apiKey: string; chatModell: string; embedModell: string }
  | { art: 'anthropic'; apiKey: string; chatModell: string; embed: ProviderConfig };

/** Erweiterung: Audio-Transkription über ein lokales whisper-Programm (z. B. whisper.cpp `whisper-cli`). */
export interface WhisperConfig {
  /** Pfad zum Programm. */
  pfad: string;
  /** Argumente; `{datei}` wird durch den Audiopfad ersetzt, `{modell}` durch `modell`. Standard: `['-nt', '-f', '{datei}']` (+ `-m {modell}` falls modell gesetzt). Transkript wird von stdout gelesen. */
  argumente?: string[];
  modell?: string;
}

export interface KernConfig {
  dataDir: string;
  provider: ProviderConfig;
  betrieb: string;
  sprache: 'de' | 'en';
  /** Erweiterung: optionales whisper für Audio. */
  whisper?: WhisperConfig;
  /** Erweiterung: Produktname für Texte, Protokolle und Kennungen (Standard „Kern“). Nirgends hart codiert. */
  produktname?: string;
  /** Erweiterung: Autor für Commits externer Änderungen (Standard „extern“). */
  externerAutor?: string;
  /** v1.2: Vektorsuche an/aus. Standard: an, wenn ein Embedding-Anbieter konfiguriert ist (nicht bei `mock`). */
  vektoren?: boolean;
  /** Erweiterung: Zeitquelle für Tests (ISO-Datum heute). */
  heute?: () => Date;
  /** S1 H1: Grenzen für Web-Abrufe (Standard: nur öffentliche Adressen, Port 80/443, 5 MB, 20 s, Proxy aus der Umgebung). */
  netz?: import('./netz.js').NetzOptionen;
  /** S1 M8: Grenzen für PDF/DOCX (Standard 50 MB, 500 Seiten, 100 MB entpackt, 60 s, Worker-Thread). */
  parser?: import('./parser.js').ParserGrenzen;
  /** v1.4 3.4: Preis des KI-Anbieters in Cent je Million Tokens (sonst aus kern.yaml `ki.preis_cent_je_mio`). */
  kiPreis?: { ein: number; aus: number };
}

export interface User {
  id: string;
  name: string;
  rollen: Rolle[];
  teams: string[];
}

export type Sichtbarkeit = 'ich' | `team:${string}` | 'betrieb';

export interface Fundstelle {
  quelle: string;
  abschnitt: string;
  zeilen: [number, number];
  zitat: string;
}

export interface ArtikelFundstelle {
  /** v1.1: Kennung, im Text als Fußnote `[^id]` referenziert. Kern vergibt `f1`, `f2` … falls sie fehlt. */
  id: string;
  quelle: string;
  abschnitt: string;
  zeilen: [number, number];
}

/** v1.1: OKF-Akteur, z. B. `human:<userId>`, `kern-ki/<anbieter>`, `process:import`. */
export interface Erzeugt { by: string; at: string; }
export interface Geprueft { by: string; at: string; commit?: string; vorschlag?: string; }

export type FaktArt = 'preis' | 'frist' | 'zustaendigkeit' | 'kennzahl' | 'kontakt' | 'regel';

/** v1.1: Eintrag der Faktenschicht (im Artikelkopf unter `fakten:`). */
export interface FaktEintrag {
  id: string;
  art: FaktArt;
  gegenstand: string;
  wert: string | number | boolean;
  einheit?: string | null;
  gilt_ab?: string | null;
  gilt_bis?: string | null;
  ersetzt?: string | null;
  /** Kennung aus `fundstellen`. */
  fundstelle: string;
}

/** v1.1: Rückgabe von `fakten()`: Fakt + Artikel + aufgelöste Fundstelle. */
export interface Fakt extends FaktEintrag {
  artikel: string;
  artikelTitel: string;
  /** Fakt ist am Stichtag gültig und nicht durch einen anderen Fakt ersetzt. */
  gueltig: boolean;
  beleg: Fundstelle | null;
}

/** v1.1: Befund des Aufräumlaufs `pruefe()`. */
export interface Befund {
  art: 'widerspruch' | 'fakt_abgelaufen' | 'fakt_laeuft_ab' | 'pruefung_faellig' | 'fundstelle_kaputt' | 'zu_gross' | 'verwaist' | 'kopf_fehlerhaft' | 'index_veraltet' | 'ansicht_abgelaufen' | 'rueckkopplung';
  pfad: string;
  text: string;
  /** Falls ein mechanischer Vorschlag im Eingang angelegt wurde. */
  vorschlag?: string;
}

export type ArtikelTyp = 'Artikel' | 'Faktenblatt' | 'Entscheidung' | 'Ablauf' | 'Person' | (string & {});

export interface ArtikelKopf {
  /** v1.1: OKF-Pflichtfeld. Standard `Artikel`. */
  type: ArtikelTyp;
  titel: string;
  gruppe: string;
  kurzfassung: string;
  stand: string;
  verantwortlich: string;
  pruefen_bis: string | null;
  sichtbarkeit: Sichtbarkeit;
  besitzer: string;
  fundstellen: ArtikelFundstelle[];
  status: 'entwurf' | 'freigegeben' | 'veraltet';
  generated?: Erzeugt;
  verified?: Geprueft[];
  fakten?: FaktEintrag[];
  [weitere: string]: unknown;
}

export type QuellenArt = 'datei' | 'text' | 'web' | 'audio' | 'notiz';

export interface QuellenKopf {
  /** v1.1: OKF-Pflichtfeld, immer `Quelle`. */
  type: 'Quelle';
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
  [weitere: string]: unknown;
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
  /** `belege` enthält 1-basierte Nummern in `Antwort.belege` (Beleg 1 = belege[0]), wie Fußnoten „[1]“. */
  punkte: { text: string; belege: number[]; gestuetzt?: Stuetzung }[];
  belege: (Fundstelle & { web?: boolean })[];
  /** S1 M4: fester Text, nie vom Modell. */
  hinweis: string;
  /** D-L13 (Art. 50 KI-VO): Antwort von einer KI erzeugt? (Faktenschicht und Regeln: false) */
  ki_erzeugt: boolean;
  /** D-L13: Anbieter und Modell, wenn eine KI beteiligt war. */
  modell: { anbieter: string; name: string } | null;
}

/** S1 M4: deterministische Stützprüfung je Punkt (`stuetzung` in util.ts). */
export type Stuetzung = 'ja' | 'teilweise' | 'unklar';

export interface Vorschlag {
  id: string;
  art: 'neu' | 'aenderung' | 'loeschung';
  ziel: string;
  alt: string | null;
  neu: string;
  grund: string;
  von: string;
  erstellt: string;
  /** v1.2: `konflikt` = Zieldatei hat sich seit dem Vorschlag geändert; alt/diff sind neu berechnet, bitte erneut entscheiden. */
  status: 'offen' | 'freigegeben' | 'abgelehnt' | 'konflikt';
  entscheidung?: { von: string; am: string; begruendung?: string };
  /** v1.2: SHA-256 der Zieldatei beim Erstellen ('' = Datei gab es nicht). */
  basis_hash?: string;
  /** D-L13: von der KI erzeugt (kompiliere), mit Anbieter und Modell. */
  ki_erzeugt?: boolean;
  modell?: { anbieter: string; name: string } | null;
  /** v1.2: Vorschlag betrifft wissen/_regeln/ (nur admin darf freigeben). */
  regel?: boolean;
  /** Erweiterung: Quelle, aus der der Vorschlag kompiliert wurde. */
  quelle?: string;
  /** Erweiterung: Unified-Diff alt → neu (wird beim Anlegen erzeugt). */
  diff?: string;
}

export interface ChatNachricht { role: 'system' | 'user' | 'assistant'; content: string; }

/** v1.4 3.4: Verbrauchsmeldung je Aufruf (für den Zähler ohne Personenbezug). */
export interface ChatOptionen { json?: boolean; onVerbrauch?: (v: { eingabeTokens: number; ausgabeTokens: number }) => void }

export interface Provider {
  name: string;
  embed(texte: string[]): Promise<Float32Array[]>;
  chat(msgs: ChatNachricht[], opt?: ChatOptionen): Promise<string>;
  /** Optionaler Reranker: liefert je Text eine Relevanz (höher = besser). */
  rerank?(frage: string, texte: string[]): Promise<number[]>;
}

/* ------------------------------------------------------------------ */
/* zod-Schemata                                                         */
/* ------------------------------------------------------------------ */

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
export const sichtbarkeitSchema = z.union([
  z.literal('ich'),
  z.literal('betrieb'),
  z.string().regex(/^team:[\p{L}\p{N}_.-]+$/u, 'team:<name>'),
]) as unknown as z.ZodType<Sichtbarkeit>;

export const artikelFundstelleSchema = z.object({
  id: z.string().min(1),
  quelle: z.string().min(1),
  abschnitt: z.string(),
  zeilen: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
});

const akteur = z.object({ by: z.string().min(1), at: z.string().min(10) });
export const faktSchema = z.object({
  id: z.string().min(1),
  art: z.enum(['preis', 'frist', 'zustaendigkeit', 'kennzahl', 'kontakt', 'regel']),
  gegenstand: z.string().min(1),
  wert: z.union([z.string(), z.number(), z.boolean()]),
  einheit: z.string().nullable().optional(),
  gilt_ab: datum.nullable().optional(),
  gilt_bis: datum.nullable().optional(),
  ersetzt: z.string().nullable().optional(),
  fundstelle: z.string().min(1),
});

export const artikelKopfSchema = z
  .object({
    type: z.string().min(1),
    titel: z.string().min(1),
    gruppe: z.string().min(1),
    kurzfassung: z.string(),
    stand: datum,
    verantwortlich: z.string(),
    pruefen_bis: datum.nullable(),
    sichtbarkeit: sichtbarkeitSchema,
    besitzer: z.string().min(1),
    fundstellen: z.array(artikelFundstelleSchema),
    status: z.enum(['entwurf', 'freigegeben', 'veraltet']),
    generated: akteur.optional(),
    verified: z.array(akteur.extend({ commit: z.string().optional(), vorschlag: z.string().optional() })).optional(),
    fakten: z.array(faktSchema).optional(),
  })
  .passthrough();

export const quellenKopfSchema = z
  .object({
    type: z.literal('Quelle'),
    titel: z.string().min(1),
    art: z.enum(['datei', 'text', 'web', 'audio', 'notiz']),
    herkunft: z.string(),
    erfasst_am: z.string().min(10),
    erfasst_von: z.string().min(1),
    sichtbarkeit: sichtbarkeitSchema,
    sammlung: z.string().min(1),
    hash: z.string(),
    ersetzt: z.string().nullable(),
    beobachtet: z.boolean(),
  })
  .passthrough();

export const vorschlagSchema = z.object({
  id: z.string(),
  art: z.enum(['neu', 'aenderung', 'loeschung']),
  ziel: z.string(),
  alt: z.string().nullable(),
  neu: z.string(),
  grund: z.string(),
  von: z.string(),
  erstellt: z.string(),
  status: z.enum(['offen', 'freigegeben', 'abgelehnt', 'konflikt']),
  entscheidung: z.object({ von: z.string(), am: z.string(), begruendung: z.string().optional() }).optional(),
  basis_hash: z.string().optional(),
  regel: z.boolean().optional(),
  quelle: z.string().optional(),
  diff: z.string().optional(),
  ki_erzeugt: z.boolean().optional(),
  modell: z.object({ anbieter: z.string(), name: z.string() }).nullable().optional(),
});

/** Antwortformat des Modells für `frage`. */
export const modellAntwortSchema = z.object({
  punkte: z
    .array(
      z.object({
        text: z.string(),
        belege: z.array(z.coerce.number().int()).default([]),
        zitat: z.string().optional(),
      }),
    )
    .default([]),
  hinweis: z.string().optional(),
});

/** Antwortformat des Modells für `kompiliere`. */
export const modellKompilatSchema = z.object({
  vorschlaege: z
    .array(
      z.object({
        art: z.enum(['neu', 'aenderung']),
        ziel: z.string().optional().nullable(),
        titel: z.string().min(1),
        gruppe: z.string().optional(),
        kurzfassung: z.string().default(''),
        text: z.string().min(1),
        abschnitte: z.array(z.coerce.number().int()).default([]),
        grund: z.string().default(''),
        fakten: z
          .array(
            z.object({
              art: z.enum(['preis', 'frist', 'zustaendigkeit', 'kennzahl', 'kontakt', 'regel']),
              gegenstand: z.string().min(1),
              wert: z.union([z.string(), z.number(), z.boolean()]),
              einheit: z.string().nullable().optional(),
              gilt_ab: datum.nullable().optional(),
              gilt_bis: datum.nullable().optional(),
              abschnitt: z.coerce.number().int().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export const modellRegelSchema = z.object({ verstoss: z.boolean(), regel: z.string().optional().nullable() });

/** Fehler mit HTTP-naher Kennung, damit Server sie abbilden kann. */
export class KernFehler extends Error {
  constructor(
    public code: 'nicht_gefunden' | 'keine_rechte' | 'ungueltig' | 'konflikt' | 'rueckkopplung',
    message: string,
  ) {
    super(message);
    this.name = 'KernFehler';
  }
}

/* ------------------------------------------------------------------ */
/* v1.3 / v1.3.1: Ansichten, Heute, Lesen, Ampel                       */
/* ------------------------------------------------------------------ */

export type AnsichtZweck = 'briefing' | 'thema' | 'entscheidungsvorlage' | 'vertretung' | 'agentenbericht' | 'antwort';
export type AnsichtBlock = 'unsicher' | 'entscheiden' | 'aendert_sich' | 'ignorieren';
export type Lesestil = 'zusammenfassung' | 'entscheidung' | 'fokus';

export interface Ampel { farbe: 'rot' | 'gelb' | 'gruen'; grund: string; regel: string; }

export interface AnsichtPunkt {
  id: string;
  block: AnsichtBlock;
  /** Stufe 1, höchstens 25 Wörter. */
  satz: string;
  /** Stufe 2, höchstens 80 Wörter. */
  absatz: string | null;
  /** Stufe 3: ids aus `Ansicht.kopf.fundstellen` (zitatgeprüft). */
  belege: string[];
  ampel: Ampel;
  /** id der Vorgänger-Ansicht, gegenüber der der Punkt neu ist; null = unverändert. */
  neu_seit: string | null;
  /** Erweiterung: Ziel zum Öffnen (Pfad oder Vorschlags-id). */
  ziel?: string;
}

export interface AnsichtFundstelle extends Fundstelle { id: string; }

export interface ZuEntscheiden {
  frage: string;
  optionen: string[];
  empfehlung: string;
  begruendung_belege: string[];
  frist: string | null;
  wenn_nichts: string;
  /** Erweiterung: Vorschlags-id, falls die Entscheidung ein Vorschlag im Eingang ist. */
  vorschlag?: string;
}

export interface AnsichtKopf {
  type: 'Ansicht';
  id: string;
  zweck: AnsichtZweck;
  fuer: string;
  titel: string;
  generated: Erzeugt;
  gilt_bis: string;
  basis: { pfad: string; hash: string }[];
  basis_stand: string | null;
  lesezeit_min: number;
  status: 'aktuell' | 'abgelaufen' | 'basis_geaendert';
  vorgaenger: string | null;
  punkte: AnsichtPunkt[];
  fundstellen: AnsichtFundstelle[];
  zu_entscheiden?: ZuEntscheiden[];
  /** Erweiterung: Lesestil, in dem die Ansicht erzeugt wurde. */
  stil?: Lesestil;
  /** D-L13: Ansicht von einer KI erzeugt (Heute ist deterministisch: false). */
  ki_erzeugt?: boolean;
  modell?: { anbieter: string; name: string } | null;
  [weitere: string]: unknown;
}

export interface Ansicht { pfad: string; kopf: AnsichtKopf; text: string; }
export interface AnsichtKurz { id: string; zweck: AnsichtZweck; titel: string; gilt_bis: string; status: AnsichtKopf['status']; lesezeit_min: number; erstellt: string; }

export interface LeseRegel {
  id: string;
  wenn: 'fakt_aendert' | 'frist_naht' | 'artikel_aendert' | 'neue_quelle' | 'zustaendig_fuer' | 'agent_risiko';
  filter?: { gruppe?: string; gegenstand?: string; art?: string; tage?: number; risiko?: string };
  dann: 'melden' | 'sammeln';
}

export interface LeseEinstellungen {
  /** v1.3.1: Standard `zusammenfassung`. */
  stil: Lesestil;
  /** v1.3.1: Lesebudget ist optional, Standard aus. Im Stil `fokus` immer an. */
  lesebudget_an: boolean;
  /** v1.3.1: harte Grenze nur, wenn der Nutzer sie selbst wählt. */
  lesebudget_hart: boolean;
  /** Gleichbedeutend mit `lesebudget_hart` (Feldname im Web); wird beim Speichern übernommen. */
  budget_hart?: boolean;
  lesebudget_min_tag: number;
  woerter_pro_minute: number;
  max_offene_vorschlaege: number;
  zustellzeiten: string[];
  modus_erst_ich: boolean;
  nur_abweichungen: boolean;
  verstaendnisfrage: 'aus' | 'stichprobe' | 'immer_bei_fakten';
  regeln: LeseRegel[];
}

export interface Heute {
  datum: string;
  stil: Lesestil;
  /** Die Ansicht im gewählten Stil. */
  ansicht: Ansicht;
  /** Die anderen Formen lassen sich jederzeit abrufen: `heute(u, { stil })`. */
  andere_stile: Lesestil[];
  budget: { an: boolean; hart: boolean; minuten: number; woerter_pro_minute: number; woerter: number; benutzt_woerter: number; zurueckgestellt: number; ueberschritten: boolean };
  /** Für Web/REST: Punkte mit aufgelösten Fundstellen (Stufe 3) in Anzeige-Reihenfolge, ohne Block „ignorieren“. */
  punkte: (Omit<AnsichtPunkt, 'belege'> & { belege: AnsichtFundstelle[] })[];
  ignorieren_anzahl: number;
  zurueckgestellt: number;
  /** v1.3.1: Zusammenfassung als Markdown (Standard-Stil) und Fassung „nur Abweichungen“ (Knopf unter der Zusammenfassung). */
  zusammenfassung: string;
  abweichungen: string;
  /** Stil `entscheidung` (sonst auf Klick über `heute(u, { stil: 'entscheidung' })`): höchstens drei Entscheidungen. */
  zu_entscheiden?: ZuEntscheiden[];
  /** Anzahl Punkte je Block (ignorieren nur als Zahl). */
  zahlen: Record<AnsichtBlock, number>;
  /** v1.3.1: sanfter Hinweis nur für den Nutzer selbst (z. B. Zeit mit Zusammenfassungen), nie erzwungen. */
  hinweis: string | null;
}
