import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep, extname } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import YAML from 'yaml';
import { watch } from 'chokidar';
import { bildeAbschnitte, type Abschnitt } from './abschnitte.js';
import { Benutzerverwaltung } from './benutzer.js';
import { Zugangsspeicher, ZugangEinfach } from './zugang.js';
import { Zaehler, type Verbrauch } from './zaehler.js';
import { Git } from './git.js';
import { NetzFehler } from './netz.js';
import { ausstiegsprobe as ausstiegsprobeIntern, entpackeKernZip, exportiere as exportiereDatei, umzugPruefen as umzugPruefenIntern, type Ausstiegsprobe, type ExportArt, type Pruefbericht } from './export.js';
import { ParserFehler } from './parser.js';
import { ANHANG_MAX_MB, istAudio, ladeWebseite, leseDatei, robotsErlaubt, type IngestErgebnis } from './ingest.js';
import { normalisiereArtikelKopf, normalisiereQuellenKopf, ordneArtikelKopf, ordneQuellenKopf, normalisiereFundstellen } from './kopf.js';
import { betroffeneOrdner, ergaenzeLog, erzeugeIndex, istReserviert } from './ordnerindex.js';
import { embedKennung, erzeugeProvider, ueberdeckung } from './provider.js';
import { brauchtRolle, darfSehen, darfSichtbarkeitSetzen, hatRolle, inReichweite } from './rechte.js';
import { leseRegeln, REGEL_DATEI, verletzteRegel, type Regel } from './regeln.js';
import { rrf, SuchIndex, type DateiEintrag, type FaktZeile, type RohTreffer } from './suchindex.js';
import type {
  Antwort, Artikel, ArtikelFundstelle, ArtikelKopf, Befund, Fakt, FaktEintrag, Fundstelle, KernConfig, Provider, ProviderConfig,
  Quelle, QuellenKopf, Rolle, Sichtbarkeit, Treffer, User, Vorschlag,
  Ampel, Ansicht, AnsichtBlock, AnsichtFundstelle, AnsichtKopf, AnsichtKurz, AnsichtPunkt, AnsichtZweck, Heute, LeseEinstellungen, LeseRegel, Lesestil, ZuEntscheiden,
} from './types.js';
import { KernFehler, modellAntwortSchema, modellKompilatSchema, modellRegelSchema, vorschlagSchema } from './types.js';
import { DATEN_REGEL, datenBlock, stuetzung } from './util.js';
import { extrahiereJson, isoDatum, neueId, parseMarkdown, zeilenSaetze, sha256, sichererPfad, slugify, Sperre, stringifyMarkdown, wortAnzahl } from './util.js';
import { exportiereOkfBuendel, leseOkfBuendel } from './okf.js';
import { LESESTILE, LeseStand, leseEinstellungenSchema, standardLesen } from './lesen.js';
import { z } from 'zod';
import { pruefbank as pruefbankIntern, pruefbankLaeufe as pruefbankLaeufeIntern, pruefbankSchaetzung as pruefbankSchaetzungIntern, speicherePrueffrage as speicherePrueffrageIntern, type KiStatus, type PruefbankLauf, type PruefbankOptionen, type PruefbankSatz, type PrueffrageEingabe } from './pruefbank.js';
import { kontextbilanz as kontextbilanzIntern, type Kontextbilanz } from './kontextbilanz.js';
import { kontextpaket as kontextpaketIntern, type Kontextpaket, type KontextpaketAnfrage } from './kontextpaket.js';
import { agentVon, gedaechtnis as gedaechtnisIntern, notizenAblauf as notizenAblaufIntern, type GedaechtnisBefehl, type GedaechtnisErgebnis } from './gedaechtnis.js';

type Reichweite = 'ich' | 'team' | 'betrieb';

/** v1.4 4.3: Beispielsammlung (erfunden), mit absichtlichem Widerspruch und einer Fangfrage. */
export const BEISPIEL_SAMMLUNG = 'beispiel';
const BEISPIEL_TEXTE: { titel: string; text: string }[] = [
  { titel: 'Beispiel: Urlaub und Krankmeldung', text: '# Urlaub und Krankmeldung\n\n## Urlaub\n\nUrlaubsanträge müssen zwei Wochen vorher im Büro eingereicht werden. Über Brückentage entscheidet die Geschäftsführung bis zum 31. Januar.\n\n## Krankmeldung\n\nKrankmeldungen bitte bis 9 Uhr telefonisch an das Büro. Ab dem dritten Tag ist eine Bescheinigung nötig.' },
  { titel: 'Beispiel: Preisblatt 2026', text: '# Preisblatt 2026\n\n## Stundensätze\n\nDer Stundensatz für Montage beträgt 68 Euro netto.\n\n## Zahlungsziel\n\nRechnungen an Privatkunden haben ein Zahlungsziel von 14 Tagen.' },
  { titel: 'Beispiel: Alte Notiz Buchhaltung', text: '# Alte Notiz Buchhaltung\n\n## Zahlungsziel\n\nRechnungen an Privatkunden haben ein Zahlungsziel von 30 Tagen.\n\n## Mahnungen\n\nDie erste Mahnung geht zwei Wochen nach Fälligkeit hinaus.' },
  { titel: 'Beispiel: Werkstattregeln', text: '# Werkstattregeln\n\n## Maschinen\n\nDie Formatkreissäge wird nur mit Schiebestock bedient. Hobelmesser werden alle 40 Betriebsstunden gewechselt.\n\n## Ordnung\n\nFreitags ab 14 Uhr wird die Werkstatt gereinigt.' },
];
const BEISPIEL_FRAGEN = ['Wann muss ich einen Urlaubsantrag einreichen?', 'Wie lange ist das Zahlungsziel für Privatkunden?', 'Wann werden Hobelmesser gewechselt?'];
const BEISPIEL_FANGFRAGE = 'Wie hoch ist das Weihnachtsgeld?';

/** S1 M4 und D-L13: feste Hinweistexte, nie Modelltext. */
export const HINWEIS = {
  eingabe: 'Bitte eine Frage eingeben.',
  regel: 'Das gehört nicht in den Wissensordner. Bitte in der zuständigen Fachsoftware oder bei der verantwortlichen Person nachsehen.',
  fakten: 'Aus der Faktenschicht, ohne KI. Prüf die Belege.',
  leer: 'Dazu steht nichts im Wissensordner.',
  ki: 'Diese Antwort hat eine KI aus euren Dokumenten erzeugt. Prüf die Belege.',
  ki_pruefen: 'Diese Antwort hat eine KI aus euren Dokumenten erzeugt. Nicht jeder Satz ist durch den Beleg gedeckt; bitte die Belege lesen.',
  ki_fehler: 'Die KI-Antwort war nicht verwendbar. Bitte später erneut fragen oder in den Dokumenten suchen.',
} as const;
type Aenderung = { pfad: string; inhalt: string | Buffer | null };

export interface Einstellungen {
  betrieb: string;
  sprache: 'de' | 'en';
  ki: Record<string, unknown>;
  teams: string[];
  standard_sichtbarkeit: Sichtbarkeit;
  regelpruefung_ki: boolean;
  [weitere: string]: unknown;
}

const SYSTEM = 'system';
const MAX_ARTIKEL_BYTES = 8 * 1024;
const FAKT_VORLAUF_TAGE = 30;

function ohneGeheimnisse(p: ProviderConfig): Record<string, unknown> {
  const { ...k } = p as Record<string, unknown>;
  if ('apiKey' in k) k['apiKey'] = '';
  if (k['embed'] && typeof k['embed'] === 'object') k['embed'] = ohneGeheimnisse(k['embed'] as ProviderConfig);
  return k;
}

/** Ohne Auslassungszeichen kürzen (Zitate müssen wörtlich bleiben), an Wortgrenze. */
function kuerze(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const leer = cut.lastIndexOf(' ');
  return (leer > max * 0.6 ? cut.slice(0, leer) : cut).trim();
}

/** v1.4.1 U11: Text besteht nur aus Bild- oder Linkmarkup (oder bloßen Adressen) und taugt nicht als Beleg. */
export function nurMarkup(s: string): boolean {
  const rest = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\^[^\]]+\]:?/g, ' ');
  return (rest.match(/\p{L}/gu) ?? []).length < 3;
}

