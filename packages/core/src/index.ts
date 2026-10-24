/**
 * @kern/core – öffentliche API laut CONTRACT.md (v1 + Nachtrag v1.1).
 * Erweiterungen sind zusätzlich exportiert und in README.md beschrieben.
 */
export { Kern, erzeugeDiff, type Einstellungen } from './kern.js';
export type {
  KernConfig, User, Rolle, Sichtbarkeit, Fundstelle, ArtikelFundstelle, ArtikelKopf, ArtikelTyp, QuellenKopf, QuellenArt,
  Artikel, Quelle, Treffer, Antwort, Vorschlag, Provider, ProviderConfig, ChatNachricht, WhisperConfig,
  Erzeugt, Geprueft, FaktArt, FaktEintrag, Fakt, Befund,
  AnsichtZweck, AnsichtBlock, Lesestil, Ampel, AnsichtPunkt, AnsichtFundstelle, ZuEntscheiden, AnsichtKopf, Ansicht, AnsichtKurz,
  LeseRegel, LeseEinstellungen, Heute,
} from './types.js';
export { LESESTILE, standardLesen } from './lesen.js';
export { KernFehler, ROLLEN, artikelKopfSchema, quellenKopfSchema, vorschlagSchema, faktSchema } from './types.js';
export { MockProvider, OllamaProvider, OpenAIProvider, AnthropicProvider, erzeugeProvider, mockEmbedding } from './provider.js';
export { bildeAbschnitte, type Abschnitt } from './abschnitte.js';
export { darfSehen, inReichweite, hatRolle } from './rechte.js';
export { parseMarkdown, stringifyMarkdown, slugify, stammformen, faltUmlaute } from './util.js';
export { htmlZuMarkdown, htmlDokumentZuMarkdown, pdfZuMarkdown, docxZuMarkdown } from './ingest.js';
export { leseRegeln, REGEL_DATEI } from './regeln.js';
export { OKF_VERSION } from './okf.js';
export { RESERVIERT, istReserviert } from './ordnerindex.js';
export { seedDemo, DEMO_BENUTZER } from './seed/index.js';
export { Zugangsspeicher, ZugangEinfach, ALLE_SCOPES, TOKEN_ARTEN, STANDARD_SEK, SITZUNG_MAX_SEK } from './zugang.js';
export type { TokenArt, Scope, TokenEintrag, ErzeugeEingabe, Erwartung, OAuthClient, TokenPaar, EinfacherScope, ZugangEintrag } from './zugang.js';
export type { BenutzerMitZugang } from './benutzer.js';
export { sichererAbruf, istGesperrt, NetzFehler, type NetzOptionen, type AbrufErgebnis } from './netz.js';
export { pruefeZip, ParserFehler, type ParserGrenzen } from './parser.js';
export { Zaehler, type Verbrauch } from './zaehler.js';
export { proxyDispatcher, fetchMitProxy, kiDispatcher, fetchKi } from './netz.js';
export { HINWEIS } from './kern.js';
export type { ChatOptionen, Stuetzung } from './types.js';
export { umzugAuspacken, pruefeOkfOrdner, UMZUG_SCHEMA, type ExportArt, type UmzugManifest, type Pruefbericht, type Ausstiegsprobe, type PruefbankKennzahlen } from './export.js';
export { packeTar, lieseTar } from './tar.js';
export { BEISPIEL_SAMMLUNG } from './kern.js';
export type { ZugangExport } from './zugang.js';
// v1.4 8.1 bis 8.5, 9 und v1.4.1 (E1)
export { PRUEF_ARTEN, STANDARD_SCHWELLEN, OEFFENTLICH_STICHTAG, oeffentlicheFragen, kennzahlenAus, kennzahlenGleich } from './pruefbank.js';
export type { PruefbankLauf, PruefbankOptionen, PruefbankSatz, PruefbankZeile, Prueffrage, PruefArt, KiStatus } from './pruefbank.js';
export type { Kontextbilanz, KontextStufe } from './kontextbilanz.js';
export { KONTEXT_STANDARD_BUDGET, KONTEXT_HINWEIS, schaetzeTokens } from './kontextpaket.js';
export type { Kontextpaket, KontextpaketAnfrage, PaketAbschnitt, PaketEntscheidung, PaketWiderspruch, Herkunft } from './kontextpaket.js';
export { agentenScopes, agentVon, alsAgent, imZugang, pruefePfad, NOTIZEN_ABLAUF_TAGE, NOTIZ_MAX_BYTES } from './gedaechtnis.js';
export type { AgentenProfil, GedaechtnisBefehl, GedaechtnisErgebnis } from './gedaechtnis.js';
export type { ProviderProfil } from './types.js';
export { nurMarkup } from './kern.js';
export { ANHANG_MAX_MB } from './ingest.js';
