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
export { proxyDispatcher, fetchMitProxy } from './netz.js';
export { HINWEIS } from './kern.js';
export type { ChatOptionen, Stuetzung } from './types.js';