function normWs(s: string): string {
  return s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function plusTage(datum: string, tage: number): string {
  const d = new Date(`${datum}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

export class Kern {
  readonly provider: Provider;
  readonly benutzer: Benutzerverwaltung;
  /** Gemeinsamer Zugangsspeicher für Sitzungen, API-/MCP- und OAuth-Tokens (.kern/zugang.sqlite). */
  readonly zugang: Zugangsspeicher;
  /** Kurzform des Zugangsspeichers (asynchron, Scopes lesen|schreiben|admin). */
  readonly zugangEinfach: ZugangEinfach;
  /** v1.4 3.4/9: Tageszähler ohne Personenbezug. */
  readonly zaehler: Zaehler;
  private sperre = new Sperre();
  private watcher: { close(): Promise<void> } | null = null;
  private regelCache: { hash: string; regeln: Regel[] } | null = null;
  /** Produktname (Konfig `produktname`, Standard „Kern“). */
  readonly produkt: string;
  /** v1.2: Vektorsuche nur mit echtem Embedding-Anbieter (oder ausdrücklich `vektoren: true`). */
  vektorenAn: boolean;
  private inner: Provider;
  private static vektorenFuer(cfg: KernConfig, provider: Provider): boolean {
    return cfg.vektoren ?? (provider.name !== 'mock' && !(cfg.provider.art === 'anthropic' && cfg.provider.embed.art === 'mock'));
  }

  /**
   * KI-Anbieter zur Laufzeit wechseln (v1.4 4.1, ohne Neustart). Ändert sich das Embedding-Modell, wird der Index neu gebaut.
   * Speichert nichts in kern.yaml (das macht `speichereEinstellungen`).
   */
  async setzeProvider(p: ProviderConfig): Promise<void> {
    const neu = erzeugeProvider(p);
    const alteKennung = this.kennung;
    (this.cfg as { provider: ProviderConfig }).provider = p;
    delete (this.cfg as { providerInstanz?: Provider }).providerInstanz;
    this.inner = neu;
    this.vektorenAn = Kern.vektorenFuer(this.cfg, neu);
    if (this.kennung !== alteKennung) {
      this.ix.setzeMeta('embed', this.kennung);
      await this.reindex();
    }
  }

  /** Verbindung zu einem Anbieter testen (ein kurzer Aufruf, Embedding falls genutzt). Meldung ohne Schlüssel. */
  async pruefeVerbindung(p: ProviderConfig): Promise<{ ok: boolean; meldung: string }> {
    let prov: Provider;
    try {
      prov = erzeugeProvider(p);
    } catch (e) {
      return { ok: false, meldung: (e as Error).message.slice(0, 200) };
    }
    const mitZeit = <T>(x: Promise<T>) => Promise.race([x, new Promise<T>((_, f) => setTimeout(() => f(new Error('keine Antwort in 20 Sekunden')), 20_000))]);
    const sauber = (m: string) => m.replace(/(sk|key|token|bearer)[-_ ]?[A-Za-z0-9_.-]{8,}/gi, '$1-…').slice(0, 200);
    try {
      const a = await mitZeit(prov.chat([{ role: 'system', content: 'Antworte nur mit dem Wort OK.' }, { role: 'user', content: 'Verbindungstest' }], { onVerbrauch: (v) => { try { this.zaehler.ki(v, this.kiPreis()); } catch { /* */ } } }));
      if (!a.trim()) return { ok: false, meldung: 'Leere Antwort vom Anbieter' };
      if (p.art !== 'mock' && Kern.vektorenFuer({ ...this.cfg, provider: p }, prov)) {
        const v = await mitZeit(prov.embed(['Verbindungstest']));
        if (!v[0]?.length) return { ok: false, meldung: 'Embedding ohne Ergebnis' };
      }
      return { ok: true, meldung: p.art === 'mock' ? 'Ohne KI (Mock) verbunden' : 'Verbindung steht' };
    } catch (e) {
      return { ok: false, meldung: sauber((e as Error).message) };
    }
  }

  private constructor(
    readonly cfg: KernConfig,
    readonly dir: string,
    readonly git: Git,
    readonly ix: SuchIndex,
    provider: Provider,
  ) {
    // v1.4 3.4: jeder KI-Aufruf wird ohne Personenbezug gezählt
    this.zaehler = new Zaehler(join(dir, '.kern', 'zaehler.sqlite'), () => this.heuteDatum(), () => this.jetzt());
    const zaehlen = (v: { eingabeTokens: number; ausgabeTokens: number }) => {
      try { this.zaehler.ki(v, this.kiPreis()); } catch { /* Zählen darf nie eine Antwort verhindern */ }
    };
    this.inner = provider;
    const self = this;
    this.provider = {
      get name() { return self.inner.name; },
      embed: (t) => self.inner.embed(t),
      chat: (m, o) => self.inner.chat(m, { ...(o ?? {}), onVerbrauch: (v) => { zaehlen(v); o?.onVerbrauch?.(v); } }),
      rerank: (f: string, t: string[]) => (self.inner.rerank ? self.inner.rerank(f, t) : Promise.resolve(t.map(() => 0))),
    };
    if (!provider.rerank) delete (this.provider as { rerank?: unknown }).rerank;
    this.produkt = cfg.produktname?.trim() || 'Kern';
    this.vektorenAn = Kern.vektorenFuer(cfg, provider);
    this.benutzer = new Benutzerverwaltung(join(dir, '.kern', 'users.json'));
    this.zugang = new Zugangsspeicher(join(dir, '.kern', 'zugang.sqlite'), this.benutzer.holeSync, () => cfg.heute?.() ?? new Date());
    this.benutzer.zugang = this.zugang;
    this.zugangEinfach = new ZugangEinfach(this.zugang, this.benutzer.holeSync);
  }

  /* ================================================================ */
  /* Öffnen, Index                                                     */
  /* ================================================================ */

  static async open(cfg: KernConfig & { providerInstanz?: Provider; vektorErweiterung?: boolean }): Promise<Kern> {
    const dir = resolve(cfg.dataDir);
    for (const d of ['quellen', 'wissen', 'eingang/erledigt', 'briefing', '.kern']) await mkdir(join(dir, d), { recursive: true });
    const git = new Git(dir);
    await git.init();
    const gi = join(dir, '.gitignore');
    if (!existsSync(gi)) await writeFile(gi, '# Index und Benutzer gehören nicht ins Repository\n.kern/\n*.tmp\n.DS_Store\n.obsidian/workspace*.json\n');
    const ky = join(dir, 'kern.yaml');
    if (!existsSync(ky)) {
      const e: Einstellungen = {
        betrieb: cfg.betrieb,
        sprache: cfg.sprache,
        ki: ohneGeheimnisse(cfg.provider),
        teams: [],
        standard_sichtbarkeit: 'betrieb',
        regelpruefung_ki: true,
        produktname: cfg.produktname?.trim() || 'Kern',
      };
      await writeFile(ky, `# Einstellungen des Wissensordners. Schlüssel (apiKey) nie hier speichern, sondern über Umgebungsvariablen.\n${YAML.stringify(e)}`);
    }
    const ix = await SuchIndex.oeffne(join(dir, '.kern', 'index.sqlite'), { vektorErweiterung: cfg.vektorErweiterung ?? true });
    const provider = cfg.providerInstanz ?? erzeugeProvider(cfg.provider);
    const k = new Kern(cfg, dir, git, ix, provider);
    await k.benutzer.uebernimmAlteTokens();
    k.zugang.uebernimmServerTokens(join(dir, '.kern'));
    if (!(await git.head())) await git.commit(['.gitignore', 'kern.yaml'], k.produkt, 'Wissensordner angelegt');
    const kennung = k.kennung;
    if (ix.meta('embed') !== kennung || !ix.meta('gebaut')) {
      ix.setzeMeta('embed', kennung);
      await k.reindex();
    } else {
      await k.sperre.run(() => k.abgleich());
    }
    // Was außerhalb von Kern geändert wurde, während Kern nicht lief: übernehmen
    await k.sperre.run(async () => {
      const offen = (await git.offeneAenderungen(['wissen', 'quellen'])).filter((p) => !istReserviert(p));
      if (offen.length) await k.commitMitOrdnerIndex(offen, cfg.externerAutor ?? 'extern', 'extern geändert (beim Start erkannt)');
    });
    return k;
  }

  private get kennung(): string {
    if (!this.vektorenAn) return 'ohne-vektoren';
    return (this.cfg as { providerInstanz?: Provider }).providerInstanz ? `instanz:${this.provider.name}` : embedKennung(this.cfg.provider);
  }

  private heuteDatum(): string {
    return isoDatum(this.cfg.heute?.() ?? new Date());
  }
  private jetzt(): string {
    return (this.cfg.heute?.() ?? new Date()).toISOString();
  }

  private abs(p: string): string {
    const a = resolve(this.dir, sichererPfad(p));
    if (!a.startsWith(this.dir + sep)) throw new KernFehler('ungueltig', `Pfad außerhalb des Datenordners: ${p}`);
    return a;
  }

  private async lies(p: string): Promise<string | null> {
    try {
      return await readFile(this.abs(p), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  private async alleMarkdownDateien(): Promise<string[]> {
    const out: string[] = [];
    const lauf = async (rel: string) => {
      let eintraege;
      try {
        eintraege = await readdir(join(this.dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of eintraege) {
        if (e.name.startsWith('.')) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await lauf(p);
        else if (e.isFile() && e.name.endsWith('.md') && !e.name.includes('.orig.') && !istReserviert(p)) out.push(p);
      }
    };
    await lauf('wissen');
    await lauf('quellen');
    return out.sort();
  }

  /** Eine Datei (neu) indizieren. */
  private async indiziere(pfad: string, inhalt: string): Promise<void> {
    const art: 'wissen' | 'quelle' = pfad.startsWith('wissen/') ? 'wissen' : 'quelle';
    const p = parseMarkdown(inhalt);
    let e: DateiEintrag;
    let fakten: FaktZeile[] = [];
    if (art === 'wissen') {
      const { kopf, fehler } = normalisiereArtikelKopf(p.kopf, pfad, { besitzer: SYSTEM, heute: this.heuteDatum() });
      e = {
        pfad, art, titel: kopf.titel, sichtbarkeit: kopf.sichtbarkeit, besitzer: kopf.besitzer, sammlung: '', gruppe: kopf.gruppe, status: kopf.status,
        hash: sha256(inhalt), ersetzt: null, pruefen_bis: kopf.pruefen_bis,
        aktiv: pfad.startsWith('wissen/_regeln/') || kopf.status === 'veraltet' ? 0 : 1,
        fehler: [p.fehler, fehler].filter(Boolean).join('; ') || null, herkunft: null, quellhash: null, groesse: Buffer.byteLength(inhalt), verantwortlich: kopf.verantwortlich || null,
      };
      fakten = kopf.fakten ?? [];
    } else {
      const { kopf, fehler } = normalisiereQuellenKopf(p.kopf, pfad, { besitzer: SYSTEM, heute: this.heuteDatum() });
      e = {
        pfad, art, titel: kopf.titel, sichtbarkeit: kopf.sichtbarkeit, besitzer: kopf.erfasst_von, sammlung: kopf.sammlung, gruppe: '', status: '',
        hash: sha256(inhalt), ersetzt: kopf.ersetzt, pruefen_bis: null, aktiv: 1,
        fehler: [p.fehler, fehler].filter(Boolean).join('; ') || null, herkunft: kopf.herkunft || null, quellhash: kopf.hash || null, groesse: Buffer.byteLength(inhalt), verantwortlich: null,
      };
    }
    const abschnitte = bildeAbschnitte(p.text, p.kopfZeilen, e.titel);
    const vektoren = this.vektorenAn
      ? await this.ix.embedMitCache(abschnitte.map((a) => `${e.titel}\n${a.abschnitt}\n${a.text}`), this.kennung, (t) => this.provider.embed(t))
      : [];
    this.ix.schreibeDatei(e, abschnitte, vektoren, fakten);
  }

  /** Index mit den Dateien abgleichen (nur geänderte Dateien neu). */
  private async abgleich(): Promise<{ geaendert: string[] }> {
    const dateien = await this.alleMarkdownDateien();
    const bekannt = new Map(this.ix.dateien().map((d) => [d.pfad, d.hash]));
    const geaendert: string[] = [];
    for (const p of dateien) {
      const inhalt = (await this.lies(p)) ?? '';
      if (bekannt.get(p) !== sha256(inhalt)) {
        await this.indiziere(p, inhalt);
        geaendert.push(p);
      }
      bekannt.delete(p);
    }
    for (const p of bekannt.keys()) {
      this.ix.entferne(p);
      geaendert.push(p);
    }
    this.ix.aktualisiereErsetzt();
    return { geaendert };
  }

  async reindex(): Promise<{ dateien: number; abschnitte: number }> {
    return this.sperre.run(() => this.reindexIntern());
  }

  private async reindexIntern(): Promise<{ dateien: number; abschnitte: number }> {
    this.ix.leeren();
    const dateien = await this.alleMarkdownDateien();
    for (const p of dateien) await this.indiziere(p, (await this.lies(p)) ?? '');
    this.ix.aktualisiereErsetzt();
    this.ix.setzeMeta('gebaut', this.jetzt());
    return { dateien: dateien.length, abschnitte: this.ix.anzahlAbschnitte() };
  }

  /**
   * Erweiterung (Art. 17 DSGVO, nur admin): Datei samt Original aus Arbeitsstand UND git-Verlauf entfernen.
   * Vorschläge im Eingang, die die Datei nennen, verschwinden mit; Pfad und Titel werden in Protokollen,
   * Verzeichnissen und Commit-Nachrichten durch „[gelöscht]“ ersetzt. Danach Index neu (Embedding-Cache geleert).
   * Achtung: Alle Commit-Kennungen ändern sich; Kopien des Ordners (Backups, Klone) müssen separat bereinigt werden.
   */
  /**
   * Endgültig löschen (Art. 17 DSGVO, S1 M6), nur admin: die Datei, alle Fassungen der `ersetzt`-Kette, Originale und
   * Vorschläge dazu verschwinden aus Arbeitsstand und Verlauf. Titel werden nur in index.md, log.md und eingang/ ersetzt.
   * Artikel und Fakten, die sich darauf stützen, bleiben unverändert und bekommen einen Bereinigungsvorschlag im Eingang.
   */
  async loescheEndgueltig(u: User, pfad: string, grund: string): Promise<{ entfernt: string[]; commit: string | null; bereinigung: Vorschlag[]; hinweise: string[] }> {
    brauchtRolle(u, 'admin', 'endgültig löschen');
    if (!grund.trim()) throw new KernFehler('ungueltig', 'Grund fehlt');
    const p = sichererPfad(pfad);
    if (!/^(wissen|quellen)\/.+\.md$/.test(p) || istReserviert(p) || p.includes('.orig.')) throw new KernFehler('ungueltig', 'Nur Artikel und Quellen (Markdown) können endgültig gelöscht werden');
    const ergebnis = await this.sperre.run(async () => {
      const d = this.ix.datei(p);
      const inhalt = await this.lies(p);
      if (!d && inhalt === null) throw new KernFehler('nicht_gefunden', `${p} nicht gefunden`);
      // ganze Fassungskette (ältere und neuere Fassungen derselben Quelle)
      const alle = this.ix.dateien();
      const kette = new Set<string>([p]);
      for (let geaendert = true; geaendert; ) {
        geaendert = false;
        for (const x of alle) {
          if (kette.has(x.pfad) && x.ersetzt && !kette.has(x.ersetzt)) { kette.add(x.ersetzt); geaendert = true; }
          if (x.ersetzt && kette.has(x.ersetzt) && !kette.has(x.pfad)) { kette.add(x.pfad); geaendert = true; }
        }
      }
      const titel = new Set<string>();
      for (const x of kette) {
        const t = this.ix.datei(x)?.titel ?? String(parseMarkdown((await this.lies(x)) ?? '').kopf['titel'] ?? '');
        if (t.length >= 3) titel.add(t);
      }
      // offene Änderungen zuerst sichern (filter-branch braucht einen sauberen Stand)
      const offen = (await this.git.offeneAenderungen(['.'])).filter((x) => !kette.has(x));
      if (offen.length) await this.commitMitOrdnerIndex(offen, this.cfg.externerAutor ?? 'extern', 'extern geändert (vor endgültigem Löschen)');
      const eigeneOffen = await this.git.offeneAenderungen([...kette]);
      if (eigeneOffen.length) await this.git.commit(eigeneOffen, u.name, 'Zwischenstand vor endgültigem Löschen');
      const entfernt: string[] = [];
      for (const x of kette) {
        entfernt.push(x);
        const basis = posix.basename(x, '.md');
        try {
          for (const e of await readdir(dirname(this.abs(x)))) if (e.startsWith(`${basis}.orig.`)) entfernt.push(`${posix.dirname(x)}/${e}`);
        } catch {
          /* Ordner fehlt */
        }
      }
      const ersetzen = [...titel].flatMap((t) => [`[${t}]`, `: ${t}`, `„${t}“`]);
      await this.git.entferneAusVerlauf(entfernt, ersetzen);
      for (const x of entfernt) await rm(this.abs(x), { force: true });
      this.ix.db.exec('DELETE FROM emb_cache');
      await this.reindexIntern();
      this.ix.db.exec('VACUUM');
      const am = this.jetzt();
      const hinweise = [
        'Sicherungen (Backups) enthalten die Datei weiter, bis sie nach höchstens 12 Monaten auslaufen; ein Rückspielen muss die Löschung wiederholen.',
        ...(this.cfg.provider.art !== 'mock' ? [`An den KI-Anbieter (${this.modellInfo().anbieter}) gesendete Abschnitte und Einbettungen unterliegen dessen Löschfristen.`] : []),
        'Klone dieses Ordners (andere Rechner, Exporte, Umzugspakete) müssen getrennt gelöscht werden.',
      ];
      const commit = await this.commitMitOrdnerIndex(
        [p],
        u.name,
        'Datei endgültig gelöscht',
        `Grund: ${grund.trim()}. Von ${u.name} am ${am}. ${entfernt.length} Dateien samt Verlauf entfernt (${kette.size} Fassungen).\n\n${hinweise.join('\n')}`,
        `Datei endgültig gelöscht (${u.name}, ${am}). Grund: ${grund.trim().replace(/\n+/g, ' ')}`,
      );
      return { entfernt, commit, hinweise, kette };
    });
    // abgeleitete Artikel und Fakten: Bereinigungsvorschlag statt stiller Änderung
    const bereinigung: Vorschlag[] = [];
    if (p.startsWith('quellen/')) {
      for (const d of this.ix.dateien().filter((x) => x.art === 'wissen')) {
        const text = await this.lies(d.pfad);
        if (!text) continue;
        const a = this.parseArtikel(d.pfad, text);
        const weg = a.kopf.fundstellen.filter((f) => ergebnis.kette.has(f.quelle));
        if (!weg.length) continue;
        const ids = new Set(weg.map((f) => f.id));
        const kopf: ArtikelKopf = { ...a.kopf, fundstellen: a.kopf.fundstellen.filter((f) => !ids.has(f.id)) };
        if (kopf.fakten) kopf.fakten = kopf.fakten.filter((f) => !ids.has(f.fundstelle));
        const rumpf = a.text.replace(/\[\^([\w-]+)\]/g, (m, id: string) => (ids.has(id) ? '' : m));
        try {
          bereinigung.push(await this.legeVorschlagAn(u, { art: 'aenderung', ziel: d.pfad, alt: text, neu: stringifyMarkdown(ordneArtikelKopf(kopf), rumpf), grund: 'Bereinigung nach endgültigem Löschen einer Quelle: Fundstellen und Fakten daraus entfernen, Text prüfen' }));
        } catch {
          /* z. B. offener Vorschlag schon vorhanden */
        }
      }
    }
    return { entfernt: ergebnis.entfernt, commit: ergebnis.commit, bereinigung, hinweise: ergebnis.hinweise };
  }

  /* ================================================================ */
  /* Schreiben + Commit (immer unter der Sperre aufrufen)              */
  /* ================================================================ */

  private async schreibeDateien(aenderungen: Aenderung[]): Promise<void> {
    for (const a of aenderungen) {
      const ziel = this.abs(a.pfad);
      if (a.inhalt === null) {
        await rm(ziel, { force: true });
        continue;
      }
      await mkdir(dirname(ziel), { recursive: true });
      const tmp = `${ziel}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, a.inhalt);
      await rename(tmp, ziel);
    }
  }

  /** index.md und log.md der betroffenen Ordner erneuern, dann alles committen. */
  private async commitMitOrdnerIndex(pfade: string[], autor: string, grund: string, text?: string, logText?: string): Promise<string | null> {
    // Index für geänderte Markdown-Dateien nachziehen
    for (const p of pfade) {
      if (!/^(wissen|quellen)\//.test(p) || !p.endsWith('.md') || p.includes('.orig.') || istReserviert(p)) continue;
      const inhalt = await this.lies(p);
      if (inhalt === null) this.ix.entferne(p);
      else if (this.ix.datei(p)?.hash !== sha256(inhalt)) await this.indiziere(p, inhalt);
    }
    this.ix.aktualisiereErsetzt();
    const ordner = new Set<string>();
    for (const p of pfade) for (const o of betroffeneOrdner(p)) ordner.add(o);
    const extra: string[] = [];
    if (ordner.size) {
      const dateien = this.ix.dateien();
      const kurz = new Map<string, string>();
      for (const d of dateien.filter((x) => x.art === 'wissen')) {
        const i = await this.lies(d.pfad);
        if (i) kurz.set(d.pfad, String(parseMarkdown(i).kopf['kurzfassung'] ?? ''));
      }
      for (const o of ordner) {
        const ip = o ? `${o}/index.md` : 'index.md';
        const lp = o ? `${o}/log.md` : 'log.md';
        const idx = erzeugeIndex(o, dateien, this.cfg.betrieb, kurz, this.produkt);
        if ((await this.lies(ip)) !== idx) {
          await this.schreibeDateien([{ pfad: ip, inhalt: idx }]);
          extra.push(ip);
        }
        const betroffen = pfade.filter((p) => (o === '' ? true : p.startsWith(o + '/')) && p.endsWith('.md') && !istReserviert(p));
        if (betroffen.length) {
          const namen = betroffen
            .slice(0, 5)
            .map((p) => {
              const d = this.ix.datei(p);
              return d && d.sichtbarkeit === 'betrieb' ? `[${d.titel}](/${p})` : d ? (d.sichtbarkeit === 'ich' ? '(private Notiz)' : '(Datei mit Team-Sichtbarkeit)') : '(entfernt)';
            })
            .join(', ');
          // S1 N1/P2: Grund nennt oft den Titel; bei eingeschränkter Sichtbarkeit nur ein allgemeiner Text
          const eingeschraenkt = betroffen.some((p) => { const d = this.ix.datei(p); return !d || d.sichtbarkeit !== 'betrieb'; });
          const eintrag = logText ?? `${eingeschraenkt ? 'Änderung' : grund} (${autor}): ${namen}${betroffen.length > 5 ? ` und ${betroffen.length - 5} weitere` : ''}`;
          const log = ergaenzeLog(await this.lies(lp), this.heuteDatum(), eintrag, o ? `Protokoll ${o}` : 'Protokoll', this.produkt);
          await this.schreibeDateien([{ pfad: lp, inhalt: log }]);
          extra.push(lp);
        }
      }
    }
    return this.git.commit([...pfade, ...extra], autor, grund, text);
  }

  private async schreibeUndCommitte(aenderungen: Aenderung[], autor: string, grund: string, text?: string): Promise<string | null> {
    await this.schreibeDateien(aenderungen);
    return this.commitMitOrdnerIndex(aenderungen.map((a) => a.pfad), autor, grund, text);
  }

  /* ================================================================ */
  /* Lesen                                                             */
  /* ================================================================ */

  private parseArtikel(pfad: string, inhalt: string): Artikel {
    const p = parseMarkdown(inhalt);
    const { kopf } = normalisiereArtikelKopf(p.kopf, pfad, { besitzer: SYSTEM, heute: this.heuteDatum() });
    return { pfad, kopf, text: p.text.replace(/^\n+/, '') };
  }
  private parseQuelle(pfad: string, inhalt: string): Quelle {
    const p = parseMarkdown(inhalt);
    const { kopf } = normalisiereQuellenKopf(p.kopf, pfad, { besitzer: SYSTEM, heute: this.heuteDatum() });
    return { pfad, kopf, text: p.text.replace(/^\n+/, '') };
  }

  private sichtbareDateien(u: User, art?: 'wissen' | 'quelle', reichweite?: Reichweite): DateiEintrag[] {
    return this.ix.dateien().filter((d) => (!art || d.art === art) && inReichweite(u, d.sichtbarkeit, d.besitzer, reichweite));
  }

  async listeWissen(u: User, filter: { gruppe?: string } = {}): Promise<Artikel[]> {
    const out: Artikel[] = [];
    for (const d of this.sichtbareDateien(u, 'wissen')) {
      if (filter.gruppe && d.gruppe !== filter.gruppe) continue;
      const i = await this.lies(d.pfad);
      if (i !== null) out.push(this.parseArtikel(d.pfad, i));
    }
    return out.sort((a, b) => a.kopf.gruppe.localeCompare(b.kopf.gruppe, 'de') || a.kopf.titel.localeCompare(b.kopf.titel, 'de'));
  }

  async leseArtikel(u: User, pfad: string): Promise<Artikel> {
    const p = sichererPfad(pfad);
    const d = this.ix.datei(p);
    if (!p.startsWith('wissen/') || !d || !darfSehen(u, d.sichtbarkeit, d.besitzer)) throw new KernFehler('nicht_gefunden', `Artikel ${p} nicht gefunden`);
    const i = await this.lies(p);
    if (i === null) throw new KernFehler('nicht_gefunden', `Artikel ${p} nicht gefunden`);
    return this.parseArtikel(p, i);
  }

  async listeQuellen(u: User, filter: { sammlung?: string; mitErsetzten?: boolean } = {}): Promise<Quelle[]> {
    const out: Quelle[] = [];
    for (const d of this.sichtbareDateien(u, 'quelle')) {
      if (filter.sammlung && d.sammlung !== filter.sammlung) continue;
      if (!filter.mitErsetzten && !d.aktiv) continue;
      const i = await this.lies(d.pfad);
      if (i !== null) out.push(this.parseQuelle(d.pfad, i));
    }
    return out.sort((a, b) => b.kopf.erfasst_am.localeCompare(a.kopf.erfasst_am) || a.pfad.localeCompare(b.pfad));
  }

  /** Erweiterung: eine Quelle lesen. */
  async leseQuelle(u: User, pfad: string): Promise<Quelle> {
    const p = sichererPfad(pfad);
    const d = this.ix.datei(p);
    if (!p.startsWith('quellen/') || !d || !darfSehen(u, d.sichtbarkeit, d.besitzer)) throw new KernFehler('nicht_gefunden', `Quelle ${p} nicht gefunden`);
    const i = await this.lies(p);
    if (i === null) throw new KernFehler('nicht_gefunden', `Quelle ${p} nicht gefunden`);
    return this.parseQuelle(p, i);
  }

  /** Erweiterung: Original-Datei einer Quelle (absoluter Pfad), falls vorhanden. */
  async original(u: User, pfad: string): Promise<{ datei: string; name: string; ext: string } | null> {
    const q = await this.leseQuelle(u, pfad);
    const basis = q.pfad.replace(/\.md$/, '');
    const ordner = dirname(this.abs(q.pfad));
    const name = posix.basename(basis);
    for (const e of await readdir(ordner)) {
      if (e.startsWith(`${name}.orig.`)) {
        const ext = e.slice(name.length + 6);
        const herkunft = q.kopf.herkunft && !/^https?:/.test(q.kopf.herkunft) ? posix.basename(q.kopf.herkunft) : `${name}.${ext}`;
        return { datei: join(ordner, e), name: herkunft, ext };
      }
    }
    return null;
  }

  /* ================================================================ */
  /* Suche                                                             */
  /* ================================================================ */

  private erlaubtePfade(u: User, opt: { reichweite?: Reichweite; sammlung?: string; art?: 'wissen' | 'quelle' }): string[] {
    return this.sichtbareDateien(u, opt.art, opt.reichweite)
      .filter((d) => !opt.sammlung || (d.art === 'quelle' ? d.sammlung === opt.sammlung : d.gruppe === opt.sammlung))
      .map((d) => d.pfad);
  }

  private async rohSuche(u: User, q: string, opt: { reichweite?: Reichweite; sammlung?: string; limit?: number; art?: 'wissen' | 'quelle' }): Promise<RohTreffer[]> {
    const erlaubt = this.erlaubtePfade(u, opt);
    if (!erlaubt.length || !q.trim()) return [];
    const limit = opt.limit ?? 10;
    const fts = this.ix.fts(q, erlaubt, 50);
    const tri = this.ix.trigramm(q, erlaubt, 50);
    let vek: RohTreffer[] = [];
    if (this.vektorenAn) {
      const [qv] = await this.ix.embedMitCache([q], this.kennung, (t) => this.provider.embed(t));
      vek = qv ? this.ix.vektor(qv, erlaubt, 50) : [];
    }
    let liste = rrf([fts, tri, vek]);
    if (this.provider.rerank && liste.length > 1) {
      const kopf = liste.slice(0, Math.max(limit * 2, 20));
      const scores = await this.provider.rerank(q, kopf.map((t) => `${t.titel} ${t.abschnitt}\n${t.text}`));
      const neu = kopf.map((t, i) => ({ ...t, score: (scores[i] ?? 0) + t.score / 1000 })).sort((a, b) => b.score - a.score || a.id - b.id);
      liste = [...neu, ...liste.slice(kopf.length)];
    }
    return liste.slice(0, limit);
  }

  async suche(u: User, q: string, opt: { reichweite?: Reichweite; sammlung?: string; limit?: number } = {}): Promise<Treffer[]> {
    const roh = await this.rohSuche(u, q, opt);
    return roh.map((t) => ({
      pfad: t.pfad,
      art: t.art,
      titel: t.titel,
      abschnitt: t.abschnitt,
      zeilen: [t.von, t.bis] as [number, number],
      ausschnitt: ausschnitt(t.text, q),
      score: Math.round(t.score * 1e6) / 1e6,
    }));
  }

  /* ================================================================ */
  /* Fakten                                                            */
  /* ================================================================ */

  private async zitatAusZeilen(quelle: string, von: number, bis: number): Promise<string | null> {
    const i = await this.lies(quelle);
    if (i === null) return null;
    const z = i.split(/\r?\n/);
    if (von < 1 || bis > z.length || von > bis) return null;
    return kuerze(z.slice(von - 1, bis).join('\n').trim(), 600);
  }

  private async loeseFundstelle(artikelPfad: string, kopf: ArtikelKopf, f: FaktEintrag): Promise<Fundstelle | null> {
    const fs = kopf.fundstellen.find((x) => x.id === f.fundstelle);
    if (fs) {
      const zitat = await this.zitatAusZeilen(fs.quelle, fs.zeilen[0], fs.zeilen[1]);
      if (zitat !== null) return { quelle: fs.quelle, abschnitt: fs.abschnitt, zeilen: fs.zeilen, zitat };
    }
    // Rückfall: die Zeilen des Fakts im Artikelkopf selbst (wörtlich)
    const inhalt = (await this.lies(artikelPfad)) ?? '';
    const z = inhalt.split('\n');
    const start = z.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*["']?${f.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`).test(l));
    if (start < 0) return null;
    let ende = start + 1;
    while (ende < z.length && !/^\s*-\s/.test(z[ende]!) && /^\s{2,}\S/.test(z[ende]!)) ende++;
    return { quelle: artikelPfad, abschnitt: `${kopf.titel} › Fakten`, zeilen: [start + 1, ende], zitat: z.slice(start, ende).join('\n').trim() };
  }

  async fakten(u: User, filter: { art?: string; gegenstand?: string; gueltigAm?: string; reichweite?: Reichweite } = {}): Promise<Fakt[]> {
    const stichtag = filter.gueltigAm ?? this.heuteDatum();
    const zeilen = this.ix.fakten(this.erlaubtePfade(u, { art: 'wissen', ...(filter.reichweite ? { reichweite: filter.reichweite } : {}) }));
    const ersetzteIds = new Set(zeilen.filter((f) => f.ersetzt && (!f.gilt_ab || f.gilt_ab <= stichtag)).map((f) => f.ersetzt!));
    const kopfCache = new Map<string, ArtikelKopf>();
    const out: Fakt[] = [];
    for (const f of zeilen) {
      if (filter.art && f.art !== filter.art) continue;
      if (filter.gegenstand) {
        const g = filter.gegenstand.toLowerCase();
        if (!f.gegenstand.toLowerCase().includes(g) && ueberdeckung(filter.gegenstand, f.gegenstand) < 0.5) continue;
      }
      const gueltig = (!f.gilt_ab || f.gilt_ab <= stichtag) && (!f.gilt_bis || f.gilt_bis >= stichtag) && !ersetzteIds.has(f.id);
      if (filter.gueltigAm && !gueltig) continue;
      let kopf = kopfCache.get(f.pfad);
      if (!kopf) {
        const i = await this.lies(f.pfad);
        if (i === null) continue;
        kopf = this.parseArtikel(f.pfad, i).kopf;
        kopfCache.set(f.pfad, kopf);
      }
      const eintrag: FaktEintrag = {
        id: f.id, art: f.art as FaktEintrag['art'], gegenstand: f.gegenstand, wert: f.wert,
        ...(f.einheit != null ? { einheit: f.einheit } : {}), gilt_ab: f.gilt_ab ?? null, gilt_bis: f.gilt_bis ?? null, ersetzt: f.ersetzt ?? null, fundstelle: f.fundstelle,
      };
      out.push({ ...eintrag, artikel: f.pfad, artikelTitel: f.titel, gueltig, beleg: await this.loeseFundstelle(f.pfad, kopf, eintrag) });
    }
    return out;
  }

  /* ================================================================ */
  /* Frage                                                             */
  /* ================================================================ */

  private async regeln(): Promise<{ regeln: Regel[]; vorhanden: boolean }> {
    const i = await this.lies(REGEL_DATEI);
    if (i === null) return { regeln: [], vorhanden: false };
    const h = sha256(i);
    if (this.regelCache?.hash !== h) {
      const p = parseMarkdown(i);
      this.regelCache = { hash: h, regeln: leseRegeln(p.text, p.kopfZeilen) };
    }
    return { regeln: this.regelCache.regeln, vorhanden: true };
  }

  /** Erweiterung: prüft eine Eingabe gegen `wissen/_regeln/was-nie-hineinkommt.md` (nur Schlüsselwort-/Musterregeln). */
  async pruefeRegeln(eingabe: string): Promise<{ regel: string; zeile: number } | null> {
    const r = verletzteRegel((await this.regeln()).regeln, eingabe);
    return r ? { regel: r.text, zeile: r.zeile } : null;
  }

  private einstellungenSync: Einstellungen | null = null;
  private async regelpruefungKi(): Promise<boolean> {
    const e = this.einstellungenSync ?? (await this.leseEinstellungen());
    return e.regelpruefung_ki !== false;
  }

  /* ================================================================ */
  /* v1.4 Abschnitt 7: Export, Umzug, Ausstiegsprobe                   */
  /* ================================================================ */

  /** v1.4 7.1: Export als Datei `ziel` (okf | zip | umzugspaket), Rechte nach Art. */
  exportiere(u: User, e: { art: ExportArt; ziel: string; passphrase?: string; instanz?: string }) {
    return exportiereDatei(this, u, e);
  }

  /** v1.4 7.2: nach `umzugAuspacken` und `Kern.open`: Zugänge übernehmen und prüfen (schreibt .kern/pruefbericht.json). */
  umzugPruefen(u: User): Promise<Pruefbericht> {
    return umzugPruefenIntern(this, u);
  }

  /** v1.4 7.3: Ausstiegsprobe (admin): Umzugspaket in einen leeren Ordner und zurückprüfen, OKF ohne Kern lesbar. */
  ausstiegsprobe(u: User): Promise<Ausstiegsprobe> {
    const { providerInstanz } = this.cfg as { providerInstanz?: Provider };
    return ausstiegsprobeIntern(this, u, (dir) => Kern.open({ ...this.cfg, dataDir: dir, ...(providerInstanz ? { providerInstanz } : {}) }));
  }

  /** Ergebnis der Ausstiegsprobe ablegen (pruefung/ausstieg/<datum>.json, git, nie indiziert). */
  async speichereAusstiegsprobe(u: User, probe: Ausstiegsprobe): Promise<string> {
    const pfad = `pruefung/ausstieg/${probe.am.slice(0, 10)}.json`;
    await this.sperre.run(async () => {
      await this.schreibeDateien([{ pfad, inhalt: JSON.stringify(probe, null, 2) + '\n' }]);
      await this.git.commit([pfad], u.name, `Ausstiegsprobe ${probe.bestanden ? 'bestanden' : 'nicht bestanden'}`);
    });
    return pfad;
  }

  /** Letzte Ausstiegsprobe oder null. */
  async letzteAusstiegsprobe(): Promise<Ausstiegsprobe | null> {
    const namen = (await readdir(join(this.dir, 'pruefung', 'ausstieg')).catch(() => [] as string[])).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
    const n = namen.at(-1);
    return n ? (JSON.parse((await this.lies(`pruefung/ausstieg/${n}`)) ?? 'null') as Ausstiegsprobe | null) : null;
  }

  /* ================================================================ */
  /* v1.4 4.1, 4.3: Vorschlagsfragen, Beispielsammlung                 */
  /* ================================================================ */

  /** v1.4 4.1: höchstens 3 Fragen aus den neuesten sichtbaren Quellen (Fakten zuerst, dann Überschriften), deterministisch. */
  async vorschlagsfragen(u: User): Promise<string[]> {
    const quellen = this.sichtbareDateien(u, 'quelle').filter((d) => d.aktiv);
    const mitDatum: { d: DateiEintrag; am: string }[] = [];
    for (const d of quellen) mitDatum.push({ d, am: String(parseMarkdown((await this.lies(d.pfad)) ?? '').kopf['erfasst_am'] ?? '') });
    mitDatum.sort((a, b) => b.am.localeCompare(a.am) || a.d.pfad.localeCompare(b.d.pfad));
    const out: string[] = [];
    const schon = new Set<string>();
    const dazu = (f: string) => {
      const k = f.toLowerCase();
      if (out.length < 3 && !schon.has(k)) { schon.add(k); out.push(f); }
    };
    for (const f of (await this.fakten(u)).filter((x) => x.gueltig).slice(0, 2)) dazu(`Was gilt für ${f.gegenstand}?`);
    for (const { d } of mitDatum.slice(0, 5)) {
      for (const a of this.ix.abschnitteVon(d.pfad)) {
        const h = a.abschnitt.replace(/\s+/g, ' ').trim();
        if (!h || h === d.titel || h.length < 4 || h.length > 70 || /^seite \d+$/i.test(h)) continue;
        dazu(/\?$/.test(h) ? h : `Was steht zu „${h}“?`);
      }
      if (this.ix.abschnitteVon(d.pfad).length && d.titel.length <= 70) dazu(`Was steht in „${d.titel}“?`);
      if (out.length >= 3) break;
    }
    return out;
  }

  /** v1.4 4.3: Ist die Beispielsammlung geladen? */
  beispielGeladen(): boolean {
    return this.ix.dateien().some((d) => d.art === 'quelle' && d.sammlung === BEISPIEL_SAMMLUNG);
  }

  /**
   * v1.4 4.3: Beispielsammlung `beispiel` laden (admin), ohne Demo-Benutzer, mit einem absichtlichen Widerspruch und
   * einer Fangfrage. Quellen plus Vorschläge im Eingang wie bei echten Unterlagen.
   */
  async beispielLaden(u: User): Promise<{ quellen: Quelle[]; vorschlaege: Vorschlag[]; fragen: string[]; fangfrage: string; widerspruch: string }> {
    brauchtRolle(u, 'admin', 'die Beispielsammlung laden');
    if (this.beispielGeladen()) throw new KernFehler('konflikt', 'Die Beispielsammlung ist schon geladen');
    const quellen: Quelle[] = [];
    const vorschlaege: Vorschlag[] = [];
    for (const b of BEISPIEL_TEXTE) {
      const r = await this.fuegeHinzu(u, { art: 'text', titel: b.titel, inhalt: b.text, sammlung: BEISPIEL_SAMMLUNG, sichtbarkeit: 'betrieb' });
      quellen.push(r.quelle);
      vorschlaege.push(...r.vorschlaege);
    }
    return { quellen, vorschlaege, fragen: BEISPIEL_FRAGEN, fangfrage: BEISPIEL_FANGFRAGE, widerspruch: 'Zahlungsziel: 14 Tage (Preisblatt) gegen 30 Tage (alte Notiz)' };
  }

  /** v1.4 4.3: Beispielsammlung ohne Rest entfernen (admin): Quellen, daraus entstandene Artikel und Vorschläge, auch aus dem Verlauf. */
  async beispielEntfernen(u: User): Promise<{ entfernt: number }> {
    brauchtRolle(u, 'admin', 'die Beispielsammlung entfernen');
    const quellen = new Set(this.ix.dateien().filter((d) => d.art === 'quelle' && d.sammlung === BEISPIEL_SAMMLUNG).map((d) => d.pfad));
    let n = 0;
    // Artikel, die sich nur auf Beispielquellen stützen
    for (const d of this.ix.dateien().filter((x) => x.art === 'wissen')) {
      const a = this.parseArtikel(d.pfad, (await this.lies(d.pfad)) ?? '');
      if (a.kopf.fundstellen.length && a.kopf.fundstellen.every((f) => quellen.has(f.quelle))) {
        await this.loescheEndgueltig(u, d.pfad, 'Beispielsammlung entfernt');
        n++;
      }
    }
    for (const q of quellen) {
      if (!this.ix.datei(q)) continue;
      await this.loescheEndgueltig(u, q, 'Beispielsammlung entfernt');
      n++;
    }
    // Bereinigungsvorschläge zu Beispielen sind gegenstandslos
    for (const v of await this.offeneVorschlaege()) if (v.grund.startsWith('Bereinigung nach endgültigem Löschen') && !(await this.lies(v.ziel))) await this.entscheide(u, v.id, { aktion: 'ablehnen', begruendung: 'Beispielsammlung entfernt' }).catch(() => undefined);
    return { entfernt: n };
  }

  /** Preis des aktiven Anbieters in Cent je Million Tokens (kern.yaml `ki.preis_cent_je_mio` oder KernConfig), sonst null. */
  private kiPreis(): { ein: number; aus: number } | null {
    const ki = (this.einstellungenSync?.['ki'] ?? null) as { preis_cent_je_mio?: { ein?: number; aus?: number } } | null;
    const p = this.cfg.kiPreis ?? ki?.preis_cent_je_mio ?? null;
    return p && Number.isFinite(Number(p.ein)) && Number.isFinite(Number(p.aus)) ? { ein: Number(p.ein), aus: Number(p.aus) } : null;
  }

  /** v1.4 3.4: KI-Verbrauch dieser Instanz (Tag, Monat), ohne Personenbezug. */
  async verbrauch(): Promise<Verbrauch> {
    if (!this.einstellungenSync) await this.leseEinstellungen();
    return this.zaehler.verbrauch();
  }

  /**
   * Nutzung der Instanz für `/_betrieb/*` (v1.4 0.1): nur Zahlen, nie Titel, Pfade, Namen oder Inhalte.
   */
  async nutzung(): Promise<{ speicher_bytes: number; artikel: number; quellen: number; vorschlaege_offen: number; nutzer: number; zugaenge_oauth: number; ki: Verbrauch }> {
    const groesse = async (abs: string): Promise<number> => {
      let n = 0;
      for (const e of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
        const p = join(abs, e.name);
        if (e.isDirectory()) n += await groesse(p);
        else if (e.isFile()) n += (await stat(p).catch(() => ({ size: 0 }))).size;
      }
      return n;
    };
    const d = this.ix.dateien();
    const jetzt = new Date().toISOString();
    const admin: User = { id: '_betrieb', name: 'betrieb', rollen: ['admin'], teams: [] };
    let oauth = 0;
    for (const b of await this.benutzer.liste()) oauth += this.zugang.liste(admin, b.id, { art: ['oauth_zugriff', 'oauth_erneuerung'] }).filter((t) => !t.laeuftAb || t.laeuftAb >= jetzt).length;
    return {
      speicher_bytes: await groesse(this.dir),
      artikel: d.filter((x) => x.art === 'wissen').length,
      quellen: d.filter((x) => x.art === 'quelle' && x.aktiv).length,
      vorschlaege_offen: (await this.offeneVorschlaege()).length,
      nutzer: (await this.benutzer.liste()).length,
      zugaenge_oauth: oauth,
      ki: await this.verbrauch(),
    };
  }

  /** D-L13: Anbieter und Modell der aktiven KI. */
  modellInfo(): { anbieter: string; name: string } {
    const p = this.cfg.provider;
    if ((this.cfg as { providerInstanz?: Provider }).providerInstanz) return { anbieter: this.provider.name, name: this.provider.name };
    if (p.art === 'mock') return { anbieter: 'mock', name: 'mock' };
    return { anbieter: p.art, name: p.chatModell };
  }

  async frage(u: User, frage: string, opt: { reichweite?: Reichweite; sammlung?: string } = {}): Promise<Antwort> {
    const a = await this.frageIntern(u, frage, opt);
    try {
      this.zaehler.ereignis(a.status === 'beantwortet' ? 'antwort_belegt' : a.status === 'gehoert_nicht_hierher' ? 'antwort_gehoert_nicht_hierher' : 'antwort_steht_nicht_drin');
    } catch { /* nur Statistik */ }
    // S1 M4: Web-Quellen im Beleg kenntlich machen
    const belege = a.belege.map((b) => (/^https?:\/\//.test(this.ix.datei(b.quelle)?.herkunft ?? '') ? { ...b, web: true } : b));
    return { ...a, belege };
  }

  private async frageIntern(u: User, frage: string, opt: { reichweite?: Reichweite; sammlung?: string }): Promise<Antwort> {
    const ohneKi = { ki_erzeugt: false, modell: null } as const;
    const mitKi = { ki_erzeugt: true, modell: this.modellInfo() };
    const f = frage.trim();
    if (!f) return { status: 'steht_nicht_drin', punkte: [], belege: [], hinweis: HINWEIS.eingabe, ...ohneKi };

    // 1. Gehört das überhaupt hierher?
    const { regeln, vorhanden } = await this.regeln();
    const verletzt = verletzteRegel(regeln, f);
    if (verletzt) {
      return {
        status: 'gehoert_nicht_hierher',
        punkte: [],
        belege: [{ quelle: REGEL_DATEI, abschnitt: verletzt.abschnitt || 'Was nie hineinkommt', zeilen: [verletzt.zeile, verletzt.zeile], zitat: verletzt.text }],
        hinweis: HINWEIS.regel,
        ...ohneKi,
      };
    }
    if (vorhanden && (await this.regelpruefungKi())) {
      try {
        const inhalt = (await this.lies(REGEL_DATEI)) ?? '';
        const roh = await this.provider.chat(
          [
            { role: 'system', content: 'AUFGABE: REGELPRUEFUNG\nPrüfe, ob die Frage Informationen verlangt, die laut den Regeln nie in den Wissensordner gehören. Antworte als JSON {"verstoss": boolean, "regel": string|null}. Im Zweifel verstoss=false.' },
            { role: 'user', content: `=== REGELN\n${parseMarkdown(inhalt).text}\n=== FRAGE\n${f}` },
          ],
          { json: true },
        );
        const r = modellRegelSchema.safeParse(extrahiereJson(roh));
        if (r.success && r.data.verstoss) {
          const regelText = r.data.regel ?? '';
          const treffer = regeln.find((x) => regelText && (x.text.includes(regelText) || regelText.includes(x.text))) ?? null;
          return {
            status: 'gehoert_nicht_hierher',
            punkte: [],
            belege: treffer ? [{ quelle: REGEL_DATEI, abschnitt: treffer.abschnitt || 'Was nie hineinkommt', zeilen: [treffer.zeile, treffer.zeile], zitat: treffer.text }] : [],
            hinweis: HINWEIS.regel,
            ...mitKi,
          };
        }
      } catch {
        /* KI-Prüfung ist nur Zusatz */
      }
    }

    // 2. Faktenschicht zuerst
    const alleFakten = (await this.fakten(u, { gueltigAm: this.heuteDatum(), ...(opt.reichweite ? { reichweite: opt.reichweite } : {}) })).filter((x) => x.beleg && (!opt.sammlung || this.ix.datei(x.artikel)?.gruppe === opt.sammlung));
    const bewertet = alleFakten.map((x) => ({ x, s: ueberdeckung(x.gegenstand, f) })).filter((y) => y.s >= 0.6);
    if (bewertet.length) {
      const best = Math.max(...bewertet.map((y) => y.s));
      const gewaehlt = bewertet.filter((y) => y.s === best).slice(0, 3).map((y) => y.x);
      const belege: Fundstelle[] = [];
      const punkte = gewaehlt.map((x) => {
        belege.push(x.beleg!);
        const wert = `${typeof x.wert === 'boolean' ? (x.wert ? 'ja' : 'nein') : x.wert}${x.einheit ? ` ${x.einheit}` : ''}`;
        const zeit = [x.gilt_ab ? `gilt ab ${x.gilt_ab}` : '', x.gilt_bis ? `gilt bis ${x.gilt_bis}` : ''].filter(Boolean).join(', ');
        return { text: `${x.gegenstand}: ${wert}${zeit ? ` (${zeit})` : ''}`, belege: [belege.length] };
      });
      return { status: 'beantwortet', punkte: punkte.map((p) => ({ ...p, gestuetzt: 'ja' as const })), belege, hinweis: HINWEIS.fakten, ...ohneKi };
    }

    // 3. Retrieval
    const treffer = await this.rohSuche(u, f, { ...opt, limit: 8 });
    if (!treffer.length) return { status: 'steht_nicht_drin', punkte: [], belege: [], hinweis: HINWEIS.leer, ...ohneKi };
    const nonce = randomBytes(4).toString('hex');
    const abschnittsText = treffer
      .map((t, i) => datenBlock(i + 1, `${t.titel} › ${t.abschnitt} (${t.pfad}, Zeilen ${t.von}–${t.bis})`, t.text, nonce))
      .join('\n\n');
    const system = [
      'AUFGABE: FRAGE',
      `Du beantwortest Fragen für den Betrieb „${this.cfg.betrieb}“ ausschließlich aus den nummerierten Abschnitten.`,
      'Regeln: Jeder Punkt braucht mindestens eine Abschnittsnummer als Beleg. Erfinde nichts. Wenn die Abschnitte die Frage nicht beantworten, gib eine leere Liste zurück.',
      'Gib zu jedem Punkt ein wörtliches Zitat (ein Satz) aus dem ersten Beleg-Abschnitt an.',
      this.cfg.sprache === 'en' ? 'Answer in English.' : 'Antworte auf Deutsch, kurz und klar.',
      DATEN_REGEL,
      'Format (nur JSON): {"punkte":[{"text":"…","belege":[1],"zitat":"…"}]}',
    ].join('\n');
    let modell;
    try {
      const roh = await this.provider.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: `=== FRAGE\n${f}\n=== ABSCHNITTE\n${abschnittsText}` },
        ],
        { json: true },
      );
      modell = modellAntwortSchema.parse(extrahiereJson(roh));
    } catch (e) {
      void e;
      return { status: 'steht_nicht_drin', punkte: [], belege: [], hinweis: HINWEIS.ki_fehler, ...mitKi };
    }

    // 4. Belege prüfen, Zitate aus der Datei ziehen
    const belege: Fundstelle[] = [];
    const belegNr = new Map<string, number>();
    const punkte: Antwort['punkte'] = [];
    for (const p of modell.punkte) {
      const nrs = [...new Set(p.belege)].filter((n) => n >= 1 && n <= treffer.length);
      if (!nrs.length || !p.text.trim()) continue;
      const eigene: number[] = [];
      for (const [k, n] of nrs.entries()) {
        const t = treffer[n - 1]!;
        const fs = await this.zitatFundstelle(t, k === 0 ? p.zitat : undefined, p.text);
        if (!fs) continue;
        const schluessel = `${fs.quelle}:${fs.zeilen[0]}-${fs.zeilen[1]}`;
        let idx = belegNr.get(schluessel);
        if (!idx) {
          belege.push(fs);
          idx = belege.length;
          belegNr.set(schluessel, idx);
        }
        if (!eigene.includes(idx)) eigene.push(idx);
      }
      if (eigene.length) punkte.push({ text: p.text.trim(), belege: eigene });
    }
    // v1.2: letzte maschinelle Prüfung jedes Zitats gegen die Datei; ungültige Belege raus, Punkte ohne Beleg raus
    const gueltig = await Promise.all(belege.map((b) => this.zitatStehtDrin(b)));
    if (gueltig.some((g) => !g)) {
      const neuNr = new Map<number, number>();
      const neueBelege: Fundstelle[] = [];
      belege.forEach((b, i) => {
        if (gueltig[i]) {
          neueBelege.push(b);
          neuNr.set(i + 1, neueBelege.length);
        }
      });
      const neuePunkte = punkte
        .map((p) => ({ ...p, belege: p.belege.map((n) => neuNr.get(n)).filter((n): n is number => !!n) }))
        .filter((p) => p.belege.length);
      belege.splice(0, belege.length, ...neueBelege);
      punkte.splice(0, punkte.length, ...neuePunkte);
    }
    // v1.4.1 U11: Belege aus einem Artikel und aus der Quelle, auf die seine einzige Fundstelle zeigt, zusammenfassen (Artikel bevorzugt)
    await this.fasseDublettenZusammen(belege, punkte);
    if (!punkte.length) return { status: 'steht_nicht_drin', punkte: [], belege: [], hinweis: HINWEIS.leer, ...mitKi };
    // S1 M4: Stützprüfung je Punkt gegen die belegten Abschnitte (ganzer Abschnitt, nicht nur Zitat)
    const abschnittVon = (b: Fundstelle) => treffer.find((t) => t.pfad === b.quelle && t.von <= b.zeilen[0] && t.bis >= b.zeilen[1])?.text ?? b.zitat;
    const markiert = punkte.map((p) => ({ ...p, gestuetzt: stuetzung(p.text, p.belege.map((n) => abschnittVon(belege[n - 1]!)).join('\n')) }));
    // Punkte ohne jede Stützung fallen weg, wenn andere Punkte gestützt sind (eingeschleuste Zusätze)
    const behalten = markiert.some((p) => p.gestuetzt !== 'unklar') ? markiert.filter((p) => p.gestuetzt !== 'unklar') : markiert;
    return { status: 'beantwortet', punkte: behalten, belege, hinweis: behalten.some((p) => p.gestuetzt !== 'ja') ? HINWEIS.ki_pruefen : HINWEIS.ki, ...mitKi };
  }

  /** v1.4.1 U11: Quelle-Belege entfernen, wenn ein Artikel-Beleg derselben Antwort genau diese Quelle als einzige Fundstelle hat. */
  private async fasseDublettenZusammen(belege: Fundstelle[], punkte: Antwort['punkte']): Promise<void> {
    const ersetze = new Map<number, number>();
    for (const [i, b] of belege.entries()) {
      if (!b.quelle.startsWith('wissen/')) continue;
      const fs = normalisiereArtikelKopf(parseMarkdown((await this.lies(b.quelle)) ?? '').kopf, b.quelle, { besitzer: SYSTEM, heute: this.heuteDatum() }).kopf.fundstellen;
      if (fs.length !== 1) continue;
      for (const [j, c] of belege.entries()) if (j !== i && !ersetze.has(j + 1) && c.quelle === fs[0]!.quelle) ersetze.set(j + 1, i + 1);
    }
    if (!ersetze.size) return;
    const neuNr = new Map<number, number>();
    const behalten: Fundstelle[] = [];
    belege.forEach((b, i) => { if (!ersetze.has(i + 1)) { behalten.push(b); neuNr.set(i + 1, behalten.length); } });
    for (const p of punkte) p.belege = [...new Set(p.belege.map((n) => neuNr.get(ersetze.get(n) ?? n)!).filter(Boolean))];
    belege.splice(0, belege.length, ...behalten);
  }

  /** v1.2: Steht das Zitat (nach Whitespace-Normalisierung) wörtlich im angegebenen Zeilenbereich? */
  async zitatStehtDrin(b: Fundstelle): Promise<boolean> {
    const i = await this.lies(b.quelle).catch(() => null);
    if (i === null) return false;
    const z = i.split(/\r?\n/);
    if (b.zeilen[0] < 1 || b.zeilen[1] > z.length || b.zeilen[0] > b.zeilen[1]) return false;
    const bereich = normWs(z.slice(b.zeilen[0] - 1, b.zeilen[1]).join(' '));
    const zit = normWs(b.zitat);
    return zit.length > 0 && bereich.includes(zit);
  }

  /** Zitat wörtlich aus dem Zeilenbereich der Datei ziehen und Zeilen darauf eingrenzen. */
  private async zitatFundstelle(t: RohTreffer, modellZitat: string | undefined, punktText: string): Promise<Fundstelle | null> {
    const inhalt = await this.lies(t.pfad);
    if (inhalt === null) return null;
    const alle = inhalt.split(/\r?\n/);
    const zeilen = alle.slice(t.von - 1, t.bis);
    const finde = (zitat: string): [number, number] | null => {
      const ziel = normWs(zitat);
      if (ziel.length < 8) return null;
      for (let b = 0; b < zeilen.length; b++) {
        for (let a = b; a >= 0 && a > b - 12; a--) {
          if (normWs(zeilen.slice(a, b + 1).join(' ')).includes(ziel)) return [a, b];
        }
      }
      return null;
    };
    let zitat: string | null = null;
    let bereich: [number, number] | null = null;
    if (modellZitat && normWs(modellZitat).length >= 8) {
      // v1.2: Zitat des Modells muss wörtlich im Zeilenbereich stehen, sonst wird der Beleg verworfen
      bereich = finde(modellZitat);
      if (!bereich) return null;
      zitat = normWs(modellZitat);
    }
    if (!bereich) {
      // bester Satz des Abschnitts zum Punkt
      const kandidaten = zeilenSaetze(zeilen.join('\n'), true).filter((x) => !nurMarkup(x));
      let best: string | null = null;
      let bs = -1;
      for (const s of kandidaten) {
        const sc = ueberdeckung(punktText, s);
        if (sc > bs) {
          bs = sc;
          best = s;
        }
      }
      if (best) {
        // Satz in Fragmente zerlegen, falls er über Aufzählungszeichen läuft
        bereich = finde(best) ?? finde(best.slice(0, 60));
        zitat = bereich ? normWs(best) : null;
      }
    }
    if (zitat && nurMarkup(zitat)) return null;
    if (!bereich || !zitat) {
      const ganz = kuerze(normWs(zeilen.join(' ')), 300);
      if (nurMarkup(ganz)) return null;
      return { quelle: t.pfad, abschnitt: t.abschnitt, zeilen: [t.von, t.bis], zitat: ganz };
    }
    zitat = kuerze(zitat, 500);
    return { quelle: t.pfad, abschnitt: t.abschnitt, zeilen: [t.von + bereich[0], t.von + bereich[1]], zitat };
  }

  /* ================================================================ */
  /* Hinzufügen, Kompilieren                                           */
  /* ================================================================ */

  private async freierPfad(basis: string, ext = '.md', zusatz: Set<string> = new Set()): Promise<string> {
    let p = `${basis}${ext}`;
    let n = 2;
    while (existsSync(this.abs(p)) || zusatz.has(p)) p = `${basis}-${n++}${ext}`;
    return p;
  }

  async fuegeHinzu(
    u: User,
    e: {
      art: 'datei' | 'text' | 'web' | 'audio' | 'notiz';
      titel?: string;
      inhalt?: string;
      dateiPfad?: string;
      /** Erweiterung: Originalname bei hochgeladenen Dateien (Server legt Uploads unter Zufallsnamen ab). */
      dateiName?: string;
      url?: string;
      sammlung: string;
      sichtbarkeit: Sichtbarkeit;
      beobachten?: boolean;
      /** Erweiterung: Standard true; false = nur Quelle anlegen, keine Vorschläge. */
      kompilieren?: boolean;
      /** Erweiterung: diese Quelle ausdrücklich als Vorgänger ersetzen (sonst: gleiche Herkunft + Sammlung). */
      ersetzt?: string;
      /** v1.4.1 U8: Herkunft für den Quellenkopf (z. B. Outline-Adresse), statt Dateiname/URL/„text“. */
      herkunft?: string;
      /** v1.4.1 U8: Kennung im Fremdsystem; gleiche `extern_id` in derselben Sammlung ersetzt die alte Fassung. */
      extern_id?: string;
      /** v1.4.1 U8: weitere Felder für den Quellenkopf (Pflichtfelder lassen sich damit nicht überschreiben). */
      zusatz?: Record<string, unknown>;
    },
  ): Promise<{ quelle: Quelle; vorschlaege: Vorschlag[]; warnungen: string[]; doppelt?: boolean }> {
    brauchtRolle(u, 'autor', 'etwas hinzufügen');
    if (!darfSichtbarkeitSetzen(u, e.sichtbarkeit)) throw new KernFehler('keine_rechte', `Sichtbarkeit ${e.sichtbarkeit} nicht erlaubt`);
    const sammlung = (e.sammlung || 'allgemein').trim();
    let ing: IngestErgebnis;
    let herkunft: string;
    switch (e.art) {
      case 'text':
      case 'notiz': {
        if (!e.inhalt?.trim()) throw new KernFehler('ungueltig', 'Inhalt fehlt');
        const erste = e.inhalt.trim().split('\n')[0]!.replace(/^#+\s*/, '');
        ing = { text: e.inhalt.trim(), titel: e.titel || (erste.length > 80 ? erste.slice(0, 77) + '…' : erste) };
        herkunft = e.art;
        break;
      }
      case 'web': {
        if (!e.url) throw new KernFehler('ungueltig', 'URL fehlt');
        let w: Awaited<ReturnType<typeof ladeWebseite>>;
        try {
          w = await ladeWebseite(e.url, 20_000, this.produkt, this.cfg.netz ?? {});
        } catch (f) {
          if (f instanceof NetzFehler) throw Object.assign(new KernFehler('ungueltig', f.message), { grund: f.grund });
          throw f;
        }
        ing = { text: w.text, ...(w.titel ? { titel: w.titel } : {}), original: { ext: 'html', daten: Buffer.from(w.html) } };
        herkunft = e.url;
        break;
      }
      case 'datei':
      case 'audio': {
        if (!e.dateiPfad) throw new KernFehler('ungueltig', 'Datei fehlt');
        if (resolve(e.dateiPfad).startsWith(join(this.dir, 'ansichten') + sep)) throw new KernFehler('rueckkopplung', 'Ansichten werden nie zu Quellen');
        const name = e.dateiName ?? posix.basename(e.dateiPfad.replace(/\\/g, '/'));
        if (e.art === 'audio' && !istAudio(name)) throw new KernFehler('ungueltig', 'Keine Audiodatei');
        // Endung des Originalnamens zählt (Uploads haben oft keine)
        let quelle = e.dateiPfad;
        if (extname(name) && extname(name).toLowerCase() !== extname(e.dateiPfad).toLowerCase()) {
          quelle = join(this.dir, '.kern', `upload-${Date.now()}${extname(name).toLowerCase()}`);
          await copyFile(e.dateiPfad, quelle);
        }
        const maxMb = Number(((await this.leseBetriebsEinstellungen())['anhaenge'] as { max_mb?: number } | undefined)?.max_mb ?? ANHANG_MAX_MB);
        if (((await stat(e.dateiPfad).catch(() => null))?.size ?? 0) > maxMb * 1024 * 1024) {
          if (quelle !== e.dateiPfad) await rm(quelle, { force: true });
          throw Object.assign(new KernFehler('ungueltig', `Datei größer als ${maxMb} MB (kern.yaml anhaenge.max_mb)`), { grund: 'zu_gross' });
        }
        try {
          ing = await leseDatei(quelle, this.cfg.whisper, this.cfg.parser ?? {});
        } catch (err) {
          if (err instanceof ParserFehler) throw Object.assign(new KernFehler('ungueltig', err.message), { grund: err.grund });
          throw new KernFehler('ungueltig', (err as Error).message);
        } finally {
          if (quelle !== e.dateiPfad) await rm(quelle, { force: true });
        }
        if (!e.dateiName) ing.titel = ing.titel ?? posix.basename(name, extname(name));
        else if (ing.titel === posix.basename(quelle, extname(quelle))) ing.titel = posix.basename(name, extname(name));
        herkunft = name;
        break;
      }
    }
    if (e.herkunft !== undefined) {
      const h = String(e.herkunft).replace(/[\r\n]/g, ' ').trim().slice(0, 500);
      if (h) herkunft = h;
    }
    const externId = e.extern_id !== undefined ? String(e.extern_id).replace(/[\r\n]/g, ' ').trim().slice(0, 200) : '';
    const PFLICHT = new Set(['type', 'titel', 'art', 'herkunft', 'erfasst_am', 'erfasst_von', 'sichtbarkeit', 'sammlung', 'hash', 'ersetzt', 'beobachtet', 'extern_id', 'besitzer']);
    const zusatz: Record<string, unknown> = {};
    if (e.zusatz && typeof e.zusatz === 'object') {
      for (const [k, v] of Object.entries(e.zusatz)) if (!PFLICHT.has(k) && /^[a-z_][a-z0-9_]{0,40}$/i.test(k) && v !== undefined) zusatz[k] = v;
      if (JSON.stringify(zusatz).length > 8000) throw new KernFehler('ungueltig', 'zusatz zu groß (höchstens 8 KB)');
    }
    const titel = (e.titel || ing.titel || 'Ohne Titel').trim();
    const hash = sha256(ing.original?.daten ?? ing.text);
    const warnungen: string[] = [];
    const regel = await this.pruefeRegeln(`${titel}\n${ing.text}`);
    if (regel) warnungen.push(`Inhalt berührt die Regel „${regel.regel}“ (${REGEL_DATEI}, Zeile ${regel.zeile}). Bitte prüfen, ob das hierher gehört.`);

    const ergebnis = await this.sperre.run(async () => {
      const quellen = this.ix.dateien().filter((d) => d.art === 'quelle');
      const gleich = quellen.find((d) => d.quellhash === hash && d.aktiv && darfSehen(u, d.sichtbarkeit, d.besitzer));
      if (gleich) {
        const i = (await this.lies(gleich.pfad)) ?? '';
        return { quelle: this.parseQuelle(gleich.pfad, i), doppelt: true };
      }
      let perId: DateiEintrag | undefined;
      if (externId && !e.ersetzt) {
        for (const d of quellen.filter((x) => x.aktiv && x.sammlung === sammlung && darfSehen(u, x.sichtbarkeit, x.besitzer))) {
          if (String(parseMarkdown((await this.lies(d.pfad)) ?? '').kopf['extern_id'] ?? '') === externId) { perId = d; break; }
        }
      }
      const vorgaenger = e.ersetzt
        ? quellen.find((d) => d.pfad === e.ersetzt && darfSehen(u, d.sichtbarkeit, d.besitzer))
        : perId ? perId
        : herkunft !== 'text' && herkunft !== 'notiz'
          ? quellen.find((d) => d.aktiv && d.herkunft === herkunft && d.sammlung === sammlung && darfSehen(u, d.sichtbarkeit, d.besitzer))
          : undefined;
      const jahr = this.heuteDatum().slice(0, 4);
      const pfad = await this.freierPfad(`quellen/${jahr}/${slugify(titel)}`);
      const kopf: QuellenKopf = {
        type: 'Quelle', titel, art: e.art, herkunft, erfasst_am: this.jetzt(), erfasst_von: u.id, sichtbarkeit: e.sichtbarkeit, sammlung, hash,
        ersetzt: vorgaenger?.pfad ?? null, beobachtet: !!e.beobachten, ...zusatz, ...(ing.kopf ?? {}), ...(externId ? { extern_id: externId } : {}),
      };
      const aenderungen: Aenderung[] = [{ pfad, inhalt: stringifyMarkdown(ordneQuellenKopf(kopf), ing.text) }];
      if (ing.original && e.art !== 'text' && e.art !== 'notiz') aenderungen.push({ pfad: pfad.replace(/\.md$/, `.orig.${ing.original.ext}`), inhalt: ing.original.daten });
      await this.schreibeUndCommitte(aenderungen, u.name, vorgaenger ? `Quelle ersetzt: ${titel}` : `Quelle hinzugefügt: ${titel}`);
      return { quelle: this.parseQuelle(pfad, (await this.lies(pfad)) ?? ''), doppelt: false };
    });
    if (ergebnis.doppelt) return { quelle: ergebnis.quelle, vorschlaege: [], warnungen: [...warnungen, 'Diese Quelle gibt es schon (gleicher Inhalt).'], doppelt: true };
    let vorschlaege: Vorschlag[] = [];
    if (e.kompilieren !== false && ing.kopf?.['transkript'] !== 'wartet') {
      try {
        vorschlaege = await this.kompiliere(u, ergebnis.quelle.pfad);
      } catch (err) {
        warnungen.push(`Keine Vorschläge erzeugt: ${(err as Error).message}`);
      }
    }
    return { quelle: ergebnis.quelle, vorschlaege, warnungen };
  }

  /**
   * v1.2: Beobachtete Web-Quellen abrufen (der Server ruft das per Zeitplan auf, siehe `beobachtungsIntervallMs`).
   * Änderung ⇒ neue Fassung (ersetzt die alte in der Suche) + Vorschläge. robots.txt und Sperren (401/403/429/451)
   * werden respektiert und als „nicht abrufbar“ gemeldet, nie umgangen. Gehandelt wird als Erfasser der Quelle.
   */
  async beobachteQuellen(_u?: User): Promise<{
    geprueft: number;
    neu: { quelle: Quelle; vorschlaege: Vorschlag[] }[];
    unveraendert: string[];
    nicht_abrufbar: { pfad: string; url: string; grund: string }[];
  }> {
    const ergebnis = { geprueft: 0, neu: [] as { quelle: Quelle; vorschlaege: Vorschlag[] }[], unveraendert: [] as string[], nicht_abrufbar: [] as { pfad: string; url: string; grund: string }[] };
    const kandidaten = this.ix.dateien().filter((d) => d.art === 'quelle' && d.aktiv && d.herkunft && /^https?:\/\//.test(d.herkunft));
    const agent = `${this.produkt.replace(/[^\w.-]/g, '')}/0.1 (+Wissensordner)`;
    for (const d of kandidaten) {
      const i = await this.lies(d.pfad);
      if (!i) continue;
      const q = this.parseQuelle(d.pfad, i);
      if (!q.kopf.beobachtet) continue;
      ergebnis.geprueft++;
      const url = q.kopf.herkunft;
      if (!(await robotsErlaubt(url, agent, 10_000, this.cfg.netz ?? {}).catch(() => true))) {
        ergebnis.nicht_abrufbar.push({ pfad: d.pfad, url, grund: 'robots.txt untersagt den Abruf' });
        continue;
      }
      const u: User = (await this.benutzer.hole(q.kopf.erfasst_von)) ?? { id: q.kopf.erfasst_von, name: 'beobachter', rollen: ['autor'], teams: q.kopf.sichtbarkeit.startsWith('team:') ? [q.kopf.sichtbarkeit.slice(5)] : [] };
      const handelnd: User = hatRolle(u, 'autor') ? u : { ...u, rollen: ['autor'] };
      try {
        const r = await this.fuegeHinzu(handelnd, { art: 'web', url, sammlung: q.kopf.sammlung, sichtbarkeit: q.kopf.sichtbarkeit, beobachten: true, titel: q.kopf.titel, ersetzt: d.pfad });
        if (r.doppelt) ergebnis.unveraendert.push(d.pfad);
        else ergebnis.neu.push({ quelle: r.quelle, vorschlaege: r.vorschlaege });
      } catch (e) {
        const st = (e as { status?: number }).status;
        const grund = st && [401, 403, 429, 451].includes(st) ? `Seite sperrt den Abruf (${st})` : `Abruf fehlgeschlagen: ${(e as Error).message}`;
        ergebnis.nicht_abrufbar.push({ pfad: d.pfad, url, grund });
      }
    }
    return ergebnis;
  }

  /** v1.2: Abstand der Quellenbeobachtung aus kern.yaml (`beobachtung.intervall_stunden`, Standard 24). */
  async beobachtungsIntervallMs(): Promise<number> {
    const e = await this.leseEinstellungen();
    const b = e['beobachtung'] as { intervall_stunden?: number; stunden?: number } | undefined;
    const h = Number(b?.intervall_stunden ?? b?.stunden ?? 24);
    return Math.max(1, Number.isFinite(h) ? h : 24) * 3600_000;
  }

  /**
   * v1.2: Import aus anderen Systemen, immer als Quellen plus Vorschläge (nie direkt ins Wissen).
   * `pfad` ist ein entpackter Export-Ordner (oder eine einzelne Datei). obsidian: [[Links]] werden zu Text;
   * notion: Kennungen am Dateinamen entfernt; outline/markdown: Markdown; confluence: HTML-Export; okf: siehe importiereOkf.
   */
  async importiere(
    u: User,
    e: { art: 'obsidian' | 'notion' | 'outline' | 'confluence' | 'markdown' | 'okf' | 'kern-zip'; pfad: string; sammlung?: string; sichtbarkeit?: Sichtbarkeit; kompilieren?: boolean },
  ): Promise<{ quellen: Quelle[]; vorschlaege: Vorschlag[]; uebersprungen: string[]; warnungen: string[] }> {
    brauchtRolle(u, 'autor', 'importieren');
    if (e.art === 'kern-zip') {
      // eigener ZIP- oder OKF-ZIP-Export: geprüft entpacken (nur wissen/ und quellen/), dann wie OKF (Quellen plus Vorschläge)
      const tmp = await mkdtemp(join(tmpdir(), 'kern-zip-'));
      try {
        const roh = join(tmp, 'roh');
        await entpackeKernZip(e.pfad, roh);
        const nur = join(tmp, 'nur');
        await mkdir(nur, { recursive: true });
        for (const o of ['wissen', 'quellen']) if (existsSync(join(roh, o))) await rename(join(roh, o), join(nur, o));
        return { ...(await this.importiereOkf(u, nur, { ...(e.sammlung ? { sammlung: e.sammlung } : {}), ...(e.sichtbarkeit ? { sichtbarkeit: e.sichtbarkeit } : {}) })), warnungen: [] };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    if (e.art === 'okf') return { ...(await this.importiereOkf(u, e.pfad, { ...(e.sammlung ? { sammlung: e.sammlung } : {}), ...(e.sichtbarkeit ? { sichtbarkeit: e.sichtbarkeit } : {}) })), warnungen: [] };
    const wurzel = resolve(e.pfad);
    const st = await stat(wurzel);
    const dateien: string[] = [];
    const lauf = async (abs: string) => {
      for (const x of await readdir(abs, { withFileTypes: true })) {
        if (x.name.startsWith('.') || x.name === 'node_modules') continue;
        const p = join(abs, x.name);
        if (x.isDirectory()) await lauf(p);
        else if (x.isFile()) dateien.push(p);
      }
    };
    if (st.isDirectory()) await lauf(wurzel);
    else dateien.push(wurzel);
    const textEndungen = e.art === 'confluence' ? ['.html', '.htm'] : ['.md', '.markdown', '.txt'];
    const quellen: Quelle[] = [];
    const vorschlaege: Vorschlag[] = [];
    const uebersprungen: string[] = [];
    const warnungen: string[] = [];
    const sammlung = e.sammlung ?? `import-${e.art}`;
    for (const abs of dateien.sort()) {
      const rel = st.isDirectory() ? relative(wurzel, abs).split(sep).join('/') : posix.basename(abs);
      const ext = extname(abs).toLowerCase();
      if (!textEndungen.includes(ext) && !['.pdf', '.docx'].includes(ext)) {
        uebersprungen.push(rel);
        continue;
      }
      if (e.art === 'confluence' && /^(index|attachments?)\b/i.test(posix.basename(rel))) {
        uebersprungen.push(rel);
        continue;
      }
      let name = posix.basename(rel, ext);
      if (e.art === 'notion') name = name.replace(/\s+[0-9a-f]{32}$/i, '');
      let tmp: string | null = null;
      if (e.art === 'obsidian' && (ext === '.md' || ext === '.markdown')) {
        const roh = await readFile(abs, 'utf8');
        const umgeschrieben = roh
          .replace(/!\[\[([^\]]+)\]\]/g, '(Anhang: $1)')
          .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
          .replace(/\[\[([^\]|#]+)(?:#([^\]|]*))?\]\]/g, (_m, z: string, a?: string) => (a ? `${z} › ${a}` : z));
        if (umgeschrieben !== roh) {
          tmp = join(this.dir, '.kern', `import-${Date.now()}-${slugify(name)}${ext}`);
          await writeFile(tmp, umgeschrieben);
        }
      }
      try {
        const r = await this.fuegeHinzu(u, {
          art: 'datei', dateiPfad: tmp ?? abs, dateiName: `${name}${ext}`, sammlung, sichtbarkeit: e.sichtbarkeit ?? 'betrieb', kompilieren: e.kompilieren ?? true,
        });
        if (r.doppelt) uebersprungen.push(rel);
        else {
          quellen.push(r.quelle);
          vorschlaege.push(...r.vorschlaege);
        }
        warnungen.push(...r.warnungen.map((w) => `${rel}: ${w}`));
      } catch (err) {
        uebersprungen.push(`${rel} (${(err as Error).message})`);
      } finally {
        if (tmp) await rm(tmp, { force: true });
      }
    }
    return { quellen, vorschlaege, uebersprungen, warnungen };
  }

  /** v1.2: Welcher KI-Anbieter mit welchem Endpunkt/Region aktiv ist und welche Daten dorthin gehen. */
  datenweg(): {
    chat: { anbieter: string; endpunkt: string | null; region: string; modell: string | null };
    embeddings: { anbieter: string; endpunkt: string | null; region: string; modell: string | null } | null;
    vektoren: boolean;
    regelpruefung_ki: boolean;
    daten: string[];
    hinweis: string;
  } {
    const region = (url: string | null): string => {
      if (!url) return 'lokal (kein Netz)';
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return 'unbekannt';
      }
      if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(host) || host.endsWith('.local') || !host.includes('.')) return 'lokal / eigenes Netz';
      if (host.endsWith('mistral.ai')) return 'EU (Mistral AI, Frankreich)';
      if (host.includes('ionos')) return 'EU (IONOS, Deutschland)';
      if (host.includes('stackit')) return 'EU (STACKIT, Deutschland)';
      if (host.endsWith('anthropic.com')) return 'USA (Anthropic)';
      if (host.endsWith('openai.com')) return 'USA (OpenAI)';
      return `unbekannt (${host}), bitte beim Anbieter prüfen`;
    };
    const beschreibe = (c: ProviderConfig): { anbieter: string; endpunkt: string | null; region: string; modell: string | null } => {
      switch (c.art) {
        case 'mock':
          return { anbieter: 'mock', endpunkt: null, region: region(null), modell: null };
        case 'ollama':
          return { anbieter: 'ollama', endpunkt: c.url, region: region(c.url), modell: c.chatModell };
        case 'openai':
          return { anbieter: 'openai-kompatibel', endpunkt: c.url, region: region(c.url), modell: c.chatModell };
        case 'anthropic':
          return { anbieter: 'anthropic', endpunkt: 'https://api.anthropic.com', region: region('https://api.anthropic.com'), modell: c.chatModell };
      }
    };
    const chat = beschreibe(this.cfg.provider);
    const embCfg = this.cfg.provider.art === 'anthropic' ? this.cfg.provider.embed : this.cfg.provider;
    const embBasis = beschreibe(embCfg);
    const embeddings = this.vektorenAn ? { ...embBasis, modell: embCfg.art === 'ollama' || embCfg.art === 'openai' ? embCfg.embedModell : embBasis.modell } : null;
    const rk = this.einstellungenSync?.regelpruefung_ki !== false;
    const daten = [
      'Bei jeder Frage: der Fragetext und bis zu 8 Abschnitte, die der fragende Benutzer sehen darf (Rechtefilter vor dem Versand).',
      'Beim Kompilieren: bis zu 24 Abschnitte der neuen Quelle und Auszüge (bis 600 Zeichen) von bis zu 3 verwandten Artikeln.',
      ...(rk ? ['Bei Fragen, wenn die Regel-Datei existiert: die Regel-Datei und der Fragetext (KI-Regelprüfung, abschaltbar mit regelpruefung_ki: false).'] : []),
      ...(embeddings ? ['Beim Indizieren: der Text aller Abschnitte aus wissen/ und quellen/ an den Embedding-Anbieter (einmalig je Fassung, danach Zwischenspeicher).'] : []),
      'Nie: Passwörter, Benutzerliste, Inhalte, die der Benutzer nicht sehen darf.',
    ];
    const hinweis = chat.anbieter === 'mock' ? 'Keine KI angebunden (mock): es verlassen keine Daten den Rechner.' : `Daten gehen an ${chat.anbieter} (${chat.region}).`;
    return { chat, embeddings, vektoren: this.vektorenAn, regelpruefung_ki: rk, daten, hinweis };
  }

  async kompiliere(u: User, quellPfad: string): Promise<Vorschlag[]> {
    brauchtRolle(u, 'autor', 'kompilieren');
    if (sichererPfad(quellPfad).startsWith('ansichten/')) throw new KernFehler('rueckkopplung', 'Aus Ansichten wird nie kompiliert');
    const q = await this.leseQuelle(u, quellPfad);
    const abschnitte = this.ix.abschnitteVon(q.pfad).slice(0, 24);
    if (!abschnitte.length) return [];
    const verwandte = await this.rohSuche(u, `${q.kopf.titel}\n${abschnitte.map((a) => a.text).join('\n').slice(0, 800)}`, { art: 'wissen', limit: 12 });
    const artikelPfade = [...new Set(verwandte.map((t) => t.pfad))].filter((p) => !p.startsWith('wissen/_regeln/')).slice(0, 3);
    const artikel: Artikel[] = [];
    for (const p of artikelPfade) artikel.push(await this.leseArtikel(u, p));
    const system = [
      'AUFGABE: KOMPILIEREN',
      'Du pflegst einen Wissensordner wie ein Lexikon. Aus einer neuen Quelle schlägst du vor, welche bestehenden Artikel ergänzt werden sollen (art "aenderung", ziel = pfad) oder welche neuen Artikel entstehen (art "neu").',
      'Schreibe nur, was in der Quelle steht. Nenne die verwendeten Quellabschnitte als Nummern. Kurzfassung: 2 bis 4 Sätze. Bei "aenderung" ist "text" nur der neue Teil, der angehängt wird.',
      'Fakten (Preise, Fristen, Zuständigkeiten, Kennzahlen, Kontakte, Regeln) zusätzlich unter "fakten" aufführen, nur wenn die Quelle sie ausdrücklich nennt.',
      'Melde Unsicherheit und Fehler ausdrücklich im Block Unsicher (im Feld "grund" mit dem Wort „Unsicher:“), statt zu raten.',
      DATEN_REGEL,
      'Format (nur JSON): {"vorschlaege":[{"art":"neu","ziel":null,"titel":"…","gruppe":"…","kurzfassung":"…","text":"Markdown","abschnitte":[1],"grund":"…","fakten":[{"art":"preis","gegenstand":"…","wert":"…","einheit":"…","gilt_ab":null,"gilt_bis":null,"abschnitt":1}]}]}',
    ].join('\n');
    const nonceK = randomBytes(4).toString('hex');
    const user = [
      '=== QUELLE',
      `titel: ${q.kopf.titel.replace(/\n/g, ' ')}`,
      `sammlung: ${q.kopf.sammlung}`,
      '=== QUELLABSCHNITTE',
      ...abschnitte.map((a, i) => `${datenBlock(i + 1, `${a.abschnitt} (Zeilen ${a.von}–${a.bis})`, a.text, nonceK)}\n`),
      '=== BESTEHENDE ARTIKEL',
      ...artikel.map((a, i) => `${datenBlock(i + 1, `${a.kopf.titel} pfad: ${a.pfad}`, `${a.kopf.kurzfassung}\n${a.text.slice(0, 600)}`, nonceK)}\n`),
    ].join('\n');
    const roh = await this.provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true });
    const kompilat = modellKompilatSchema.parse(extrahiereJson(roh));
    const vorschlaege: Vorschlag[] = [];
    const geplant = new Set<string>((await this.offeneVorschlaege()).filter((v) => v.art === 'neu').map((v) => v.ziel));
    for (const k of kompilat.vorschlaege.slice(0, 5)) {
      const nrs = [...new Set(k.abschnitte)].filter((n) => n >= 1 && n <= abschnitte.length);
      const benutzt = (nrs.length ? nrs : [1]).map((n) => abschnitte[n - 1]!);
      const fundNeu = benutzt.map((a) => ({ quelle: q.pfad, abschnitt: a.abschnitt, zeilen: [a.von, a.bis] as [number, number] }));
      const generated = { by: `${slugify(this.produkt)}-ki/${this.provider.name}`, at: this.jetzt() };
      if (k.art === 'aenderung' && k.ziel && artikel.some((a) => a.pfad === k.ziel)) {
        const alt = (await this.lies(k.ziel))!;
        const a = this.parseArtikel(k.ziel, alt);
        const fund = [...a.kopf.fundstellen];
        const neueIds: string[] = [];
        for (const f of fundNeu) {
          const vorhanden = fund.find((x) => x.quelle === f.quelle && x.zeilen[0] === f.zeilen[0] && x.zeilen[1] === f.zeilen[1]);
          if (vorhanden) {
            neueIds.push(vorhanden.id);
            continue;
          }
          let n = fund.length + 1;
          while (fund.some((x) => x.id === `f${n}`)) n++;
          fund.push({ id: `f${n}`, ...f });
          neueIds.push(`f${n}`);
        }
        const kopf: ArtikelKopf = { ...a.kopf, fundstellen: fund, ...(k.kurzfassung ? { kurzfassung: k.kurzfassung } : {}) };
        const fakten = this.faktenAusKompilat(k.fakten, benutzt, abschnitte, fund, kopf.fakten ?? []);
        if (fakten.length) kopf.fakten = [...(kopf.fakten ?? []), ...fakten];
        const text = mitFussnoten(`${a.text.trimEnd()}\n\n${k.text.trim()}`, neueIds, fund);
        vorschlaege.push(await this.legeVorschlagAn(u, { art: 'aenderung', ziel: k.ziel, alt, neu: stringifyMarkdown(ordneArtikelKopf(kopf), text), grund: k.grund || `Ergänzung aus „${q.kopf.titel}“`, quelle: q.pfad, ki: true }));
      } else {
        const gruppe = slugify(k.gruppe || q.kopf.sammlung || 'allgemein', 40);
        const ziel = await this.freierPfad(`wissen/${gruppe}/${slugify(k.titel)}`, '.md', geplant);
        geplant.add(ziel);
        const fund: ArtikelFundstelle[] = fundNeu.map((f, i) => ({ id: `f${i + 1}`, ...f }));
        const kopf: ArtikelKopf = {
          type: k.fakten.length && k.text.length < 200 ? 'Faktenblatt' : 'Artikel',
          titel: k.titel, gruppe, kurzfassung: k.kurzfassung, stand: this.heuteDatum(), verantwortlich: u.name, pruefen_bis: plusTage(this.heuteDatum(), 365),
          sichtbarkeit: q.kopf.sichtbarkeit, besitzer: u.id, status: 'entwurf', generated, fundstellen: fund,
        };
        const fakten = this.faktenAusKompilat(k.fakten, benutzt, abschnitte, fund, []);
        if (fakten.length) kopf.fakten = fakten;
        const text = mitFussnoten(k.text.trim(), fund.map((f) => f.id), fund);
        vorschlaege.push(await this.legeVorschlagAn(u, { art: 'neu', ziel, alt: null, neu: stringifyMarkdown(ordneArtikelKopf(kopf), text), grund: k.grund || `Neuer Artikel aus „${q.kopf.titel}“`, quelle: q.pfad, ki: true }));
      }
    }
    return vorschlaege;
  }

  private faktenAusKompilat(
    roh: { art: FaktEintrag['art']; gegenstand: string; wert: string | number | boolean; einheit?: string | null | undefined; gilt_ab?: string | null | undefined; gilt_bis?: string | null | undefined; abschnitt?: number | undefined }[],
    benutzt: { von: number; bis: number }[],
    abschnitte: { von: number; bis: number }[],
    fund: ArtikelFundstelle[],
    bestehend: FaktEintrag[],
  ): FaktEintrag[] {
    const ids = new Set(bestehend.map((f) => f.id));
    return roh.map((f) => {
      const a = f.abschnitt && abschnitte[f.abschnitt - 1] ? abschnitte[f.abschnitt - 1]! : benutzt[0]!;
      const fs = fund.find((x) => x.zeilen[0] === a.von && x.zeilen[1] === a.bis) ?? fund[0]!;
      let id = slugify(f.gegenstand, 40);
      let n = 2;
      while (ids.has(id)) id = `${slugify(f.gegenstand, 36)}-${n++}`;
      ids.add(id);
      return { id, art: f.art, gegenstand: f.gegenstand, wert: f.wert, einheit: f.einheit ?? null, gilt_ab: f.gilt_ab ?? null, gilt_bis: f.gilt_bis ?? null, fundstelle: fs.id };
    });
  }

  /* ================================================================ */
  /* Eingang                                                           */
  /* ================================================================ */

  private async offeneVorschlaege(): Promise<Vorschlag[]> {
    let namen: string[] = [];
    try {
      namen = (await readdir(join(this.dir, 'eingang'))).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Vorschlag[] = [];
    for (const n of namen) {
      try {
        const v = vorschlagSchema.parse(JSON.parse((await this.lies(`eingang/${n}`)) ?? '')) as Vorschlag;
        if (v.status === 'offen' || v.status === 'konflikt') out.push(v);
      } catch {
        /* kaputte Datei ignorieren; pruefe() meldet sie nicht, git hat sie */
      }
    }
    return out.sort((a, b) => a.erstellt.localeCompare(b.erstellt) || a.id.localeCompare(b.id));
  }

  /** Sichtbarkeit und Besitzer eines Vorschlags (aus neuem bzw. altem Kopf). */
  private vorschlagsRechte(v: Vorschlag): { sichtbarkeit: string; besitzer: string } {
    const quelle = v.art === 'loeschung' ? v.alt ?? '' : v.neu;
    const k = parseMarkdown(quelle).kopf;
    return { sichtbarkeit: String(k['sichtbarkeit'] ?? 'betrieb'), besitzer: String(k['besitzer'] ?? v.von) };
  }

  /**
   * Offene Vorschläge, die `u` sehen darf. v1.3 R5: standardmäßig höchstens `max_offene_vorschlaege` (lesen.yaml, Standard 3),
   * sortiert nach Ampel, dann Alter; `{ alle: true }` liefert alle (für Profis). Die Gesamtzahl steht in `eingangZahl()`.
   */
  async eingang(u: User, opt: { alle?: boolean } = {}): Promise<Vorschlag[]> {
    const alle = (await this.offeneVorschlaege()).filter((v) => {
      const r = this.vorschlagsRechte(v);
      return darfSehen(u, r.sichtbarkeit, r.besitzer) || v.von === u.id || v.von.endsWith(`@${u.id}`);
    });
    if (opt.alle) return alle;
    const max = (await this.leseLesen(u)).max_offene_vorschlaege;
    const rang = { rot: 0, gelb: 1, gruen: 2 } as const;
    return alle
      .map((v) => ({ v, a: this.ampel(u, { vorschlagId: v.id }) }))
      .sort((x, y) => rang[x.a.farbe] - rang[y.a.farbe] || x.v.erstellt.localeCompare(y.v.erstellt))
      .slice(0, max)
      .map((x) => x.v);
  }

  /** v1.3: Zahl der offenen Vorschläge (gezeigt / insgesamt). */
  async eingangZahl(u: User): Promise<{ gezeigt: number; gesamt: number }> {
    return { gezeigt: (await this.eingang(u)).length, gesamt: (await this.eingang(u, { alle: true })).length };
  }

  /** Erweiterung: einen Vorschlag lesen (offen oder erledigt). */
  async leseVorschlag(u: User, id: string): Promise<Vorschlag> {
    const sid = id.replace(/[^\w.-]/g, '');
    const roh = (await this.lies(`eingang/${sid}.json`)) ?? (await this.lies(`eingang/erledigt/${sid}.json`));
    if (!roh) throw new KernFehler('nicht_gefunden', `Vorschlag ${id} nicht gefunden`);
    const v = vorschlagSchema.parse(JSON.parse(roh)) as Vorschlag;
    const r = this.vorschlagsRechte(v);
    if (!darfSehen(u, r.sichtbarkeit, r.besitzer) && v.von !== u.id && !v.von.endsWith(`@${u.id}`)) throw new KernFehler('nicht_gefunden', `Vorschlag ${id} nicht gefunden`);
    return v;
  }

  /** Neuen Artikeltext prüfen und vereinheitlichen. */
  private mitBesitzer(text: string, besitzer: string): string {
    const p = parseMarkdown(text);
    p.kopf['besitzer'] = besitzer;
    return stringifyMarkdown(p.kopf, p.text);
  }

  /** Besitzer aus einem Artikeltext (Kopf) oder null. */
  private besitzerVon(text: string | null): string | null {
    if (!text) return null;
    const b = parseMarkdown(text).kopf['besitzer'];
    return typeof b === 'string' && b.trim() ? b.trim() : null;
  }

  /**
   * S1 M7: `besitzer` ist nicht frei setzbar. Neu: der Vorschlagende selbst; Änderung: bleibt wie bisher. Nur admin darf ändern.
   */
  private bereiteArtikelVor(u: User, ziel: string, neu: string, art: Vorschlag['art'], erwarteterBesitzer: string = u.id): string {
    if (art === 'loeschung') return '';
    const p = parseMarkdown(neu);
    if (p.fehler) throw new KernFehler('ungueltig', p.fehler);
    const roh = typeof p.kopf['besitzer'] === 'string' ? String(p.kopf['besitzer']).trim() : '';
    if (!roh) p.kopf['besitzer'] = erwarteterBesitzer;
    else if (roh !== erwarteterBesitzer && !hatRolle(u, 'admin')) throw new KernFehler('keine_rechte', 'besitzer darf nur ein Admin ändern');
    const { kopf, fehler } = normalisiereArtikelKopf(p.kopf, ziel, { besitzer: erwarteterBesitzer, heute: this.heuteDatum() });
    if (fehler) throw new KernFehler('ungueltig', `Artikelkopf ungültig: ${fehler}`);
    if (!darfSichtbarkeitSetzen(u, kopf.sichtbarkeit) && !hatRolle(u, 'freigeber')) throw new KernFehler('keine_rechte', `Sichtbarkeit ${kopf.sichtbarkeit} nicht erlaubt`);
    if (p.kopf['status'] === undefined) kopf.status = 'entwurf';
    for (const f of kopf.fundstellen) if (f.quelle.startsWith('ansichten/')) throw new KernFehler('rueckkopplung', `Artikel stützen sich nie auf Ansichten (${f.quelle})`);
    if (kopf.fakten) {
      const ids = new Set(kopf.fundstellen.map((f) => f.id));
      for (const f of kopf.fakten) if (!ids.has(f.fundstelle)) throw new KernFehler('ungueltig', `Fakt ${f.id}: Fundstelle ${f.fundstelle} fehlt in fundstellen`);
    }
    return stringifyMarkdown(ordneArtikelKopf(kopf), p.text);
  }

  private pruefeZiel(ziel: string): string {
    const z = sichererPfad(ziel);
    if (!z.startsWith('wissen/') || !z.endsWith('.md') || istReserviert(z) || z.includes('.orig.')) throw new KernFehler('ungueltig', `Ziel muss eine Markdown-Datei unter wissen/ sein (nicht index.md/log.md): ${ziel}`);
    return z;
  }

  private async legeVorschlagAn(u: User, v: { art: Vorschlag['art']; ziel: string; alt: string | null; neu: string; grund: string; quelle?: string; ki?: boolean }, von: string = u.id): Promise<Vorschlag> {
    const ziel = this.pruefeZiel(v.ziel);
    if (!v.grund.trim()) throw new KernFehler('ungueltig', 'Grund fehlt');
    return this.sperre.run(async () => {
      const aktuell = await this.lies(ziel);
      if (v.art === 'neu' && aktuell !== null) throw new KernFehler('konflikt', `${ziel} gibt es schon (art "aenderung" verwenden)`);
      if (v.art !== 'neu') {
        if (aktuell === null) throw new KernFehler('nicht_gefunden', `${ziel} gibt es nicht`);
        const d = this.ix.datei(ziel);
        if (d && !darfSehen(u, d.sichtbarkeit, d.besitzer)) throw new KernFehler('nicht_gefunden', `${ziel} gibt es nicht`);
      }
      if (v.art === 'nachtrag' && !v.neu.startsWith(aktuell!.trimEnd())) throw new KernFehler('ungueltig', 'Nachtrag: der neue Text muss mit dem bisherigen Text beginnen (nur anhängen)');
      const neu = this.bereiteArtikelVor(u, ziel, v.neu, v.art, aktuell === null ? u.id : this.besitzerVon(aktuell) ?? this.ix.datei(ziel)?.besitzer ?? u.id);
      const vorschlag: Vorschlag = {
        id: neueId(),
        art: v.art,
        ziel,
        alt: aktuell,
        neu,
        grund: v.grund.trim(),
        von,
        erstellt: this.jetzt(),
        status: 'offen',
        basis_hash: aktuell === null ? '' : sha256(aktuell),
        ...(ziel.startsWith('wissen/_regeln/') ? { regel: true } : {}),
        ...(v.quelle ? { quelle: v.quelle } : {}),
        ...(v.ki ? { ki_erzeugt: true, modell: this.modellInfo() } : {}),
        diff: erzeugeDiff(ziel, aktuell ?? '', neu),
      };
      const pfad = `eingang/${vorschlag.id}.json`;
      await this.schreibeDateien([{ pfad, inhalt: JSON.stringify(vorschlag, null, 2) + '\n' }]);
      await this.git.commit([pfad], u.name, `Vorschlag: ${vorschlag.grund}`, `Ziel: ${ziel} (${vorschlag.art})`);
      return vorschlag;
    });
  }

  /** `opt.agent`: Vorschlag über einen Agenten-Zugang, `von` wird `agent/<name>@<userId>` (v1.4 6.3). */
  async schlageVor(u: User, v: Omit<Vorschlag, 'id' | 'status' | 'erstellt' | 'von'>, opt: { agent?: string } = {}): Promise<Vorschlag> {
    brauchtRolle(u, 'autor', 'Vorschläge machen');
    return this.legeVorschlagAn(u, { art: v.art, ziel: v.ziel, alt: v.alt, neu: v.neu ?? '', grund: v.grund, ...(v.quelle ? { quelle: v.quelle } : {}) }, opt.agent ? agentVon(opt.agent, u.id) : u.id);
  }

  /** v1.4.1 U10: Nachtrag vorschlagen (Text wird angehängt; Art `nachtrag`). */
  async nachtrag(u: User, a: { ziel: string; text: string; grund: string; quelle?: string }, opt: { agent?: string } = {}): Promise<Vorschlag> {
    brauchtRolle(u, 'autor', 'Vorschläge machen');
    const ziel = this.pruefeZiel(a.ziel);
    const d = this.ix.datei(ziel);
    const alt = d && darfSehen(u, d.sichtbarkeit, d.besitzer) ? await this.lies(ziel) : null;
    if (alt === null) throw new KernFehler('nicht_gefunden', `${ziel} gibt es nicht`);
    if (!a.text.trim()) throw new KernFehler('ungueltig', 'Text fehlt');
    return this.legeVorschlagAn(u, { art: 'nachtrag', ziel, alt, neu: `${alt.trimEnd()}\n\n${a.text.trim()}\n`, grund: a.grund, ...(a.quelle ? { quelle: a.quelle } : {}) }, opt.agent ? agentVon(opt.agent, u.id) : u.id);
  }

  /**
   * v1.4.1 U10: Sammelfreigabe für offene Vorschläge mit gleichem Grund, gleicher Quelle, gleichem Absender oder einer Liste von IDs.
   * Jeder Vorschlag wird einzeln mit `entscheide` entschieden (Rechte, Konflikte, Commits wie dort). Höchstens 500 je Aufruf.
   */
  async entscheideSammel(u: User, filter: { ids?: string[]; grund?: string; quelle?: string; von?: string; art?: Vorschlag['art'] }, e: { aktion: 'freigeben' | 'ablehnen'; begruendung?: string }): Promise<{ erledigt: Vorschlag[]; konflikte: Vorschlag[]; fehler: { id: string; meldung: string }[] }> {
    if (!filter.ids?.length && !filter.grund && !filter.quelle && !filter.von) throw new KernFehler('ungueltig', 'Sammelfreigabe braucht ids, grund, quelle oder von');
    const passend = (await this.eingang(u, { alle: true })).filter((v) =>
      (!filter.ids || filter.ids.includes(v.id)) && (!filter.grund || v.grund === filter.grund) && (!filter.quelle || v.quelle === filter.quelle) && (!filter.von || v.von === filter.von) && (!filter.art || v.art === filter.art) && v.status === 'offen',
    ).slice(0, 500);
    const out = { erledigt: [] as Vorschlag[], konflikte: [] as Vorschlag[], fehler: [] as { id: string; meldung: string }[] };
    for (const v of passend) {
      try {
        const r = await this.entscheide(u, v.id, e);
        (r.status === 'konflikt' ? out.konflikte : out.erledigt).push(r);
      } catch (f) {
        out.fehler.push({ id: v.id, meldung: (f as Error).message });
      }
    }
    return out;
  }

  async entscheide(u: User, id: string, e: { aktion: 'freigeben' | 'ablehnen' | 'aendern'; begruendung?: string; neuerText?: string }): Promise<Vorschlag> {
    return this.sperre.run(async () => {
      const sid = id.replace(/[^\w.-]/g, '');
      const roh = await this.lies(`eingang/${sid}.json`);
      if (!roh) {
        if (await this.lies(`eingang/erledigt/${sid}.json`)) throw new KernFehler('konflikt', `Vorschlag ${id} ist schon entschieden`);
        throw new KernFehler('nicht_gefunden', `Vorschlag ${id} nicht gefunden`);
      }
      const v = vorschlagSchema.parse(JSON.parse(roh)) as Vorschlag;
      if (v.status !== 'offen' && v.status !== 'konflikt') throw new KernFehler('konflikt', `Vorschlag ${id} ist schon entschieden`);
      const r = this.vorschlagsRechte(v);
      if (!darfSehen(u, r.sichtbarkeit, r.besitzer)) throw new KernFehler('nicht_gefunden', `Vorschlag ${id} nicht gefunden`);
      // S1 M7: Selbstfreigabe nur, wenn das Ziel schon privat dem Nutzer gehört (oder neu und privat ist) und privat bleibt
      const privatVon = (text: string | null) => {
        if (text === null) return true;
        const k = parseMarkdown(text).kopf;
        return k['sichtbarkeit'] === 'ich' && String(k['besitzer'] ?? '') === u.id;
      };
      const zielJetzt = await this.lies(v.ziel);
      const eigenePrivate = r.sichtbarkeit === 'ich' && r.besitzer === u.id && privatVon(zielJetzt) && privatVon(v.alt);
      if (!eigenePrivate) brauchtRolle(u, 'freigeber', 'Vorschläge entscheiden');
      if (v.ziel.startsWith('wissen/_regeln/') && e.aktion !== 'ablehnen') brauchtRolle(u, 'admin', 'Regeln freigeben');
      const begruendung = e.begruendung?.trim();
      const am = this.jetzt();
      const quelle = `eingang/${sid}.json`;
      const erledigt = `eingang/erledigt/${sid}.json`;

      if (e.aktion === 'ablehnen') {
        if (!begruendung) throw new KernFehler('ungueltig', 'Ablehnung braucht eine Begründung');
        const fertig: Vorschlag = { ...v, status: 'abgelehnt', entscheidung: { von: u.id, am, begruendung } };
        await this.schreibeDateien([{ pfad: erledigt, inhalt: JSON.stringify(fertig, null, 2) + '\n' }, { pfad: quelle, inhalt: null }]);
        await this.git.commit([quelle, erledigt], u.name, `Vorschlag abgelehnt: ${v.grund}`, `Begründung: ${begruendung}`);
        return fertig;
      }

      let neu = v.neu;
      if (e.aktion === 'aendern') {
        if (!e.neuerText?.trim()) throw new KernFehler('ungueltig', 'Geänderter Text fehlt');
        neu = this.bereiteArtikelVor(u, v.ziel, e.neuerText, v.art, this.besitzerVon(v.neu) ?? this.besitzerVon(v.alt) ?? v.von);
        if (eigenePrivate && !hatRolle(u, 'freigeber') && !privatVon(neu)) brauchtRolle(u, 'freigeber', 'private Artikel veröffentlichen');
      }
      const aktuell = await this.lies(v.ziel);
      const istHash = aktuell === null ? '' : sha256(aktuell);
      const sollHash = v.basis_hash ?? (v.alt === null ? '' : sha256(v.alt));
      // v1.4.1 U10: ein Nachtrag hängt nur an; hat sich das Ziel geändert, wird der Anhang an den neuen Stand gesetzt
      const anhang = v.art === 'nachtrag' && v.alt !== null && e.aktion !== 'aendern' ? nachtragsAnhang(v.alt, v.neu) : null;
      if (istHash !== sollHash && anhang !== null && aktuell !== null) {
        neu = this.bereiteArtikelVor(u, v.ziel, aktuell.trimEnd() + anhang, 'nachtrag', this.besitzerVon(aktuell) ?? v.von);
      } else if (istHash !== sollHash) {
        // v1.2: Zieldatei hat sich geändert → nicht überschreiben, sondern neu vergleichen und Status „konflikt“
        if (aktuell === null && v.art !== 'neu') {
          const weg: Vorschlag = { ...v, status: 'abgelehnt', entscheidung: { von: u.id, am, begruendung: 'Zieldatei gibt es nicht mehr' } };
          await this.schreibeDateien([{ pfad: erledigt, inhalt: JSON.stringify(weg, null, 2) + '\n' }, { pfad: quelle, inhalt: null }]);
          await this.git.commit([quelle, erledigt], u.name, `Vorschlag erledigt: ${v.grund}`, 'Zieldatei gibt es nicht mehr.');
          return weg;
        }
        const konflikt: Vorschlag = {
          ...v,
          art: aktuell === null ? 'neu' : v.art === 'neu' ? 'aenderung' : v.art,
          alt: aktuell,
          neu: e.aktion === 'aendern' ? neu : v.neu,
          basis_hash: istHash,
          status: 'konflikt',
          diff: erzeugeDiff(v.ziel, aktuell ?? '', e.aktion === 'aendern' ? neu : v.neu),
        };
        await this.schreibeDateien([{ pfad: quelle, inhalt: JSON.stringify(konflikt, null, 2) + '\n' }]);
        await this.git.commit([quelle], u.name, `Konflikt: ${v.grund}`, `${v.ziel} wurde seit dem Vorschlag geändert; neuer Vergleich erstellt.`);
        return konflikt;
      }

      let inhalt: string | null = null;
      if (v.art !== 'loeschung') {
        const p = parseMarkdown(neu);
        const { kopf } = normalisiereArtikelKopf(p.kopf, v.ziel, { besitzer: v.von, heute: this.heuteDatum() });
        if (kopf.status !== 'veraltet') kopf.status = 'freigegeben';
        kopf.stand = this.heuteDatum();
        const basis = await this.git.head();
        kopf.verified = [...(kopf.verified ?? []), { by: `human:${u.id}`, at: am, ...(basis ? { commit: basis } : {}), vorschlag: v.id }];
        inhalt = stringifyMarkdown(ordneArtikelKopf(kopf), p.text);
      }
      const fertig: Vorschlag = {
        ...v,
        neu: inhalt ?? '',
        diff: erzeugeDiff(v.ziel, aktuell ?? v.alt ?? '', inhalt ?? ''),
        status: 'freigegeben',
        entscheidung: { von: u.id, am, ...(begruendung ? { begruendung } : {}) },
      };
      await this.schreibeDateien([
        { pfad: v.ziel, inhalt },
        { pfad: erledigt, inhalt: JSON.stringify(fertig, null, 2) + '\n' },
        { pfad: quelle, inhalt: null },
      ]);
      const verb = v.art === 'neu' ? 'angelegt' : v.art === 'loeschung' ? 'gelöscht' : v.art === 'nachtrag' ? 'ergänzt' : 'geändert';
      await this.commitMitOrdnerIndex([v.ziel, erledigt, quelle], u.name, v.grund, `${v.ziel} ${verb}. Vorschlag ${v.id} von ${v.von}, ${e.aktion === 'aendern' ? 'geändert und ' : ''}freigegeben von ${u.name}${begruendung ? `: ${begruendung}` : ''}.`);
      return fertig;
    });
  }

  /* ================================================================ */
  /* Briefing, Pflege                                                  */
  /* ================================================================ */

  async faellig(u: User): Promise<Artikel[]> {
    const heute = this.heuteDatum();
    const grenze = plusTage(heute, FAKT_VORLAUF_TAGE);
    const faktPfade = new Set((await this.fakten(u)).filter((f) => f.gueltig && f.gilt_bis && f.gilt_bis <= grenze).map((f) => f.artikel));
    const out: Artikel[] = [];
    for (const d of this.sichtbareDateien(u, 'wissen')) {
      if (d.status === 'veraltet') continue;
      if ((d.pruefen_bis && d.pruefen_bis < heute) || faktPfade.has(d.pfad)) {
        const i = await this.lies(d.pfad);
        if (i) out.push(this.parseArtikel(d.pfad, i));
      }
    }
    return out.sort((a, b) => (a.kopf.pruefen_bis ?? '9999').localeCompare(b.kopf.pruefen_bis ?? '9999'));
  }

  /** Erweiterung: Fakten, deren `gilt_bis` in den nächsten `tage` Tagen endet oder schon vorbei ist. */
  async ablaufendeFakten(u: User, tage = FAKT_VORLAUF_TAGE): Promise<Fakt[]> {
    const grenze = plusTage(this.heuteDatum(), tage);
    return (await this.fakten(u)).filter((f) => f.gilt_bis && f.gilt_bis <= grenze && !(f.ersetzt === undefined && false));
  }

  async verlauf(pfad: string): Promise<{ commit: string; von: string; am: string; grund: string }[]> {
    const p = sichererPfad(pfad);
    return (await this.git.log({ pfad: p, folge: true })).map(({ commit, von, am, grund }) => ({ commit, von, am, grund }));
  }

  async briefing(u: User, seit?: string): Promise<{ datum: string; text: string; entscheidungen: string[]; links: string[] }> {
    const datum = this.heuteDatum();
    const ab = seit && /^\d{4}-\d{2}-\d{2}/.test(seit) ? seit.slice(0, 10) : plusTage(datum, -7);
    const commits = await this.git.log({ seit: `${ab}T00:00:00` });
    const geaendert = new Map<string, { titel: string; grund: string; von: string; am: string }>();
    for (const c of commits) {
      for (const p of c.dateien ?? []) {
        if (!/^(wissen|quellen)\//.test(p) || istReserviert(p) || !p.endsWith('.md') || p.includes('.orig.')) continue;
        const d = this.ix.datei(p);
        if (!d || !darfSehen(u, d.sichtbarkeit, d.besitzer) || geaendert.has(p)) continue;
        geaendert.set(p, { titel: d.titel, grund: c.grund, von: c.von, am: c.am.slice(0, 10) });
      }
    }
    const artikel = [...geaendert.entries()].filter(([p]) => p.startsWith('wissen/'));
    const quellen = [...geaendert.entries()].filter(([p]) => p.startsWith('quellen/'));
    const faellig = await this.faellig(u);
    const pruefFaellig = faellig.filter((a) => a.kopf.pruefen_bis && a.kopf.pruefen_bis < datum);
    const fakten = (await this.ablaufendeFakten(u)).filter((f) => f.gueltig || (f.gilt_bis ?? '') < datum);
    const offen = await this.eingang(u, { alle: true });

    const entscheidungen: string[] = [];
    if (hatRolle(u, 'freigeber')) for (const v of offen.slice(0, 3)) entscheidungen.push(`Vorschlag freigeben oder ablehnen: ${v.grund} (${v.id})`);
    for (const a of pruefFaellig) if (entscheidungen.length < 3) entscheidungen.push(`„${a.kopf.titel}“ prüfen, Prüftermin ${a.kopf.pruefen_bis} ist vorbei`);
    for (const f of fakten) if (entscheidungen.length < 3) entscheidungen.push(`${f.gegenstand} (${f.artikelTitel}): gilt bis ${f.gilt_bis}, neuen Wert oder Verlängerung festlegen`);

    const links = [...new Set([...artikel.map(([p]) => p), ...pruefFaellig.map((a) => a.pfad), ...fakten.map((f) => f.artikel)])];
    const bloecke: { kopf: string; zeilen: string[] }[] = [
      { kopf: `Briefing für ${u.name}, ${datum} (Änderungen seit ${ab})`, zeilen: [] },
      {
        kopf: artikel.length || quellen.length ? `Geändert: ${artikel.length} Artikel, ${quellen.length} Quellen.` : 'Keine Änderungen im Wissen und in den Quellen.',
        zeilen: [...artikel, ...quellen].map(([, x]) => `- ${x.titel}: ${x.grund} (${x.von}, ${x.am})`),
      },
      { kopf: pruefFaellig.length ? `Prüfung fällig: ${pruefFaellig.length} Artikel.` : 'Keine Prüftermine überschritten.', zeilen: pruefFaellig.map((a) => `- ${a.kopf.titel} (fällig seit ${a.kopf.pruefen_bis}, verantwortlich ${a.kopf.verantwortlich || 'offen'})`) },
      ...(fakten.length ? [{ kopf: `Fakten mit Ablaufdatum: ${fakten.length}.`, zeilen: fakten.map((f) => `- ${f.gegenstand}: ${f.wert}${f.einheit ? ' ' + f.einheit : ''}, gilt bis ${f.gilt_bis}`) }] : []),
      { kopf: offen.length ? `Offen im Eingang: ${offen.length} Vorschläge.` : 'Der Eingang ist leer.', zeilen: offen.map((v) => `- ${v.grund} (${v.art}, ${v.ziel})`) },
      ...(entscheidungen.length ? [{ kopf: 'Zu entscheiden:', zeilen: entscheidungen.map((x, i) => `${i + 1}. ${x}`) }] : []),
    ];
    // Auf ≤ 300 Wörter kürzen: Listen von hinten ausdünnen, Entscheidungen bleiben
    const render = () => bloecke.map((b) => [b.kopf, ...b.zeilen].join('\n')).join('\n\n');
    const maxJe = [8, 8, 8, 8, 8, 3];
    bloecke.forEach((b, i) => {
      const m = maxJe[i] ?? 8;
      if (b.zeilen.length > m && b.kopf !== 'Zu entscheiden:') b.zeilen = [...b.zeilen.slice(0, m), `- und ${b.zeilen.length - m} weitere`];
    });
    let text = render();
    let schutz = 200;
    while (wortAnzahl(text) > 300 && schutz-- > 0) {
      const b = [...bloecke].reverse().find((x) => x.kopf !== 'Zu entscheiden:' && x.zeilen.length > 1);
      if (!b) break;
      b.zeilen.splice(b.zeilen.length - 2, 1);
      text = render();
    }
    if (wortAnzahl(text) > 300) text = text.split(/\s+/).slice(0, 299).join(' ') + ' …';
    return { datum, text, entscheidungen, links };
  }

  /** Erweiterung: Briefing (Sicht `betrieb`) als `briefing/<datum>.md` ablegen und committen. */
  async speichereBriefing(u: User, seit?: string): Promise<string> {
    brauchtRolle(u, 'freigeber', 'Briefings ablegen');
    const neutral: User = { id: '__betrieb__', name: this.cfg.betrieb || 'Betrieb', rollen: ['leser'], teams: [] };
    const b = await this.briefing(neutral, seit);
    const pfad = `briefing/${b.datum}.md`;
    await this.sperre.run(() => this.schreibeUndCommitte([{ pfad, inhalt: stringifyMarkdown({ type: 'Briefing', titel: `Briefing ${b.datum}`, erstellt_von: u.id }, b.text) }], u.name, `Briefing ${b.datum}`));
    return pfad;
  }

  /* ================================================================ */
  /* Prüfen (Lint)                                                     */
  /* ================================================================ */

  async pruefe(u: User, opt: { vorschlaegeAnlegen?: boolean } = {}): Promise<Befund[]> {
    brauchtRolle(u, 'freigeber', 'den Aufräumlauf starten');
    const befunde: Befund[] = [];
    const heute = this.heuteDatum();
    const grenze = plusTage(heute, FAKT_VORLAUF_TAGE);
    // Index gegen Dateien
    const dateienDisk = await this.alleMarkdownDateien();
    const ixDateien = new Map(this.ix.dateien().map((d) => [d.pfad, d]));
    for (const p of dateienDisk) {
      const i = (await this.lies(p)) ?? '';
      if (ixDateien.get(p)?.hash !== sha256(i)) befunde.push({ art: 'index_veraltet', pfad: p, text: 'Datei und Index weichen ab (wird beim nächsten Abgleich korrigiert).' });
    }
    await this.sperre.run(() => this.abgleich());

    const artikel = await this.listeWissen(u);
    const alleArtikelText = new Map<string, string>();
    for (const a of artikel) alleArtikelText.set(a.pfad, a.text);
    const offen = await this.offeneVorschlaege();
    const vorschlagen = async (ziel: string, neuKopf: ArtikelKopf, text: string, grund: string): Promise<string | undefined> => {
      if (opt.vorschlaegeAnlegen === false) return undefined;
      if (offen.some((v) => v.ziel === ziel && v.grund === grund)) return offen.find((v) => v.ziel === ziel && v.grund === grund)!.id;
      try {
        const v = await this.legeVorschlagAn(u, { art: 'aenderung', ziel, alt: await this.lies(ziel), neu: stringifyMarkdown(ordneArtikelKopf(neuKopf), text), grund });
        offen.push(v);
        return v.id;
      } catch {
        return undefined;
      }
    };

    for (const a of artikel) {
      const d = ixDateien.get(a.pfad) ?? this.ix.datei(a.pfad);
      if (d?.fehler) befunde.push({ art: 'kopf_fehlerhaft', pfad: a.pfad, text: d.fehler });
      if (a.kopf.status === 'veraltet') continue;
      if (a.kopf.pruefen_bis && a.kopf.pruefen_bis < heute) befunde.push({ art: 'pruefung_faellig', pfad: a.pfad, text: `Prüftermin ${a.kopf.pruefen_bis} ist vorbei (verantwortlich: ${a.kopf.verantwortlich || 'offen'}).` });
      if ((d?.groesse ?? 0) > MAX_ARTIKEL_BYTES) befunde.push({ art: 'zu_gross', pfad: a.pfad, text: `Artikel hat ${Math.round((d!.groesse / 1024) * 10) / 10} KB (Grenze ~8 KB). Teilen in mehrere Artikel vorschlagen.` });
      // Fundstellen
      const kaputt: string[] = [];
      for (const f of a.kopf.fundstellen) {
        const i = await this.lies(f.quelle).catch(() => null);
        const n = i?.split(/\r?\n/).length ?? 0;
        if (i === null || f.zeilen[0] > f.zeilen[1] || f.zeilen[1] > n) {
          kaputt.push(f.id);
          befunde.push({ art: 'fundstelle_kaputt', pfad: a.pfad, text: `Fundstelle ${f.id} (${f.quelle}, Zeilen ${f.zeilen[0]}–${f.zeilen[1]}) ${i === null ? 'Quelle fehlt' : 'Zeilen passen nicht'}.` });
        }
      }
      for (const f of a.kopf.fakten ?? []) {
        if (!a.kopf.fundstellen.some((x) => x.id === f.fundstelle)) befunde.push({ art: 'fundstelle_kaputt', pfad: a.pfad, text: `Fakt ${f.id} verweist auf unbekannte Fundstelle ${f.fundstelle}.` });
      }
      if (kaputt.length) {
        const neuKopf: ArtikelKopf = { ...a.kopf, fundstellen: a.kopf.fundstellen.filter((f) => !kaputt.includes(f.id)) };
        if (neuKopf.fakten) neuKopf.fakten = neuKopf.fakten.filter((f) => !kaputt.includes(f.fundstelle));
        const id = await vorschlagen(a.pfad, neuKopf, a.text, `Aufräumen: kaputte Fundstellen entfernen (${kaputt.join(', ')})`);
        if (id) befunde.filter((b) => b.pfad === a.pfad && b.art === 'fundstelle_kaputt').forEach((b) => (b.vorschlag = id));
      }
      // Verwaist: keine eingehenden Links
      const name = posix.basename(a.pfad);
      const verlinkt = [...alleArtikelText.entries()].some(([p, t]) => p !== a.pfad && (t.includes(`${a.pfad}`) || t.includes(`(${name}`) || t.includes(`/${name}`) || t.includes(`[[${name.replace(/\.md$/, '')}`)));
      if (!verlinkt && !a.pfad.startsWith('wissen/_regeln/')) befunde.push({ art: 'verwaist', pfad: a.pfad, text: 'Kein anderer Artikel verlinkt hierher.' });
    }

    // v1.3 R3: Ansichten abgelaufen, Rückkopplung
    const ansichtsKoepfe = await this.alleAnsichtsKoepfe();
    const abgelaufen = ansichtsKoepfe.filter((a) => a.kopf.gilt_bis < heute).length;
    if (abgelaufen) befunde.push({ art: 'ansicht_abgelaufen', pfad: 'ansichten/', text: `${abgelaufen} abgelaufene Ansichten können gelöscht werden (Inhalt bleibt in den Quellen und im Wissen).` });
    for (const a of artikel) for (const f of a.kopf.fundstellen) if (f.quelle.startsWith('ansichten/')) befunde.push({ art: 'rueckkopplung', pfad: a.pfad, text: `Fundstelle ${f.id} stützt sich auf eine Ansicht (${f.quelle}); Ansichten sind nie Wahrheit.` });
    for (const a of ansichtsKoepfe) for (const b of a.kopf.basis ?? []) if (b.pfad.startsWith('ansichten/')) befunde.push({ art: 'rueckkopplung', pfad: a.pfad, text: 'Ansicht stützt sich auf eine Ansicht.' });

    // Fakten: abgelaufen, läuft ab, Widersprüche
    const fakten = await this.fakten(u);
    const ersetzt = new Set(fakten.filter((f) => f.ersetzt).map((f) => f.ersetzt!));
    for (const f of fakten) {
      if (ersetzt.has(f.id)) continue;
      if (f.gilt_bis && f.gilt_bis < heute) {
        const b: Befund = { art: 'fakt_abgelaufen', pfad: f.artikel, text: `Fakt „${f.gegenstand}“ (${f.wert}${f.einheit ? ' ' + f.einheit : ''}) gilt nur bis ${f.gilt_bis}.` };
        const a = artikel.find((x) => x.pfad === f.artikel);
        if (a) {
          const neuKopf: ArtikelKopf = { ...a.kopf, fakten: (a.kopf.fakten ?? []).filter((x) => x.id !== f.id) };
          const id = await vorschlagen(a.pfad, neuKopf, a.text, `Aufräumen: abgelaufenen Fakt „${f.gegenstand}“ entfernen`);
          if (id) b.vorschlag = id;
        }
        befunde.push(b);
      } else if (f.gilt_bis && f.gilt_bis <= grenze) {
        befunde.push({ art: 'fakt_laeuft_ab', pfad: f.artikel, text: `Fakt „${f.gegenstand}“ läuft am ${f.gilt_bis} ab.` });
      }
    }
    const gueltig = fakten.filter((f) => f.gueltig);
    const gruppen = new Map<string, Fakt[]>();
    for (const f of gueltig) {
      const k = `${f.art}|${slugify(f.gegenstand)}|${f.einheit ?? ''}`;
      gruppen.set(k, [...(gruppen.get(k) ?? []), f]);
    }
    for (const fs of gruppen.values()) {
      const werte = new Set(fs.map((f) => String(f.wert).trim().toLowerCase()));
      if (werte.size > 1) {
        befunde.push({
          art: 'widerspruch',
          pfad: fs[0]!.artikel,
          text: `Widerspruch bei „${fs[0]!.gegenstand}“: ${fs.map((f) => `${f.wert}${f.einheit ? ' ' + f.einheit : ''} (${f.artikel})`).join(' gegen ')}.`,
        });
      }
    }
    return befunde;
  }

  /* ================================================================ */
  /* OKF                                                               */
  /* ================================================================ */

  /** S1 N1 / v1.4 8.6: index.md eines Ordners nach den Rechten von `u` (für MCP-Ressourcen und Wegweiser). */
  async ordnerIndex(u: User, ordner: '' | 'wissen' | 'quellen' | `wissen/${string}`): Promise<string> {
    const o = ordner === '' ? '' : sichererPfad(ordner).replace(/\/$/, '');
    if (o !== '' && o !== 'wissen' && o !== 'quellen' && !/^wissen\/[^/]+$/.test(o)) throw new KernFehler('ungueltig', 'Ordner: "", wissen, quellen oder wissen/<gruppe>');
    const dateien = this.ix.dateien().filter((d) => darfSehen(u, d.sichtbarkeit, d.besitzer));
    const kurz = new Map<string, string>();
    for (const d of dateien.filter((x) => x.art === 'wissen' && (o === '' || x.pfad.startsWith(o + '/')))) {
      const i = await this.lies(d.pfad);
      if (i) kurz.set(d.pfad, String(parseMarkdown(i).kopf['kurzfassung'] ?? ''));
    }
    return erzeugeIndex(o, dateien, this.cfg.betrieb, kurz, this.produkt, true);
  }

  /**
   * OKF-Export. Mit `fuer` (S1 N1, v1.4 7.1) nur, was dieser Nutzer sieht (eigene private Dateien eingeschlossen, keine
   * Protokolle); ohne `fuer` der Systemexport (alles außer `ich`, für Betrieb und CLI als admin).
   */
  async exportiereOkf(zielOrdner: string, opt: { mitPrivat?: boolean; fuer?: User } = {}): Promise<{ dateien: number; ordner: string; ausgelassen: number }> {
    const darf = (d: DateiEintrag) => (opt.fuer ? darfSehen(opt.fuer, d.sichtbarkeit, d.besitzer) : d.sichtbarkeit !== 'ich' || !!opt.mitPrivat);
    const quellTitel = new Map(this.ix.dateien().filter((d) => d.art === 'quelle' && darf(d)).map((d) => [d.pfad, d.titel]));
    const dateien: { pfad: string; inhalt: string | Buffer }[] = [];
    let ausgelassen = 0;
    for (const d of this.ix.dateien()) {
      if (!darf(d)) { ausgelassen++; continue; }
      const i = await this.lies(d.pfad);
      if (i === null) continue;
      dateien.push({ pfad: d.pfad, inhalt: i });
      if (d.art === 'quelle') {
        const basis = posix.basename(d.pfad, '.md');
        const ordner = dirname(this.abs(d.pfad));
        for (const e of await readdir(ordner)) if (e.startsWith(`${basis}.orig.`)) dateien.push({ pfad: `${posix.dirname(d.pfad)}/${e}`, inhalt: await readFile(join(ordner, e)) });
      }
    }
    for (const r of opt.fuer ? [] : ['log.md', 'wissen/log.md', 'quellen/log.md']) {
      const i = await this.lies(r);
      if (i) dateien.push({ pfad: r, inhalt: i });
    }
    const gruppen = new Set(opt.fuer ? [] : this.ix.dateien().filter((d) => d.art === 'wissen').map((d) => d.pfad.split('/')).filter((t) => t.length > 2).map((t) => t[1]!));
    for (const g of gruppen) {
      const i = await this.lies(`wissen/${g}/log.md`);
      if (i) dateien.push({ pfad: `wissen/${g}/log.md`, inhalt: i });
    }
    const n = await exportiereOkfBuendel(resolve(zielOrdner), dateien, {
      betrieb: this.cfg.betrieb,
      quellTitel,
      eintraege: this.ix.dateien().filter(darf),
      produkt: this.produkt,
    });
    return { dateien: n, ordner: resolve(zielOrdner), ausgelassen };
  }

  async importiereOkf(u: User, quellOrdner: string, opt: { sammlung?: string; sichtbarkeit?: Sichtbarkeit } = {}): Promise<{ quellen: Quelle[]; vorschlaege: Vorschlag[]; uebersprungen: string[] }> {
    brauchtRolle(u, 'autor', 'importieren');
    const buendel = await leseOkfBuendel(resolve(quellOrdner));
    const quellen: Quelle[] = [];
    const vorschlaege: Vorschlag[] = [];
    const uebersprungen: string[] = [];
    // 1. Kern-Quellen an ihren Pfad zurück (Rohmaterial, keine Wissensänderung)
    const aenderungen: Aenderung[] = [];
    for (const q of buendel.kernQuellen) {
      const vorhanden = await this.lies(q.pfad);
      if (vorhanden === q.inhalt) {
        uebersprungen.push(q.pfad);
        continue;
      }
      const ziel = vorhanden === null ? q.pfad : await this.freierPfad(q.pfad.replace(/\.md$/, ''));
      // S1 M7: Importierte Quellen gehören dem Importierenden; Sichtbarkeit nur, wenn er sie vergeben darf
      const pq = parseMarkdown(q.inhalt);
      const sicht = String(pq.kopf['sichtbarkeit'] ?? opt.sichtbarkeit ?? 'betrieb') as Sichtbarkeit;
      const fremdPrivat = sicht === 'ich' && String(pq.kopf['erfasst_von'] ?? '') !== u.id;
      if (!/^(ich|betrieb|team:[\w-]+)$/.test(sicht) || !darfSichtbarkeitSetzen(u, sicht) || (fremdPrivat && !hatRolle(u, 'admin'))) {
        uebersprungen.push(`${q.pfad} (Sichtbarkeit ${sicht} nicht erlaubt)`);
        continue;
      }
      pq.kopf['erfasst_von'] = u.id;
      pq.kopf['sichtbarkeit'] = sicht;
      q.inhalt = stringifyMarkdown(pq.kopf, pq.text);
      aenderungen.push({ pfad: ziel, inhalt: q.inhalt });
      for (const o of q.originale) aenderungen.push({ pfad: ziel.replace(/\.md$/, '') + o.endung, inhalt: o.daten });
    }
    if (aenderungen.length) {
      await this.sperre.run(() => this.schreibeUndCommitte(aenderungen, u.name, `OKF-Import: ${aenderungen.filter((a) => a.pfad.endsWith('.md')).length} Quellen`));
      for (const a of aenderungen.filter((x) => x.pfad.endsWith('.md'))) quellen.push(this.parseQuelle(a.pfad, String(a.inhalt)));
    }
    // 2. Kern-Artikel als Vorschläge
    for (const a of buendel.kernArtikel) {
      const vorhanden = await this.lies(a.pfad);
      if (vorhanden === a.inhalt) {
        uebersprungen.push(a.pfad);
        continue;
      }
      try {
        vorschlaege.push(
          await this.legeVorschlagAn(u, { art: vorhanden === null ? 'neu' : 'aenderung', ziel: a.pfad, alt: vorhanden, neu: hatRolle(u, 'admin') ? a.inhalt : this.mitBesitzer(a.inhalt, vorhanden === null ? u.id : this.besitzerVon(vorhanden) ?? u.id), grund: `OKF-Import: ${a.pfad}` }),
        );
      } catch (e) {
        uebersprungen.push(`${a.pfad} (${(e as Error).message})`);
      }
    }
    // 3. Fremde OKF-Dateien: als Quelle aufnehmen, daraus Vorschläge kompilieren
    for (const f of buendel.fremd) {
      const tmp = join(this.dir, '.kern', `okf-${Date.now()}-${slugify(f.pfad)}.md`);
      await writeFile(tmp, f.inhalt);
      try {
        const r = await this.fuegeHinzu(u, {
          art: 'datei', dateiPfad: tmp, dateiName: posix.basename(f.pfad), titel: f.titel, sammlung: opt.sammlung ?? 'okf-import', sichtbarkeit: opt.sichtbarkeit ?? 'betrieb',
        });
        if (r.doppelt) uebersprungen.push(f.pfad);
        else {
          quellen.push(r.quelle);
          vorschlaege.push(...r.vorschlaege);
        }
      } finally {
        await rm(tmp, { force: true });
      }
    }
    return { quellen, vorschlaege, uebersprungen };
  }

  /* ================================================================ */
  /* Beobachten                                                        */
  /* ================================================================ */

  /** Erweiterung: alle nicht übernommenen Änderungen in wissen/ und quellen/ indizieren und committen (z. B. nach Kopieren von Dateien). */
  async uebernimmAenderungen(autor = this.cfg.externerAutor ?? 'extern', grund = 'extern geändert'): Promise<string[]> {
    return this.sperre.run(async () => {
      await this.abgleich();
      const offen = (await this.git.offeneAenderungen(['wissen', 'quellen'])).filter((p) => !istReserviert(p));
      if (offen.length) await this.commitMitOrdnerIndex(offen, autor, grund);
      return offen;
    });
  }

  beobachteOrdner(onChange?: (pfade: string[]) => void): () => void {
    const offen = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const ignoriert = (abs: string) => {
      const rel = relative(this.dir, abs).split(sep).join('/');
      if (!rel || rel.startsWith('..')) return true;
      const base = posix.basename(rel);
      return (
        rel.startsWith('.git') || rel.startsWith('.kern') || rel.includes('/.') || base.startsWith('.') || base.endsWith('.tmp') || base.endsWith('~') ||
        base.endsWith('.swp') || ((rel.startsWith('wissen/') || rel.startsWith('quellen/')) && istReserviert(rel))
      );
    };
    const w = watch([join(this.dir, 'wissen'), join(this.dir, 'quellen')], {
      ignoreInitial: true,
      ignored: (p: string) => ignoriert(p),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const verarbeite = async () => {
      const pfade = [...offen];
      offen.clear();
      const wirklich = await this.sperre.run(async () => {
        const geaendert: string[] = [];
        for (const p of pfade) {
          if (p.endsWith('.md') && !p.includes('.orig.')) {
            const inhalt = await this.lies(p);
            const d = this.ix.datei(p);
            if (inhalt === null ? !d : d?.hash === sha256(inhalt)) {
              // eigener Schreibvorgang oder nichts geändert; trotzdem prüfen, ob git offen hat
            }
          }
          geaendert.push(p);
        }
        const git = (await this.git.offeneAenderungen(geaendert)).filter((p) => !istReserviert(p));
        if (!git.length) return [];
        await this.commitMitOrdnerIndex(git, this.cfg.externerAutor ?? 'extern', 'extern geändert');
        return git;
      });
      if (wirklich.length) onChange?.(wirklich);
    };
    const merke = (abs: string) => {
      if (ignoriert(abs)) return;
      offen.add(relative(this.dir, abs).split(sep).join('/'));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void verarbeite().catch((e) => { if (process.env.KERN_DEBUG) console.error('beobachter', e); }), 250);
    };
    w.on('add', merke).on('change', merke).on('unlink', merke);
    this.watcher = w;
    return () => {
      if (timer) clearTimeout(timer);
      void w.close();
      if (this.watcher === w) this.watcher = null;
    };
  }

  /* ================================================================ */
  /* v1.3 / v1.3.1: Lesen, Ampel, Ansichten, Heute                     */
  /* ================================================================ */

  private lesenDb: LeseStand | null = null;
  private get lesen(): LeseStand {
    if (!this.lesenDb) this.lesenDb = new LeseStand(join(this.dir, '.kern', 'lesen.sqlite'), () => this.cfg.heute?.() ?? new Date());
    return this.lesenDb;
  }

  private lesenPfad(u: User): string {
    return `nutzer/${slugify(u.id, 64)}/lesen.yaml`;
  }

  private async leseLesen(u: User): Promise<LeseEinstellungen> {
    const betrieb = await this.leseBetriebsEinstellungen();
    const std = standardLesen(LESESTILE.includes(betrieb['standard_lesestil'] as Lesestil) ? (betrieb['standard_lesestil'] as Lesestil) : 'zusammenfassung');
    const roh = await this.lies(this.lesenPfad(u));
    if (!roh) return { ...std, budget_hart: std.lesebudget_hart };
    try {
      const teil = (YAML.parse(roh) ?? {}) as Partial<LeseEinstellungen>;
      const zusammen = { ...std, ...teil, nur_abweichungen: teil.nur_abweichungen ?? (teil.stil === 'fokus' ? true : std.nur_abweichungen) };
      if (teil.budget_hart !== undefined && teil.lesebudget_hart === undefined) zusammen.lesebudget_hart = teil.budget_hart;
      const r = leseEinstellungenSchema.safeParse(zusammen);
      const l = r.success ? (r.data as LeseEinstellungen) : std;
      return { ...l, budget_hart: l.lesebudget_hart };
    } catch {
      return { ...std, budget_hart: std.lesebudget_hart };
    }
  }

  /** v1.3: eigene Leseeinstellungen ändern (nur für sich selbst; liegt in git unter nutzer/<id>/lesen.yaml). */
  async setzeLeseEinstellungen(u: User, e: Partial<LeseEinstellungen>): Promise<LeseEinstellungen> {
    const { budget_hart, ...rest } = e;
    if (budget_hart !== undefined && rest.lesebudget_hart === undefined) rest.lesebudget_hart = budget_hart;
    const neu = { ...(await this.leseLesen(u)), ...rest };
    delete (neu as Partial<LeseEinstellungen>).budget_hart;
    const r = leseEinstellungenSchema.safeParse(neu);
    if (!r.success) throw new KernFehler('ungueltig', `Leseeinstellungen ungültig: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const pfad = this.lesenPfad(u);
    await this.sperre.run(async () => {
      await this.schreibeDateien([{ pfad, inhalt: `# Leseeinstellungen von ${u.name}. Nur diese Person ändert sie.\n${YAML.stringify(r.data)}` }]);
      await this.git.commit([pfad], u.name, 'Leseeinstellungen geändert');
    });
    return { ...(r.data as LeseEinstellungen), budget_hart: r.data.lesebudget_hart };
  }

  /** v1.3: Lesestand merken (nur für den Lesenden, .kern/lesen.sqlite, 30 Tage). */
  async lesestand(u: User, e: { objekt: string; punkt?: string; stufe: 1 | 2 | 3 | 4 }): Promise<void> {
    if (![1, 2, 3, 4].includes(e.stufe)) throw new KernFehler('ungueltig', 'Stufe 1 bis 4');
    this.lesen.merke(u.id, e.objekt, e.punkt ?? '', e.stufe, this.jetzt());
  }

  /** v1.3: Lesebilanz nur für den Nutzer selbst. Kein Bericht über andere. */
  async lesebilanz(u: User): Promise<{ nieGeoeffnet: { zweck: string; regel?: string; anzahl: number }[]; vorschlaege: string[]; minutenZusammenfassung: number; hinweis: { text: string; vorschlag: Lesestil } | null }> {
    const grenze = plusTage(this.heuteDatum(), -30);
    const stilJetzt = (await this.leseLesen(u)).stil;
    const eigene = (await this.alleAnsichtsKoepfe()).filter((a) => a.kopf.fuer === u.id && a.kopf.generated.at.slice(0, 10) >= grenze);
    const offen = this.lesen.objekte(u.id);
    const nie = new Map<string, number>();
    let minuten = 0;
    for (const a of eigene) {
      if (!offen.has(a.kopf.id)) nie.set(a.kopf.zweck, (nie.get(a.kopf.zweck) ?? 0) + 1);
      else if ((a.kopf.stil ?? 'zusammenfassung') === stilJetzt) minuten += a.kopf.lesezeit_min;
    }
    const nieGeoeffnet = [...nie.entries()].map(([zweck, anzahl]) => ({ zweck, anzahl }));
    const vorschlaege: string[] = [];
    for (const n of nieGeoeffnet) if (n.anzahl >= 5) vorschlaege.push(`${n.anzahl} Ansichten „${n.zweck}“ in 30 Tagen nie geöffnet. Abschalten oder seltener zustellen?`);
    const l = await this.leseLesen(u);
    let hinweis: { text: string; vorschlag: Lesestil } | null = null;
    if (l.stil === 'zusammenfassung' && minuten >= 30) {
      hinweis = { text: `Etwa ${minuten} Minuten mit Zusammenfassungen in 30 Tagen. Der Stil „Entscheidung“ zeigt nur, was zu entscheiden ist; umschalten geht jederzeit zurück.`, vorschlag: 'entscheidung' };
      vorschlaege.push(hinweis.text);
    } else if (l.stil === 'entscheidung' && minuten >= 30) {
      hinweis = { text: `Etwa ${minuten} Minuten Lesezeit in 30 Tagen. Der Stil „Fokus“ zeigt nur Abweichungen und was deine Regeln melden; umschalten geht jederzeit zurück.`, vorschlag: 'fokus' };
      vorschlaege.push(hinweis.text);
    }
    return { nieGeoeffnet, vorschlaege, minutenZusammenfassung: minuten, hinweis };
  }

  /**
   * v1.3 R6: Ampel nach festen Regeln, ohne KI.
   * rot: Frist ≤ 7 Tage, Zuständigkeit des Nutzers, eigene Regel „melden“, Agentenrisiko hoch, Konflikt im Eingang.
   * gelb: Team des Nutzers betroffen, einzige Fundstelle niedrig gewichtet (Agentenbericht). grün: Rest.
   */
  ampel(
    u: User,
    objekt: {
      pfad?: string;
      vorschlagId?: string;
      punkt?: { frist?: string | null; verantwortlich?: string | null; besitzer?: string | null; sichtbarkeit?: string | null; niedrig?: boolean; risiko?: string | null; regel?: 'melden' | 'sammeln' | null; konflikt?: boolean };
    },
  ): Ampel {
    const p = { ...(objekt.punkt ?? {}) };
    if (objekt.pfad) {
      const d = this.ix.datei(objekt.pfad);
      if (d) {
        p.verantwortlich ??= d.verantwortlich;
        p.besitzer ??= d.besitzer;
        p.sichtbarkeit ??= d.sichtbarkeit;
        if (p.frist === undefined && d.pruefen_bis) p.frist = d.pruefen_bis;
      }
    }
    if (objekt.vorschlagId) {
      try {
        const sid = objekt.vorschlagId.replace(/[^\w.-]/g, '');
        const v = JSON.parse(readFileSync(join(this.dir, 'eingang', `${sid}.json`), 'utf8')) as Vorschlag;
        if (v.status === 'konflikt') p.konflikt = true;
        const k = parseMarkdown(v.art === 'loeschung' ? v.alt ?? '' : v.neu).kopf;
        p.verantwortlich ??= typeof k['verantwortlich'] === 'string' ? (k['verantwortlich'] as string) : null;
        p.sichtbarkeit ??= typeof k['sichtbarkeit'] === 'string' ? (k['sichtbarkeit'] as string) : null;
        if (v.quelle && this.ix.datei(v.quelle)?.herkunft?.startsWith('agent/')) p.niedrig = true;
      } catch {
        /* unbekannter Vorschlag: neutrale Ampel */
      }
    }
    const heute = this.heuteDatum();
    if (p.konflikt) return { farbe: 'rot', grund: 'Konflikt im Eingang: die Datei wurde seit dem Vorschlag geändert', regel: 'konflikt' };
    if (p.frist && p.frist <= plusTage(heute, 7)) return { farbe: 'rot', grund: p.frist < heute ? `Frist ${p.frist} ist vorbei` : `Frist ${p.frist} in höchstens 7 Tagen`, regel: 'frist_7_tage' };
    if ((p.verantwortlich && p.verantwortlich === u.name) || (p.besitzer && p.besitzer === u.id && p.sichtbarkeit !== 'ich')) return { farbe: 'rot', grund: 'Du bist verantwortlich', regel: 'zustaendigkeit' };
    if (p.regel === 'melden') return { farbe: 'rot', grund: 'Deine Regel sagt: melden', regel: 'eigene_regel' };
    if (p.risiko === 'hoch') return { farbe: 'rot', grund: 'Agent meldet Risiko hoch', regel: 'agent_risiko' };
    if (p.sichtbarkeit?.startsWith('team:') && u.teams.includes(p.sichtbarkeit.slice(5))) return { farbe: 'gelb', grund: `Betrifft dein Team ${p.sichtbarkeit.slice(5)}`, regel: 'team' };
    if (p.niedrig) return { farbe: 'gelb', grund: 'Einziger Beleg ist ein Agentenbericht', regel: 'niedrig_gewichtet' };
    return { farbe: 'gruen', grund: 'Keine Regel greift', regel: 'rest' };
  }

  /** Fundstelle auf eine wörtlich vorhandene Zeile einer Datei (für Ansichten). */
  private async zeilenBeleg(pfad: string, finde: (zeile: string) => boolean, abschnitt: string): Promise<Fundstelle | null> {
    const i = await this.lies(pfad);
    if (i === null) return null;
    const z = i.split(/\r?\n/);
    const n = z.findIndex(finde);
    if (n < 0) return null;
    const fs: Fundstelle = { quelle: pfad, abschnitt, zeilen: [n + 1, n + 1], zitat: kuerze(normWs(z[n]!.replace(/^\s*([-*]|\d+\.)\s+/, '').replace(/^>\s?/, '')), 300) };
    return (await this.zitatStehtDrin(fs)) ? fs : null;
  }

  private async ersteInhaltszeile(pfad: string, titel: string): Promise<Fundstelle | null> {
    const i = await this.lies(pfad);
    if (i === null) return null;
    const { kopfZeilen } = parseMarkdown(i);
    const z = i.split(/\r?\n/);
    for (let n = kopfZeilen; n < z.length; n++) {
      const t = z[n]!.trim();
      if (!t || /^#{1,6}\s/.test(t) || /^>/.test(t) || /^\|?\s*:?-{3,}/.test(t) || t.startsWith('[^')) continue;
      const fs: Fundstelle = { quelle: pfad, abschnitt: titel, zeilen: [n + 1, n + 1], zitat: kuerze(normWs(t.replace(/^\s*([-*]|\d+\.)\s+(\[[ x]\]\s+)?/, '')), 300) };
      if (fs.zitat && (await this.zitatStehtDrin(fs))) return fs;
    }
    return null;
  }

  /** Rohpunkte für Heute: deterministisch aus Index, git, Eingang und Fakten. */
  private async heutePunkte(u: User, seit: string, l: LeseEinstellungen) {
    type Roh = { schluessel: string; block: AnsichtBlock; satz: string; absatz: string | null; belege: Fundstelle[]; ampel: Ampel; ziel?: string; pflicht: boolean; regel: boolean; zu?: ZuEntscheiden };
    const roh: Roh[] = [];
    const heute = this.heuteDatum();
    const regelTrifft = (wenn: LeseRegel['wenn'], o: { gruppe?: string; gegenstand?: string; art?: string; tage?: number; risiko?: string }): 'melden' | 'sammeln' | null => {
      const r = l.regeln.find((x) => x.wenn === wenn && (!x.filter?.gruppe || x.filter.gruppe === o.gruppe) && (!x.filter?.gegenstand || (o.gegenstand ?? '').toLowerCase().includes(x.filter.gegenstand.toLowerCase())) && (!x.filter?.art || x.filter.art === o.art) && (x.filter?.tage === undefined || (o.tage ?? 9999) <= x.filter.tage));
      return r?.dann ?? null;
    };
    // Unsicher: fehlerhafte Köpfe, Konflikte
    for (const d of this.sichtbareDateien(u)) {
      if (d.fehler) roh.push({ schluessel: `fehler:${d.pfad}`, block: 'unsicher', satz: `Kopf von „${d.titel}“ ist fehlerhaft und wird mit Standardwerten gelesen.`, absatz: kuerze(d.fehler, 400), belege: [], ampel: this.ampel(u, { pfad: d.pfad, punkt: { frist: null } }), ziel: d.pfad, pflicht: d.besitzer === u.id, regel: false });
    }
    const eingang = await this.eingang(u, { alle: true });
    for (const v of eingang.filter((x) => x.status === 'konflikt')) {
      roh.push({ schluessel: `konflikt:${v.id}`, block: 'unsicher', satz: `Konflikt: ${v.ziel} wurde seit dem Vorschlag „${kuerze(v.grund, 80)}“ geändert.`, absatz: 'Bitte den neuen Vergleich ansehen und erneut entscheiden.', belege: [], ampel: this.ampel(u, { vorschlagId: v.id }), ziel: v.id, pflicht: true, regel: false });
    }
    // Entscheiden: Vorschläge, Prüftermine, ablaufende Fakten
    const darfEntscheiden = hatRolle(u, 'freigeber');
    for (const v of eingang.filter((x) => x.status === 'offen')) {
      const eigenePrivat = this.vorschlagsRechte(v).sichtbarkeit === 'ich' && this.vorschlagsRechte(v).besitzer === u.id;
      if (!darfEntscheiden && !eigenePrivat) continue;
      const beleg = await this.zeilenBeleg(`eingang/${v.id}.json`, (z) => z.trimStart().startsWith('"grund":'), `Vorschlag ${v.id}`);
      roh.push({
        schluessel: `vorschlag:${v.id}`, block: beleg ? 'entscheiden' : 'unsicher',
        satz: beleg ? `Vorschlag freigeben oder ablehnen: ${kuerze(v.grund, 120)}` : `Vorschlag ohne prüfbaren Beleg: ${kuerze(v.grund, 120)}`,
        absatz: `${v.art === 'neu' ? 'Neuer Artikel' : v.art === 'loeschung' ? 'Löschung' : 'Änderung'} ${v.ziel}${v.quelle ? `, aus ${v.quelle}` : ''}.`,
        belege: beleg ? [beleg] : [], ampel: this.ampel(u, { vorschlagId: v.id }), ziel: v.id, pflicht: true, regel: false,
        zu: { frage: `Vorschlag „${kuerze(v.grund, 100)}“ übernehmen?`, optionen: ['freigeben', 'ändern und freigeben', 'mit Begründung ablehnen'], empfehlung: 'Vergleich lesen; stimmt er mit der Quelle überein, freigeben.', begruendung_belege: [], frist: null, wenn_nichts: 'Der Vorschlag bleibt im Eingang, das Wissen bleibt unverändert.', vorschlag: v.id },
      });
    }
    for (const d of this.sichtbareDateien(u, 'wissen')) {
      if (!d.pruefen_bis || d.pruefen_bis >= heute || d.status === 'veraltet') continue;
      const zustaendig = d.verantwortlich === u.name || d.besitzer === u.id;
      const r = regelTrifft('zustaendig_fuer', { gruppe: d.gruppe });
      const beleg = await this.zeilenBeleg(d.pfad, (z) => z.startsWith('pruefen_bis:'), d.titel);
      roh.push({
        schluessel: `pruefung:${d.pfad}:${d.pruefen_bis}`, block: zustaendig && beleg ? 'entscheiden' : 'ignorieren',
        satz: `„${d.titel}“ prüfen, Prüftermin ${d.pruefen_bis} ist vorbei.`, absatz: zustaendig ? 'Du bist verantwortlich.' : `Verantwortlich: ${d.verantwortlich || 'offen'}.`,
        belege: beleg ? [beleg] : [], ampel: this.ampel(u, { pfad: d.pfad, punkt: { frist: d.pruefen_bis, regel: r } }), ziel: d.pfad, pflicht: zustaendig, regel: !!r,
        zu: { frage: `Stimmt „${d.titel}“ noch?`, optionen: ['bestätigen', 'ändern', 'als veraltet markieren'], empfehlung: 'Kurz lesen und bestätigen oder Änderung vorschlagen.', begruendung_belege: [], frist: d.pruefen_bis, wenn_nichts: 'Der Artikel bleibt als fällig markiert und wird weiter beantwortet.' },
      });
    }
    for (const f of await this.ablaufendeFakten(u)) {
      if (!f.beleg || (f.gilt_bis ?? '') < plusTage(heute, -30)) continue;
      const tage = Math.round((Date.parse(`${f.gilt_bis}T12:00:00Z`) - Date.parse(`${heute}T12:00:00Z`)) / 86400_000);
      const d = this.ix.datei(f.artikel);
      const zustaendig = d?.verantwortlich === u.name || d?.besitzer === u.id;
      const r = regelTrifft('frist_naht', { gegenstand: f.gegenstand, art: f.art, tage, ...(d?.gruppe ? { gruppe: d.gruppe } : {}) }) ?? regelTrifft('fakt_aendert', { gegenstand: f.gegenstand, art: f.art, ...(d?.gruppe ? { gruppe: d.gruppe } : {}) });
      roh.push({
        schluessel: `fakt:${f.artikel}:${f.id}:${f.gilt_bis}`, block: 'entscheiden',
        satz: `${f.gegenstand}: ${f.wert}${f.einheit ? ' ' + f.einheit : ''} gilt ${tage < 0 ? 'nur' : 'noch'} bis ${f.gilt_bis}.`, absatz: `Aus „${f.artikelTitel}“.`,
        belege: [f.beleg], ampel: this.ampel(u, { pfad: f.artikel, punkt: { frist: f.gilt_bis ?? null, regel: r, verantwortlich: d?.verantwortlich ?? null } }), ziel: f.artikel,
        pflicht: zustaendig && tage <= 7, regel: !!r,
        zu: { frage: `Was gilt für „${f.gegenstand}“ nach dem ${f.gilt_bis}?`, optionen: ['verlängern', 'neuen Wert mit Quelle vorschlagen', 'auslaufen lassen'], empfehlung: 'Neuen Wert mit Quelle vorschlagen, falls er bekannt ist.', begruendung_belege: [], frist: f.gilt_bis ?? null, wenn_nichts: 'Nach dem Datum beantwortet Kern die Frage nicht mehr aus der Faktenschicht.' },
      });
    }
    // Was sich ändert: git seit Datum
    const commits = await this.git.log({ seit: `${seit}T00:00:00` });
    const gesehen = new Set<string>();
    for (const c of commits) {
      for (const p of c.dateien ?? []) {
        if (!/^(wissen|quellen)\//.test(p) || istReserviert(p) || !p.endsWith('.md') || p.includes('.orig.') || gesehen.has(p)) continue;
        const d = this.ix.datei(p);
        if (!d || !darfSehen(u, d.sichtbarkeit, d.besitzer)) continue;
        gesehen.add(p);
        if (gesehen.size > 40) break;
        const eigen = c.von === u.name;
        const r = d.art === 'quelle' ? regelTrifft('neue_quelle', { gruppe: d.sammlung }) : regelTrifft('artikel_aendert', { gruppe: d.gruppe });
        const beleg = await this.ersteInhaltszeile(p, d.titel);
        const kurz = d.art === 'wissen' ? String(parseMarkdown((await this.lies(p)) ?? '').kopf['kurzfassung'] ?? '') : '';
        roh.push({
          schluessel: `aenderung:${p}:${c.commit}`, block: eigen || !beleg ? 'ignorieren' : 'aendert_sich',
          satz: `${d.art === 'quelle' ? 'Quelle' : 'Artikel'} „${kuerze(d.titel, 80)}“: ${kuerze(c.grund, 80)} (${c.von}, ${c.am.slice(0, 10)}).`,
          absatz: kurz ? kuerze(kurz, 400) : null, belege: beleg ? [beleg] : [], ampel: this.ampel(u, { pfad: p, punkt: { frist: null, regel: r } }), ziel: p,
          pflicht: false, regel: !!r,
        });
      }
    }
    return roh;
  }

  private async alleAnsichtsKoepfe(): Promise<Ansicht[]> {
    const out: Ansicht[] = [];
    let tage: string[] = [];
    try {
      tage = (await readdir(join(this.dir, 'ansichten'))).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    } catch {
      return out;
    }
    for (const t of tage) {
      for (const n of (await readdir(join(this.dir, 'ansichten', t))).filter((x) => x.endsWith('.md')).sort()) {
        const pfad = `ansichten/${t}/${n}`;
        const p = parseMarkdown((await this.lies(pfad)) ?? '');
        if (p.kopf['type'] === 'Ansicht') out.push({ pfad, kopf: p.kopf as unknown as AnsichtKopf, text: p.text.replace(/^\n+/, '') });
      }
    }
    return out;
  }

  private ansichtStatus(a: Ansicht, heute: string): Promise<AnsichtKopf['status']> {
    return (async () => {
      if (a.kopf.gilt_bis < heute) return 'abgelaufen';
      for (const b of a.kopf.basis ?? []) {
        const i = await this.lies(b.pfad);
        if (i === null || sha256(i) !== b.hash) return 'basis_geaendert';
      }
      return 'aktuell';
    })();
  }

  /** Ansicht speichern (ansichten/<datum>/<id>.md, in git, nie indiziert). Gleicher Inhalt ⇒ gleiche id, kein neuer Commit. */
  private async speichereAnsicht(
    u: User,
    a: { zweck: AnsichtZweck; titel: string; stil?: Lesestil; gilt_bis: string; punkte: AnsichtPunkt[]; fundstellen: AnsichtFundstelle[]; zu_entscheiden?: ZuEntscheiden[]; wpm: number; ki?: boolean },
    text: string,
    vorgaenger: string | null,
  ): Promise<Ansicht> {
    const datum = this.heuteDatum();
    for (const f of a.fundstellen) if (f.quelle.startsWith('ansichten/') || f.quelle.startsWith('pruefung/')) throw new KernFehler('rueckkopplung', `Ansichten stützen sich nie auf Ansichten (${f.quelle})`);
    const basisPfade = [...new Set(a.fundstellen.map((f) => f.quelle))].sort();
    const basis: { pfad: string; hash: string }[] = [];
    for (const p of basisPfade) basis.push({ pfad: p, hash: sha256((await this.lies(p)) ?? '') });
    const inhaltHash = sha256(JSON.stringify([u.id, a.zweck, a.stil ?? '', a.punkte.map((p) => [p.id, p.block, p.satz]), basis]));
    const id = `a-${datum}-${inhaltHash.slice(0, 8)}`;
    const pfad = `ansichten/${datum}/${id}.md`;
    const vorhanden = await this.lies(pfad);
    if (vorhanden) {
      const p = parseMarkdown(vorhanden);
      return { pfad, kopf: p.kopf as unknown as AnsichtKopf, text: p.text.replace(/^\n+/, '') };
    }
    const woerter = wortAnzahl(text);
    const letzter = (await this.git.log({ max: 1 }))[0];
    const { wpm, ki, ...rest } = a;
    const kopf: AnsichtKopf = {
      type: 'Ansicht', id, ...rest, fuer: u.id,
      generated: { by: `agent/${slugify(this.produkt)}-0.1+${this.provider.name}`, at: this.jetzt() },
      basis, basis_stand: letzter?.am ?? null, lesezeit_min: Math.max(1, Math.ceil(woerter / wpm)), status: 'aktuell', vorgaenger,
      ki_erzeugt: !!ki, modell: ki ? this.modellInfo() : null,
    };
    const geordnet: Record<string, unknown> = {};
    for (const k of ['type', 'id', 'zweck', 'fuer', 'titel', 'stil', 'generated', 'gilt_bis', 'basis', 'basis_stand', 'lesezeit_min', 'status', 'vorgaenger', 'ki_erzeugt', 'modell', 'zu_entscheiden', 'punkte', 'fundstellen']) if (kopf[k] !== undefined) geordnet[k] = kopf[k];
    await this.sperre.run(async () => {
      await this.schreibeDateien([{ pfad, inhalt: stringifyMarkdown(geordnet, text) }]);
      await this.git.commit([pfad], u.name, `Ansicht: ${a.titel}`);
    });
    return { pfad, kopf, text };
  }

  /** Text einer Ansicht in den festen Blöcken (Unsicher zuerst). */
  private ansichtText(titel: string, punkte: AnsichtPunkt[], fund: AnsichtFundstelle[], zahlIgnorieren: number, extra: { einleitung?: string; zu?: ZuEntscheiden[]; zurueck?: number } = {}): string {
    const zeile = (p: AnsichtPunkt) => `- [${p.id}] ${p.satz}${p.ampel.farbe !== 'gruen' ? ` {ampel: ${p.ampel.farbe}, grund: "${p.ampel.grund}"}` : ''}${p.belege.map((b) => ` [^${b}]`).join('')}`;
    const teile = [`# ${titel}`, ''];
    if (extra.einleitung) teile.push(extra.einleitung, '');
    const block = (name: string, b: AnsichtBlock, leer: string) => {
      const ps = punkte.filter((p) => p.block === b);
      teile.push(`## ${name}`, '', ...(ps.length ? ps.map(zeile) : [leer]), '');
    };
    block('Unsicher oder fehlgeschlagen', 'unsicher', '- keine');
    if (extra.zu?.length) {
      teile.push('## Zu entscheiden', '');
      extra.zu.forEach((z, i) => teile.push(`${i + 1}. ${z.frage} **Empfehlung:** ${z.empfehlung}${z.frist ? ` **Frist:** ${z.frist}` : ''} **Wenn nichts passiert:** ${z.wenn_nichts}`));
      teile.push('');
    } else block('Zu entscheiden', 'entscheiden', '- nichts');
    block('Was sich für dich ändert', 'aendert_sich', '- nichts Neues');
    teile.push('## Darfst du ignorieren', '', `- ${zahlIgnorieren} Punkte (eigene Änderungen, Zuständigkeit anderer).`, '');
    if (extra.zurueck) teile.push(`Für morgen zurückgelegt: ${extra.zurueck} Punkte.`, '');
    if (fund.length) teile.push(...fund.map((f) => `[^${f.id}]: ${f.quelle}, Zeilen ${f.zeilen[0]}–${f.zeilen[1]}: „${f.zitat}“`), '');
    return teile.join('\n');
  }

  /**
   * v1.3 / v1.3.1: Heute für den Nutzer im gewählten Lesestil (Standard `zusammenfassung`).
   * Andere Formen jederzeit über `opt.stil`. Lesebudget optional (weich), hart nur auf eigenen Wunsch oder im Stil `fokus`.
   */
  async heute(u: User, opt: { stil?: Lesestil; seit?: string } = {}): Promise<Heute> {
    const l = await this.leseLesen(u);
    const stil = opt.stil ?? l.stil;
    const datum = this.heuteDatum();
    // „nur Abweichungen“ bezieht sich auf die zuletzt gelesene Ansicht desselben Stils
    const vorher = (await this.alleAnsichtsKoepfe()).filter((a) => a.kopf.fuer === u.id && a.kopf.stil === stil && this.lesen.geoeffnet(u.id, a.kopf.id)).at(-1) ?? null;
    const seit = opt.seit && /^\d{4}-\d{2}-\d{2}/.test(opt.seit) ? opt.seit.slice(0, 10) : plusTage(datum, -7);
    const roh = await this.heutePunkte(u, seit, l);
    const alteSchluessel = new Set((vorher?.kopf.punkte ?? []).map((p) => p.id));
    const rang = { rot: 0, gelb: 1, gruen: 2 } as const;
    const blockRang = { unsicher: 0, entscheiden: 1, aendert_sich: 2, ignorieren: 3 } as const;
    let liste = roh
      .map((r) => ({ ...r, id: `P-${sha256(r.schluessel).slice(0, 8)}` }))
      .sort((a, b) => blockRang[a.block] - blockRang[b.block] || rang[a.ampel.farbe] - rang[b.ampel.farbe] || a.satz.localeCompare(b.satz, 'de'));
    const nurAbw = stil === 'fokus' || l.nur_abweichungen;
    if (stil === 'fokus') liste = liste.filter((p) => p.block === 'unsicher' || p.pflicht || p.regel || p.block === 'ignorieren');
    if (nurAbw && vorher) liste = liste.filter((p) => p.block === 'unsicher' || p.block === 'ignorieren' || !alteSchluessel.has(p.id));
    const ignorieren = liste.filter((p) => p.block === 'ignorieren').length;
    let sichtbar = liste.filter((p) => p.block !== 'ignorieren');
    // Lesebudget
    const budgetAn = stil === 'fokus' || l.lesebudget_an;
    const hart = budgetAn && (stil === 'fokus' || l.lesebudget_hart);
    const woerterBudget = l.lesebudget_min_tag * l.woerter_pro_minute;
    let benutzt = 0;
    let zurueck = 0;
    const passend: typeof sichtbar = [];
    for (const p of sichtbar) {
      const w = wortAnzahl(p.satz) + 2;
      if (hart && benutzt + w > woerterBudget) {
        zurueck++;
        continue;
      }
      benutzt += w;
      passend.push(p);
    }
    sichtbar = passend;
    // Fundstellen-ids vergeben
    const fund: AnsichtFundstelle[] = [];
    const punkte: AnsichtPunkt[] = sichtbar.map((p) => {
      const ids = p.belege.map((b) => {
        const vorhanden = fund.find((f) => f.quelle === b.quelle && f.zeilen[0] === b.zeilen[0] && f.zeilen[1] === b.zeilen[1]);
        if (vorhanden) return vorhanden.id;
        const id = `b${fund.length + 1}`;
        fund.push({ id, ...b });
        return id;
      });
      return { id: p.id, block: p.block, satz: p.satz, absatz: p.absatz, belege: ids, ampel: p.ampel, neu_seit: vorher && alteSchluessel.has(p.id) ? null : vorher?.kopf.id ?? 'neu', ...(p.ziel ? { ziel: p.ziel } : {}) };
    });
    const zu = stil === 'entscheidung' ? sichtbar.filter((p) => p.block === 'entscheiden' && p.zu).slice(0, 3).map((p) => ({ ...p.zu!, begruendung_belege: punkte.find((x) => x.id === p.id)?.belege ?? [] })) : undefined;
    const zahlen = { unsicher: 0, entscheiden: 0, aendert_sich: 0, ignorieren } as Record<AnsichtBlock, number>;
    for (const p of punkte) if (p.block !== 'ignorieren') zahlen[p.block]++;
    const titel = stil === 'entscheidung' ? `Entscheidungsvorlage ${datum}` : stil === 'fokus' ? `Fokus ${datum}` : `Zusammenfassung ${datum}`;
    const einleitung =
      stil === 'zusammenfassung'
        ? `Seit ${seit}: ${zahlen.aendert_sich} Änderungen für dich, ${zahlen.entscheiden} Punkte zu entscheiden, ${zahlen.unsicher} unsicher. ${ignorieren} weitere Punkte darfst du ignorieren.`
        : undefined;
    const text = this.ansichtText(titel, punkte, fund, ignorieren, { ...(einleitung ? { einleitung } : {}), ...(zu ? { zu } : {}), ...(zurueck ? { zurueck } : {}) });
    const ansicht = await this.speichereAnsicht(
      u,
      { zweck: stil === 'entscheidung' ? 'entscheidungsvorlage' : 'briefing', titel, stil, gilt_bis: plusTage(datum, 1), punkte, fundstellen: fund, ...(zu ? { zu_entscheiden: zu } : {}), wpm: l.woerter_pro_minute },
      text,
      vorher?.kopf.id ?? null,
    );
    // v1.3.1: sanfter Hinweis höchstens alle 7 Tage, nur für den Nutzer selbst
    let hinweis: string | null = null;
    if (stil !== 'fokus') {
      const woche = `hinweis:stil:${Math.floor(Date.parse(`${datum}T12:00:00Z`) / (7 * 86400_000))}`;
      const bilanz = await this.lesebilanz(u);
      if (bilanz.hinweis && !this.lesen.geoeffnet(u.id, woche)) {
        hinweis = bilanz.hinweis.text;
        this.lesen.merke(u.id, woche, '', 1, this.jetzt());
      }
    }
    if (budgetAn && !hart && benutzt > woerterBudget) hinweis = `Heute sind es etwa ${Math.ceil(benutzt / l.woerter_pro_minute)} Minuten, dein Budget sind ${l.lesebudget_min_tag}. ${hinweis ?? ''}`.trim();
    const aufgeloest = ansicht.kopf.punkte.filter((p) => p.block !== 'ignorieren').map((p) => ({ ...p, belege: p.belege.map((id) => ansicht.kopf.fundstellen.find((f) => f.id === id)).filter((f): f is AnsichtFundstelle => !!f) }));
    const neu = ansicht.kopf.punkte.filter((p) => p.neu_seit !== null && p.block !== 'ignorieren');
    const abweichungen = vorher
      ? this.ansichtText(`Nur Abweichungen seit ${vorher.kopf.generated.at.slice(0, 10)}`, neu, ansicht.kopf.fundstellen.filter((f) => neu.some((p) => p.belege.includes(f.id))), ignorieren)
      : this.ansichtText('Nur Abweichungen', neu, ansicht.kopf.fundstellen, ignorieren, { einleitung: 'Noch keine gelesene Fassung zum Vergleich, daher ist alles neu.' });
    return {
      datum, stil, ansicht, andere_stile: LESESTILE.filter((s) => s !== stil),
      budget: { an: budgetAn, hart, minuten: l.lesebudget_min_tag, woerter_pro_minute: l.woerter_pro_minute, woerter: woerterBudget, benutzt_woerter: benutzt, zurueckgestellt: zurueck, ueberschritten: budgetAn && benutzt > woerterBudget },
      zahlen, hinweis,
      punkte: aufgeloest, ignorieren_anzahl: ignorieren, zurueckgestellt: zurueck,
      zusammenfassung: ansicht.text, abweichungen,
      ...(zu ? { zu_entscheiden: zu } : {}),
    };
  }

  /**
   * v1.3: Ansicht erzeugen. `briefing`/`entscheidungsvorlage` wie `heute()`; `thema`/`vertretung`/`antwort` per KI aus
   * Abschnitten (pfade oder Suche), jeder Punkt außerhalb „Unsicher“ mit wörtlich geprüftem Beleg. Basis nie unter ansichten/ (R1).
   */
  async ansicht(u: User, anfrage: { zweck: AnsichtZweck; thema?: string; pfade?: string[]; seit?: string; vorschlagIds?: string[] }): Promise<Ansicht> {
    for (const p of anfrage.pfade ?? []) if (sichererPfad(p).startsWith('ansichten/') || p.startsWith('pruefung/')) throw new KernFehler('rueckkopplung', `Keine Ansicht aus Ansichten (${p})`);
    if (anfrage.zweck === 'briefing') return (await this.heute(u, { stil: 'zusammenfassung', ...(anfrage.seit ? { seit: anfrage.seit } : {}) })).ansicht;
    if (anfrage.zweck === 'entscheidungsvorlage') return (await this.heute(u, { stil: 'entscheidung', ...(anfrage.seit ? { seit: anfrage.seit } : {}) })).ansicht;
    if (anfrage.zweck === 'agentenbericht') throw new KernFehler('ungueltig', 'Agentenberichte entstehen über berichte()');
    const l = await this.leseLesen(u);
    let treffer: RohTreffer[] = [];
    if (anfrage.pfade?.length) {
      for (const p of anfrage.pfade) {
        const d = this.ix.datei(sichererPfad(p));
        if (!d || !darfSehen(u, d.sichtbarkeit, d.besitzer)) throw new KernFehler('nicht_gefunden', `${p} nicht gefunden`);
        treffer.push(...this.ix.abschnitteVon(d.pfad).slice(0, 8).map((a) => ({ ...a, art: d.art, titel: d.titel, score: 0 })));
      }
      treffer = treffer.slice(0, 12);
    } else if (anfrage.thema?.trim()) treffer = await this.rohSuche(u, anfrage.thema, { limit: 8 });
    else throw new KernFehler('ungueltig', 'thema oder pfade angeben');
    const system = [
      'AUFGABE: ANSICHT',
      `Fasse für ${u.name} zusammen, ausschließlich aus den nummerierten Abschnitten. Jeder Punkt: ein Satz (höchstens 25 Wörter), optional ein Absatz (höchstens 80 Wörter), Belegnummern und ein wörtliches Zitat.`,
      'Blöcke: "unsicher" (Unsicheres, Widersprüche, Lücken), "entscheiden", "aendert_sich", "ignorieren".',
      'Melde Unsicherheit und Fehler ausdrücklich im Block Unsicher.',
      DATEN_REGEL,
      'Format (nur JSON): {"punkte":[{"block":"aendert_sich","satz":"…","absatz":null,"belege":[1],"zitat":"…"}]}',
    ].join('\n');
    const nonceA = randomBytes(4).toString('hex');
    const user = `=== THEMA\n${anfrage.thema ?? (anfrage.pfade ?? []).join(', ')}\n=== ABSCHNITTE\n${treffer.map((t, i) => datenBlock(i + 1, `${t.titel} › ${t.abschnitt} (${t.pfad}, Zeilen ${t.von}–${t.bis})`, t.text, nonceA)).join('\n\n')}`;
    const schema = z.object({ punkte: z.array(z.object({ block: z.enum(['unsicher', 'entscheiden', 'aendert_sich', 'ignorieren']).catch('aendert_sich'), satz: z.string().min(1), absatz: z.string().nullable().optional(), belege: z.array(z.coerce.number().int()).default([]), zitat: z.string().optional() })).default([]) });
    let modell: z.infer<typeof schema> = { punkte: [] };
    let fehler: string | null = null;
    try {
      modell = schema.parse(extrahiereJson(await this.provider.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true })));
    } catch (e) {
      fehler = (e as Error).message;
    }
    const fund: AnsichtFundstelle[] = [];
    const punkte: AnsichtPunkt[] = [];
    let n = 0;
    for (const p of modell.punkte.slice(0, 20)) {
      const ids: string[] = [];
      for (const [k, nr] of [...new Set(p.belege)].filter((x) => x >= 1 && x <= treffer.length).entries()) {
        const fs = await this.zitatFundstelle(treffer[nr - 1]!, k === 0 ? p.zitat : undefined, p.satz);
        if (!fs || !(await this.zitatStehtDrin(fs))) continue;
        const vorhanden = fund.find((f) => f.quelle === fs.quelle && f.zeilen[0] === fs.zeilen[0] && f.zeilen[1] === fs.zeilen[1]);
        const id = vorhanden?.id ?? `b${fund.length + 1}`;
        if (!vorhanden) fund.push({ id, ...fs });
        ids.push(id);
      }
      if (!ids.length && p.block !== 'unsicher') continue; // ohne geprüften Beleg verworfen
      n++;
      const satz = p.satz.split(/\s+/).slice(0, 25).join(' ');
      const absatz = p.absatz ? p.absatz.split(/\s+/).slice(0, 80).join(' ') : null;
      const quelle = ids.length ? fund.find((f) => f.id === ids[0])!.quelle : undefined;
      punkte.push({ id: `P${n}`, block: p.block, satz, absatz, belege: ids, ampel: this.ampel(u, quelle ? { pfad: quelle } : {}), neu_seit: 'neu' });
    }
    if (fehler) punkte.unshift({ id: 'P0', block: 'unsicher', satz: 'Die KI-Antwort war nicht verwendbar; diese Ansicht ist unvollständig.', absatz: kuerze(fehler, 300), belege: [], ampel: { farbe: 'gelb', grund: 'KI-Antwort fehlerhaft', regel: 'ki_fehler' }, neu_seit: 'neu' });
    if (!treffer.length) punkte.unshift({ id: 'P0', block: 'unsicher', satz: 'Zu diesem Thema steht nichts im Wissensordner.', absatz: null, belege: [], ampel: { farbe: 'gruen', grund: 'Keine Regel greift', regel: 'rest' }, neu_seit: 'neu' });
    const titel = anfrage.zweck === 'vertretung' ? `Vertretung: ${anfrage.thema ?? ''}`.trim() : anfrage.zweck === 'antwort' ? `Antwort: ${anfrage.thema ?? ''}`.trim() : `Thema: ${anfrage.thema ?? (anfrage.pfade ?? []).join(', ')}`;
    const ign = punkte.filter((p) => p.block === 'ignorieren').length;
    const text = this.ansichtText(titel, punkte.filter((p) => p.block !== 'ignorieren'), fund, ign);
    return this.speichereAnsicht(u, { zweck: anfrage.zweck, titel, stil: l.stil, gilt_bis: plusTage(this.heuteDatum(), 14), punkte, fundstellen: fund, wpm: l.woerter_pro_minute, ki: true }, text, null);
  }

  /** v1.3: eigene Ansichten auflisten. */
  async ansichten(u: User, filter: { zweck?: AnsichtZweck; aktuell?: boolean } = {}): Promise<AnsichtKurz[]> {
    const heute = this.heuteDatum();
    const out: AnsichtKurz[] = [];
    for (const a of await this.alleAnsichtsKoepfe()) {
      if (a.kopf.fuer !== u.id || (filter.zweck && a.kopf.zweck !== filter.zweck)) continue;
      const status = await this.ansichtStatus(a, heute);
      if (filter.aktuell && status !== 'aktuell') continue;
      out.push({ id: a.kopf.id, zweck: a.kopf.zweck, titel: a.kopf.titel, gilt_bis: a.kopf.gilt_bis, status, lesezeit_min: a.kopf.lesezeit_min, erstellt: a.kopf.generated.at });
    }
    return out.reverse();
  }

  /** v1.3: Ansicht lesen; prüft Ablauf und Basis-Hashes (Status `abgelaufen` bzw. `basis_geaendert`). */
  async leseAnsicht(u: User, id: string): Promise<Ansicht> {
    const a = (await this.alleAnsichtsKoepfe()).find((x) => x.kopf.id === id && x.kopf.fuer === u.id);
    if (!a) throw new KernFehler('nicht_gefunden', `Ansicht ${id} nicht gefunden`);
    a.kopf.status = await this.ansichtStatus(a, this.heuteDatum());
    return a;
  }

  /** v1.3: Ansicht verwerfen (Datei löschen, Commit „Ansicht verworfen“). */
  async verwerfeAnsicht(u: User, id: string): Promise<void> {
    const a = await this.leseAnsicht(u, id);
    await this.sperre.run(async () => {
      await this.schreibeDateien([{ pfad: a.pfad, inhalt: null }]);
      await this.git.commit([a.pfad], u.name, 'Ansicht verworfen');
    });
  }

  /* ================================================================ */
  /* Einstellungen, Ende                                               */
  /* ================================================================ */

  /**
   * Ohne Benutzer: kern.yaml (Betrieb, ohne Schlüssel). Mit Benutzer (v1.3): dessen Leseeinstellungen aus
   * nutzer/<id>/lesen.yaml (Standard-Stil aus kern.yaml `standard_lesestil`, sonst `zusammenfassung`).
   */
  leseEinstellungen(): Promise<Einstellungen>;
  leseEinstellungen(u: User): Promise<LeseEinstellungen>;
  leseEinstellungen(u?: User): Promise<Einstellungen | LeseEinstellungen> {
    return u ? this.leseLesen(u) : this.leseBetriebsEinstellungen();
  }

  private async leseBetriebsEinstellungen(): Promise<Einstellungen> {
    const roh = (YAML.parse((await this.lies('kern.yaml')) ?? '') ?? {}) as Partial<Einstellungen>;
    const e: Einstellungen = {
      ...roh,
      betrieb: roh.betrieb ?? this.cfg.betrieb,
      sprache: roh.sprache ?? this.cfg.sprache,
      ki: roh.ki ?? ohneGeheimnisse(this.cfg.provider),
      teams: roh.teams ?? [],
      standard_sichtbarkeit: roh.standard_sichtbarkeit ?? 'betrieb',
      regelpruefung_ki: roh.regelpruefung_ki ?? true,
    };
    this.einstellungenSync = e;
    return e;
  }

  /** Erweiterung: kern.yaml ändern (nur admin). Ein neuer KI-Anbieter gilt nach erneutem `Kern.open`. */
  async speichereEinstellungen(u: User, aenderung: Partial<Einstellungen>): Promise<Einstellungen> {
    brauchtRolle(u, 'admin', 'Einstellungen ändern');
    if (aenderung['standard_lesestil'] !== undefined && !LESESTILE.includes(aenderung['standard_lesestil'] as Lesestil)) throw new KernFehler('ungueltig', `standard_lesestil: ${LESESTILE.join(' | ')}`);
    const alt = await this.leseBetriebsEinstellungen();
    const neu: Einstellungen = { ...alt, ...aenderung };
    if (neu.ki && typeof neu.ki === 'object' && 'apiKey' in neu.ki) neu.ki = { ...neu.ki, apiKey: '' };
    await this.sperre.run(() => this.schreibeUndCommitte([{ pfad: 'kern.yaml', inhalt: YAML.stringify(neu) }], u.name, 'Einstellungen geändert'));
    this.einstellungenSync = neu;
    return neu;
  }

  /** Erweiterung: Datenbank und Beobachter schließen. */
  async schliesse(): Promise<void> {
    await this.sperre.run(async () => {
      if (this.watcher) await this.watcher.close();
      this.watcher = null;
      this.ix.schliessen();
      this.lesenDb?.schliessen();
      this.lesenDb = null;
      this.zugang.schliessen();
      this.zaehler.schliessen();
    });
  }

  /** Erweiterung: Kurzinfo für Status-Anzeigen (z. B. Hinweis „mock“ im UI). */
  status(): { produkt: string; betrieb: string; provider: string; mock: boolean; vektor: 'sqlite-vec' | 'js'; dateien: number; abschnitte: number } {
    return {
      produkt: this.produkt,
      betrieb: this.cfg.betrieb,
      provider: this.provider.name,
      mock: this.provider.name === 'mock',
      vektor: this.ix.vecAktiv ? 'sqlite-vec' : 'js',
      dateien: this.ix.dateien().length,
      abschnitte: this.ix.anzahlAbschnitte(),
    };
  }

  /** Erweiterung: Rollen-Check für Server. */
  static hatRolle(u: User, r: Rolle): boolean {
    return hatRolle(u, r);
  }

  /* ================================================================ */
  /* v1.4 8.1 bis 8.5 und 9 (E1/E2): Prüfbank, Kontextbilanz,          */
  /* Kontextpaket, Agentenprofile, Gedächtnis-Adapter                  */
  /* ================================================================ */

  /** v1.4 8.1: Prüfbank-Lauf (admin) in einer Temp-Kopie; Ergebnis unter pruefung/laeufe/ (git), Vergleich in pruefung/vergleich.md. */
  pruefbank(u: User, opt: PruefbankOptionen): Promise<PruefbankLauf> {
    return pruefbankIntern(this, u, opt);
  }
  /** v1.4 8.1: alle Läufe, neueste zuerst (admin). */
  pruefbankLaeufe(u: User): Promise<PruefbankLauf[]> {
    return pruefbankLaeufeIntern(this, u);
  }
  /** v1.4 8.1: geschätzte Kosten vor dem Start (Fragen, Tokens [Schätzung], Cent oder null ohne Preis). */
  pruefbankSchaetzung(u: User, opt: { satz: PruefbankSatz; anbieter?: ProviderConfig }): Promise<{ fragen: number; tokens: number; cent: number | null }> {
    return pruefbankSchaetzungIntern(this, u, opt);
  }
  /** v1.4 8.1: „Als Prüffrage speichern“ (freigeber), schreibt pruefung/fragen.yaml mit Commit. */
  speicherePrueffrage(u: User, f: Omit<PrueffrageEingabe, 'id'> & { id?: string }): Promise<{ id: string }> {
    return speicherePrueffrageIntern(this, u, f);
  }
  /** v1.4 8.2: Prüfstatus der aktiven KI aus kern.yaml (`ki.status`), Standard `ungeprueft` außer bei mock. */
  async kiStatus(): Promise<KiStatus> {
    const ki = (await this.leseBetriebsEinstellungen()).ki as { status?: KiStatus; art?: string };
    return ki?.status ?? (this.cfg.provider.art === 'mock' ? 'geprueft' : 'ungeprueft');
  }
  /** v1.4 9: Kontextbilanz (freigeber, admin), nur Zahlen aus Dateien, git, Eingang und Zählern. */
  kontextbilanz(u: User): Promise<Kontextbilanz> {
    return kontextbilanzIntern(this, u);
  }
  /** v1.4 8.3: Kontextpaket mit Budget für ein fremdes Modell oder einen Agenten. */
  kontextpaket(u: User, a: KontextpaketAnfrage): Promise<Kontextpaket> {
    return kontextpaketIntern(this, u, a);
  }
  /** v1.4 8.5: Befehl des Claude-Memory-Tools auf /memories (wissen nur als Vorschlag, notizen direkt). */
  gedaechtnis(u: User, befehl: GedaechtnisBefehl, opt: { agent?: string; reichweite?: 'ich' | 'team' | 'betrieb' | null } = {}): Promise<GedaechtnisErgebnis> {
    return gedaechtnisIntern(this, u, befehl, opt);
  }
  /** v1.4 8.5: abgelaufene Agenten-Notizen (notizen.ablauf_tage) als Löschvorschläge melden; gibt die Pfade zurück. */
  notizenAblauf(u: User): Promise<string[]> {
    return notizenAblaufIntern(this, u);
  }

  /** @internal Zugriff für die v1.4-Module in diesem Paket. */
  get _intern() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const k = this;
    return {
      lies: (p: string) => k.lies(p),
      sichtbar: (u: User, art?: 'wissen' | 'quelle', r?: Reichweite) => k.sichtbareDateien(u, art, r),
      rohSuche: (u: User, q: string, opt: { reichweite?: Reichweite; sammlung?: string; limit?: number; art?: 'wissen' | 'quelle' }) => k.rohSuche(u, q, opt),
      heute: () => k.heuteDatum(),
      jetzt: () => k.jetzt(),
      einstellungen: () => k.leseBetriebsEinstellungen(),
      offeneVorschlaege: () => k.offeneVorschlaege(),
      legeVorschlagAn: (u: User, v: { art: Vorschlag['art']; ziel: string; alt: string | null; neu: string; grund: string; quelle?: string }, von?: string) => k.legeVorschlagAn(u, v, von),
      schreibeCommit: (dateien: Aenderung[], autor: string, grund: string, text?: string) =>
        k.sperre.run(async () => {
          await k.schreibeDateien(dateien);
          return k.git.commit(dateien.map((d) => d.pfad), autor, grund, text);
        }),
      zitatAusZeilen: (q: string, von: number, bis: number) => k.zitatAusZeilen(q, von, bis),
      providerInstanz: (k.cfg as { providerInstanz?: Provider }).providerInstanz ?? null,
      kiPreis: () => k.kiPreis(),
      abs: (p: string) => k.abs(p),
      profil: () => k.inner.profil ?? null,
    };
  }
}

/* ------------------------------------------------------------------ */

/** v1.4.1 U10: angehängter Teil eines Nachtrags (Rumpf ohne Kopf), oder null, wenn neu nicht mit alt beginnt. */
function nachtragsAnhang(alt: string, neu: string): string | null {
  const a = parseMarkdown(alt).text.trimEnd();
  const n = parseMarkdown(neu).text;
  return n.startsWith(a) ? n.slice(a.length) : null;
}

export function erzeugeDiff(pfad: string, alt: string, neu: string): string {
  return createTwoFilesPatch(alt ? `a/${pfad}` : '/dev/null', neu ? `b/${pfad}` : '/dev/null', alt, neu, '', '', { context: 3 });
}

function ausschnitt(text: string, q: string): string {
  const flach = text.replace(/\s+/g, ' ').trim();
  if (flach.length <= 300) return flach;
  const w = q.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const low = flach.toLowerCase();
  let pos = -1;
  for (const x of w) {
    pos = low.indexOf(x.slice(0, Math.max(4, x.length - 2)));
    if (pos >= 0) break;
  }
  const start = Math.max(0, pos < 0 ? 0 : pos - 80);
  return `${start > 0 ? '… ' : ''}${flach.slice(start, start + 300).trim()}${start + 300 < flach.length ? ' …' : ''}`;
}

/** Fußnoten `[^id]` anhängen (OKF: Belege je Aussage). */
function mitFussnoten(text: string, ids: string[], fund: ArtikelFundstelle[]): string {
  const neu = ids.filter((id) => !new RegExp(`^\\[\\^${id}\\]:`, 'm').test(text));
  if (!neu.length) return text;
  const verweise = neu.map((id) => `[^${id}]`).join('');
  const defs = neu.map((id) => {
    const f = fund.find((x) => x.id === id)!;
    return `[^${id}]: ${f.quelle}, „${f.abschnitt}“, Zeilen ${f.zeilen[0]}–${f.zeilen[1]}`;
  });
  return `${text.trimEnd()} ${verweise}\n\n${defs.join('\n')}\n`;
}

export { normalisiereFundstellen, type Abschnitt };
