/**
 * Leitstand: einziger Weg, Kunden und Instanzen zu ändern (O1 1.1). Konsole, /v1-API, Mollie-Webhook, CLI und Planer
 * rufen alle diese Klasse. Jede ändernde Methode schreibt ins Prüfprotokoll.
 */
import crypto from 'node:crypto';
import type { DB } from './db.js';
import type { Bereitsteller } from './bereitsteller/typ.js';
import { nurBetriebsdaten } from './bereitsteller/typ.js';
import type { MollieClient } from './mollie.js';
import { centAus } from './mollie.js';
import {
  auslastungStufe, passtAufHost, stufeFuer, testSperre, testEnde, naechsteNacht,
  FRISTEN, loeschDatum, normalisiereCode, normalisiereSubdomain, planerAbsicht, plusTage, provisionCent, pruefeSubdomain, pruefeWechsel, startStatus, tageBis,
} from './regeln.js';
import type {
  Abo, Auszahlungszeile, Beispiel, Ereignis, Herkunft, Host, HostLast, Instanz, Stufe, InstanzStatus, KiVorlage, Kunde, KontoTyp, Loeschbeleg, Paket, Partner, Region, Vorgang, Zahlung,
} from './typen.js';
import { BEISPIELE, KI_VORLAGEN, KONTO_TYPEN, LeitstandFehler, PAKETE, REGIONEN, STUFEN } from './typen.js';
import type { Wechselauftrag } from './bereitsteller/typ.js';
import { grenzenFuer, PAKETE_STANDARD, preisCent, SCHALTER_STANDARD, type PaketWerte, type Schalter } from './schalter.js';

/** Rechnungswerkzeug (v1.4 3.6): je erfolgreicher Zahlung ein Entwurf aus festen Katalogpositionen. */
export interface RechnungsTool {
  entwurf(e: { kunde: Kunde; zahlung_id: string; betrag_cent: number; position: string; festschreiben: boolean }): Promise<{ id: string; link?: string }>;
}

export interface LeitstandOptionen {
  db: DB;
  bereitsteller: Bereitsteller;
  mollie?: MollieClient;
  jetzt?: () => Date;
  domain?: string;
  /** Link-Muster ins Rechnungswerkzeug, `{ref}` wird ersetzt. */
  rechnungLink?: string;
  /** Geteilte Hosts, die beim Start angelegt werden, falls noch nicht vorhanden. */
  geteilteHosts?: Omit<Host, 'erstellt' | 'stufe'>[];
  /** Startwerte für Schalter (sonst Standard aus v1.4 Abschnitt 16); gespeicherte Werte gehen vor. */
  schalter?: Partial<Schalter>;
  rechnungen?: RechnungsTool;
  /** Öffentliche Adresse des Leitstands für Mollie-Redirect und Bestätigungslinks. */
  oeffentlicheUrl?: string;
}

export interface InstanzEingabe {
  kunde_id?: string | null;
  kunde?: Omit<Kunde, 'id' | 'erstellt' | 'status'> & { status?: Kunde['status'] };
  herkunft: Herkunft;
  paket: Paket;
  region?: Region;
  subdomain?: string;
  test_tage?: number;
  beispiel?: Beispiel | boolean | null;
  admin_mail?: string | null;
  zahlung?: Instanz['zahlung'];
  ki_vorlage?: KiVorlage;
  /** Betriebsstufe. Test, Demo und Pitch landen immer auf „geteilt“. */
  stufe?: Stufe;
}

const id = (praefix: string) => praefix + Array.from(crypto.randomBytes(10), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const MAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i;

export class Leitstand {
  readonly db: DB;
  readonly bereitsteller: Bereitsteller;
  private mollie?: MollieClient;
  private uhr: () => Date;
  private optDomain?: string;
  readonly rechnungLink?: string;
  private rechnungen?: RechnungsTool;
  readonly oeffentlicheUrl: string;

  constructor(o: LeitstandOptionen) {
    this.db = o.db;
    this.bereitsteller = o.bereitsteller;
    this.mollie = o.mollie;
    this.uhr = o.jetzt ?? (() => new Date());
    this.optDomain = o.domain;
    this.rechnungLink = o.rechnungLink;
    this.rechnungen = o.rechnungen;
    this.oeffentlicheUrl = o.oeffentlicheUrl ?? 'https://leitstand.example';
    if (o.schalter && !this.db.prepare("SELECT 1 FROM einstellungen WHERE schluessel = 'schalter'").get()) this.db.prepare("INSERT INTO einstellungen VALUES ('schalter', ?)").run(JSON.stringify({ ...SCHALTER_STANDARD, ...o.schalter }));
    for (const h of o.geteilteHosts ?? []) if (!this.hostOpt(h.id)) this.speichereHost({ ...h, stufe: 'geteilt', erstellt: this.iso() });
  }

  // ---------- Schalter und Pakete (v1.4 Abschnitt 16 und 3.1) ----------
  schalter(): Schalter {
    const r = this.db.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'schalter'").get() as { wert: string } | undefined;
    return { ...SCHALTER_STANDARD, ...(r ? (JSON.parse(r.wert) as Partial<Schalter>) : {}) };
  }
  setzeSchalter(patch: Partial<Schalter>, wer: string): Schalter {
    const alt = this.schalter();
    const neu = { ...alt, ...patch };
    if (!Number.isInteger(neu.lesefrist_tage) || neu.lesefrist_tage < 30 || neu.lesefrist_tage > 90) throw new LeitstandFehler('ungueltig', 'Lesefrist 30 bis 90 Tage (Data Act: mindestens 30)');
    if (neu.managed_domain !== null && !/^[a-z0-9.-]{3,120}\.[a-z]{2,}$/.test(neu.managed_domain)) throw new LeitstandFehler('ungueltig', 'Domain ungültig');
    this.db.prepare("INSERT INTO einstellungen VALUES ('schalter', ?) ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert").run(JSON.stringify(neu));
    const geaendert = Object.keys(patch).filter((k) => JSON.stringify(alt[k as keyof Schalter]) !== JSON.stringify(neu[k as keyof Schalter]));
    this.ereignis(wer, 'schalter', null, Object.fromEntries(geaendert.map((k) => [k, { von: alt[k as keyof Schalter], nach: neu[k as keyof Schalter] }])));
    return neu;
  }
  pakete(): Record<Paket | 'test', PaketWerte> {
    const r = this.db.prepare("SELECT wert FROM einstellungen WHERE schluessel = 'pakete'").get() as { wert: string } | undefined;
    return r ? (JSON.parse(r.wert) as Record<Paket | 'test', PaketWerte>) : PAKETE_STANDARD;
  }
  setzePakete(p: Record<Paket | 'test', PaketWerte>, wer: string) {
    this.db.prepare("INSERT INTO einstellungen VALUES ('pakete', ?) ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert").run(JSON.stringify(p));
    this.ereignis(wer, 'pakete', null, {});
  }
  /** S-2: ohne Domain startet Managed nicht. */
  get domain(): string {
    const d = this.schalter().managed_domain ?? this.optDomain;
    if (!d) throw new LeitstandFehler('nicht_erlaubt', 'S-2: Domain für Kundeninstanzen fehlt, Managed startet nicht');
    return d;
  }
  private bedarf(paket: Paket, stufe: Stufe, imTest: boolean) {
    const w = this.pakete()[imTest ? 'test' : paket];
    return { ram_mb: w.ram_reserviert_mb, speicher_bytes: w.speicher_bytes[stufe] };
  }

  // ---------- Hosts und Auslastung ----------
  hostOpt(hid: string): Host | null {
    const r = this.db.prepare('SELECT daten FROM hosts WHERE id = ?').get(hid) as { daten: string } | undefined;
    return r ? (JSON.parse(r.daten) as Host) : null;
  }
  hosts(stufe?: Stufe): Host[] {
    return (this.db.prepare('SELECT daten FROM hosts ORDER BY id').all() as { daten: string }[]).map((r) => JSON.parse(r.daten) as Host).filter((h) => !stufe || h.stufe === stufe);
  }
  private speichereHost(h: Host) { this.db.prepare('INSERT INTO hosts (id, daten) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten').run(h.id, JSON.stringify(h)); }
  hostAnlegen(h: Omit<Host, 'erstellt' | 'stufe'>, wer: string): Host {
    if (!/^[a-z0-9-]{3,40}$/.test(h.id)) throw new LeitstandFehler('ungueltig', 'Host-ID: a–z, 0–9, Bindestrich');
    if (this.hostOpt(h.id)) throw new LeitstandFehler('konflikt', 'Host existiert');
    const neu: Host = { ...h, stufe: 'geteilt', erstellt: this.iso() };
    this.speichereHost(neu);
    this.ereignis(wer, 'host_angelegt', null, { host: h.id, kapazitaet: h.kapazitaet });
    return neu;
  }
  hostAendern(hid: string, patch: Partial<Pick<Host, 'aktiv' | 'kapazitaet' | 'name'>>, wer: string): Host {
    const h = this.hostOpt(hid);
    if (!h) throw new LeitstandFehler('nicht_gefunden', 'Host nicht gefunden');
    const neu = { ...h, ...patch };
    this.speichereHost(neu);
    this.ereignis(wer, 'host_geaendert', null, { host: hid, felder: Object.keys(patch) });
    return neu;
  }

  /** Belegung nach Paket-Anspruch (für die Platzwahl) plus tatsächlich gemessener Speicher (für die Anzeige). */
  belegung(hid: string, ohne?: string) {
    const auf = this.instanzen().filter((i) => i.host === hid && i.id !== ohne && i.status !== 'geloescht');
    const rueck = (this.db.prepare('SELECT instanz_id FROM rueckfall WHERE host = ? AND erledigt IS NULL').all(hid) as { instanz_id: string }[]).map((r) => r.instanz_id);
    const bed = (i: Instanz) => this.bedarf(i.paket, 'geteilt', i.status === 'test' || i.status === 'demo');
    const alle = [...auf.map(bed), ...rueck.map((rid) => { try { return bed(this.instanz(rid)); } catch { return this.bedarf('klein', 'geteilt', false); } })];
    return {
      container: alle.length,
      ram_mb: alle.reduce((s, p) => s + p.ram_mb, 0),
      speicher_bytes: alle.reduce((s, p) => s + p.speicher_bytes, 0),
      speicher_gemessen: auf.reduce((s, i) => s + i.betrieb.speicher_bytes, 0),
      rueckfall: rueck.length,
    };
  }

  async hostLast(hid: string): Promise<HostLast & { anteil: number; ampel: 'ok' | 'warnung' | 'voll'; anspruch_bytes: number; rueckfall: number }> {
    const h = this.hostOpt(hid);
    if (!h) throw new LeitstandFehler('nicht_gefunden', 'Host nicht gefunden');
    const b = this.belegung(hid);
    const g = this.bereitsteller.hostLast ? await this.bereitsteller.hostLast(hid).catch(() => null) : null;
    const last: HostLast = {
      container: g?.container ?? b.container,
      speicher_belegt: g?.speicher_belegt ?? b.speicher_gemessen,
      speicher_gesamt: h.kapazitaet.speicher_bytes,
      ram_belegt_mb: g?.ram_belegt_mb ?? b.ram_mb,
      ram_gesamt_mb: h.kapazitaet.ram_mb,
      quelle: g ? 'gemessen' : 'geschaetzt',
    };
    const anteil = Math.max(b.container / h.kapazitaet.container_max, b.ram_mb / h.kapazitaet.ram_mb, b.speicher_bytes / h.kapazitaet.speicher_bytes);
    return { ...last, anteil, ampel: auslastungStufe(anteil), anspruch_bytes: b.speicher_bytes, rueckfall: b.rueckfall };
  }

  /** Wählt den geteilten Host mit den meisten Reserven in der Region (sonst irgendeine Region). */
  private waehleGeteiltenHost(paket: Paket, region: Region, zweck: 'pitch' | 'test' | 'kunde', ohne?: string): Host {
    const bedarf = this.bedarf(paket, 'geteilt', zweck !== 'kunde');
    const kandidaten = this.hosts('geteilt')
      .filter((h) => !h.zweck || h.zweck.includes(zweck))
      .map((h) => ({ h, b: this.belegung(h.id, ohne) }))
      .filter(({ h, b }) => passtAufHost(h, b, bedarf).passt)
      .sort((x, y) => Number(y.h.region === region) - Number(x.h.region === region) || x.b.ram_mb / x.h.kapazitaet.ram_mb - y.b.ram_mb / y.h.kapazitaet.ram_mb);
    if (!kandidaten.length) throw new LeitstandFehler('konflikt', `Kein geteilter Host für ${zweck === 'pitch' ? 'Pitches' : zweck === 'test' ? 'Tests' : 'Kunden'} hat Platz (Grenze 70 %). Neuen Host anlegen (Hosts).`);
    return kandidaten[0]!.h;
  }

  private eigeneMaschine(iid: string, region: Region, paket: Paket): Host {
    const hid = `m-${iid.slice(2)}`;
    const vorhanden = this.hostOpt(hid);
    if (vorhanden) return vorhanden;
    const bedarf = { ram_mb: this.pakete()[paket].ram_mb, speicher_bytes: this.pakete()[paket].speicher_bytes.eigen };
    const h: Host = { id: hid, name: `Eigene Maschine ${iid}`, stufe: 'eigen', region, aktiv: true, instanz_id: iid, erstellt: this.iso(),
      kapazitaet: { container_max: 1, ram_mb: Math.max(2048, bedarf.ram_mb * 4), speicher_bytes: Math.max(40 * 1024 ** 3, bedarf.speicher_bytes * 2) } };
    this.speichereHost(h);
    return h;
  }

  jetzt() { return this.uhr(); }
  private iso() { return this.uhr().toISOString(); }

  // ---------- Prüfprotokoll ----------
  ereignis(wer: string, was: string, instanz_id?: string | null, daten?: Record<string, unknown>) {
    this.db.prepare('INSERT INTO ereignisse (am, wer, was, instanz_id, daten) VALUES (?, ?, ?, ?, ?)').run(this.iso(), wer, was, instanz_id ?? null, daten ? JSON.stringify(daten) : null);
  }
  ereignisse(f: { instanz_id?: string; seit?: string; limit?: number } = {}): Ereignis[] {
    const rows = this.db.prepare('SELECT * FROM ereignisse WHERE (? IS NULL OR instanz_id = ?) AND (? IS NULL OR am >= ?) ORDER BY id DESC LIMIT ?')
      .all(f.instanz_id ?? null, f.instanz_id ?? null, f.seit ?? null, f.seit ?? null, f.limit ?? 200) as { id: number; am: string; wer: string; was: string; instanz_id: string | null; daten: string | null }[];
    return rows.map((r) => ({ id: r.id, am: r.am, wer: r.wer, was: r.was, ...(r.instanz_id ? { instanz_id: r.instanz_id } : {}), ...(r.daten ? { daten: JSON.parse(r.daten) } : {}) }));
  }

  // ---------- Idempotenz ----------
  private mitSchluessel<T>(schluessel: string | undefined, f: () => Promise<T>): Promise<T> {
    if (!schluessel) return f();
    const alt = this.db.prepare('SELECT antwort FROM idempotenz WHERE schluessel = ?').get(schluessel) as { antwort: string } | undefined;
    if (alt) return Promise.resolve(JSON.parse(alt.antwort) as T);
    return f().then((r) => {
      this.db.prepare('INSERT OR IGNORE INTO idempotenz (schluessel, antwort, am) VALUES (?, ?, ?)').run(schluessel, JSON.stringify(r), this.iso());
      return r;
    });
  }

  // ---------- Kunden ----------
  kunden(f: { suche?: string; typ?: KontoTyp } = {}): Kunde[] {
    const alle = (this.db.prepare('SELECT daten FROM kunden').all() as { daten: string }[]).map((r) => JSON.parse(r.daten) as Kunde);
    const s = f.suche?.toLowerCase().trim();
    return alle
      .filter((k) => !f.typ || k.typ === f.typ)
      .filter((k) => !s || [k.firma, k.ansprechpartner, k.mail, k.quelle ?? '', k.zuordnung?.code ?? ''].some((x) => x.toLowerCase().includes(s)))
      .sort((a, b) => a.firma.localeCompare(b.firma, 'de'));
  }
  kunde(kid: string): Kunde {
    const r = this.db.prepare('SELECT daten FROM kunden WHERE id = ?').get(kid) as { daten: string } | undefined;
    if (!r) throw new LeitstandFehler('nicht_gefunden', 'Kunde nicht gefunden');
    return JSON.parse(r.daten) as Kunde;
  }
  private speichereKunde(k: Kunde) { this.db.prepare('INSERT INTO kunden (id, daten) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten').run(k.id, JSON.stringify(k)); }

  private pruefeKunde(k: Partial<Kunde>) {
    if (k.firma !== undefined && (!k.firma.trim() || k.firma.length > 160)) throw new LeitstandFehler('ungueltig', 'Firma fehlt');
    if (k.mail !== undefined && k.mail !== '' && !MAIL.test(k.mail)) throw new LeitstandFehler('ungueltig', 'Mail-Adresse ungültig');
    if (k.typ !== undefined && !(k.typ in KONTO_TYPEN)) throw new LeitstandFehler('ungueltig', 'Kontotyp unbekannt');
    if (k.notizen && k.notizen.length > 4000) throw new LeitstandFehler('ungueltig', 'Notiz zu lang');
  }

  /** Zuordnung zu einem Partnercode nur mit Zustimmung; ohne Zustimmung wird der Code verworfen, nicht gespeichert. */
  private zuordnung(code: string | undefined, weg: 'checkout' | 'link' | 'manuell', zustimmung: boolean): Kunde['zuordnung'] | undefined {
    if (!code || !zustimmung) return undefined;
    const c = normalisiereCode(code);
    const p = this.partnerOpt(c);
    if (!p || !p.aktiv) return undefined;
    return { code: c, weg, zustimmung_am: this.iso() };
  }

  kundeAnlegen(e: Omit<Kunde, 'id' | 'erstellt' | 'status' | 'zuordnung'> & { status?: Kunde['status']; empfehlungscode?: string; zuordnung_weg?: 'checkout' | 'link' | 'manuell'; zuordnung_zustimmung?: boolean }, wer: string): Kunde {
    this.pruefeKunde(e);
    const { empfehlungscode, zuordnung_weg, zuordnung_zustimmung, ...rest } = e;
    const z = this.zuordnung(empfehlungscode, zuordnung_weg ?? 'manuell', zuordnung_zustimmung ?? false);
    const k: Kunde = { ...rest, id: id('k_'), erstellt: this.iso(), status: e.status ?? 'interessent', ...(z ? { zuordnung: z } : {}) };
    this.speichereKunde(k);
    this.ereignis(wer, 'kunde_angelegt', null, { kunde_id: k.id, typ: k.typ, zuordnung: z?.code ?? null });
    return k;
  }

  kundeAendern(kid: string, patch: Partial<Omit<Kunde, 'id' | 'erstellt'>> & { empfehlungscode?: string; zuordnung_zustimmung?: boolean }, wer: string): Kunde {
    const k = this.kunde(kid);
    this.pruefeKunde(patch);
    const { empfehlungscode, zuordnung_zustimmung, ...rest } = patch;
    const neu: Kunde = { ...k, ...rest, id: k.id, erstellt: k.erstellt };
    if (empfehlungscode !== undefined) {
      const z = this.zuordnung(empfehlungscode, 'manuell', zuordnung_zustimmung ?? false);
      if (z) neu.zuordnung = z;
      else if (empfehlungscode === '') delete neu.zuordnung;
    }
    this.speichereKunde(neu);
    this.ereignis(wer, 'kunde_geaendert', null, { kunde_id: kid, felder: Object.keys(patch) });
    return neu;
  }

  // ---------- Instanzen ----------
  instanzen(f: { status?: InstanzStatus | InstanzStatus[]; kunde_id?: string; herkunft?: Herkunft['art']; partner?: string; mitGeloeschten?: boolean } = {}): Instanz[] {
    const st = f.status ? (Array.isArray(f.status) ? f.status : [f.status]) : null;
    return (this.db.prepare('SELECT daten FROM instanzen').all() as { daten: string }[])
      .map((r) => JSON.parse(r.daten) as Instanz)
      .filter((i) => (st ? st.includes(i.status) : f.mitGeloeschten || i.status !== 'geloescht'))
      .filter((i) => !f.kunde_id || i.kunde_id === f.kunde_id)
      .filter((i) => !f.herkunft || i.herkunft.art === f.herkunft)
      .filter((i) => !f.partner || i.herkunft.empfehlungscode === f.partner)
      .sort((a, b) => b.erstellt.localeCompare(a.erstellt));
  }
  instanz(iid: string): Instanz {
    const r = this.db.prepare('SELECT daten FROM instanzen WHERE id = ?').get(iid) as { daten: string } | undefined;
    if (!r) throw new LeitstandFehler('nicht_gefunden', 'Instanz nicht gefunden');
    return JSON.parse(r.daten) as Instanz;
  }
  private speichereInstanz(i: Instanz) {
    i.geaendert = this.iso();
    this.db.prepare('INSERT INTO instanzen (id, subdomain, daten) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten, subdomain = excluded.subdomain').run(i.id, i.subdomain, JSON.stringify(i));
  }
  private setzeStatus(i: Instanz, nach: InstanzStatus, wer: string, grund: string) {
    pruefeWechsel(i.status, nach, i.vorher);
    const von = i.status;
    if (nach === 'pausiert' || nach === 'loeschung_geplant') i.vorher = von;
    else if (von === 'pausiert' || von === 'loeschung_geplant') i.vorher = null;
    i.status = nach;
    this.speichereInstanz(i);
    this.ereignis(wer, 'status', i.id, { von, nach, grund });
  }

  private freieSubdomain(wunsch: string): string {
    let basis = normalisiereSubdomain(wunsch) || 'kunde';
    if (basis.length < 3) basis = `kunde-${basis}`;
    try { pruefeSubdomain(basis); } catch { basis = `${basis.slice(0, 33)}-kunde`; }
    const belegt = (s: string) => !!this.db.prepare('SELECT 1 FROM instanzen WHERE subdomain = ?').get(s);
    if (!belegt(basis)) return basis;
    for (let n = 2; n < 100; n++) if (!belegt(`${basis}-${n}`)) return `${basis}-${n}`;
    throw new LeitstandFehler('konflikt', 'Keine freie Subdomain');
  }

  /**
   * Vorgang instanz_anlegen: ein Ablauf für alle Herkünfte (Mollie, Formular, Handanlage, Pitch, Partner).
   * Mit gleichem Idempotenz-Schlüssel liefert jede Wiederholung dasselbe Ergebnis und legt nichts doppelt an.
   */
  async instanzAnlegen(e: InstanzEingabe, wer: string, schluessel?: string): Promise<{ instanz: Instanz; vorgang: Vorgang }> {
    return this.mitSchluessel(schluessel ? `instanz_anlegen:${schluessel}` : undefined, async () => {
      if (!(e.paket in PAKETE)) throw new LeitstandFehler('ungueltig', 'Paket unbekannt');
      const region = e.region ?? 'de-nbg';
      if (!(region in REGIONEN)) throw new LeitstandFehler('ungueltig', 'Region unbekannt');
      const ki = e.ki_vorlage ?? 'mock';
      if (!(ki in KI_VORLAGEN)) throw new LeitstandFehler('ungueltig', 'KI-Vorlage unbekannt');
      const demo = e.herkunft.art === 'pitch';
      const beispiel: Beispiel | null = e.beispiel === true ? 'tischlerei-wendt' : e.beispiel && typeof e.beispiel === 'string' ? e.beispiel : null;
      if (beispiel && !(beispiel in BEISPIELE)) throw new LeitstandFehler('ungueltig', 'Beispiel unbekannt');
      if (e.admin_mail && !MAIL.test(e.admin_mail)) throw new LeitstandFehler('ungueltig', 'Admin-Mail ungültig');

      let kunde_id: string | null = e.kunde_id ?? null;
      if (!kunde_id && e.kunde) kunde_id = this.kundeAnlegen(e.kunde, wer).id;
      if (kunde_id) this.kunde(kunde_id);
      if (!kunde_id && !demo) throw new LeitstandFehler('ungueltig', 'Ohne Kunde nur Pitch-Instanzen');
      const sch = this.schalter();
      void this.domain; // S-2 prüfen, bevor etwas angelegt wird
      // S-6/S-8: Testformular nur, wenn offen und nicht pausiert (Mollie-Käufe laufen immer durch, das Geld ist schon da)
      if (e.herkunft.art === 'formular' && !sch.tests_offen) throw new LeitstandFehler('nicht_erlaubt', 'S-6: Testformular ist geschlossen');
      if (e.herkunft.art === 'formular' && sch.neue_tests_pausiert) throw new LeitstandFehler('nicht_erlaubt', 'S-8: Neue Tests sind gerade pausiert');
      // S-12: Berufsgeheimnisträger nur lokal oder auf eigenem Server, bis Till den Schalter öffnet
      if (kunde_id && this.kunde(kunde_id).berufsgeheimnis && !sch.berufsgeheimnis_offen) throw new LeitstandFehler('nicht_erlaubt', 'S-12: Berufsgeheimnisträger im Managed-Betrieb noch gesperrt. Weg: lokal oder eigener Server des Kunden.');

      const zahlung = e.zahlung ?? (demo ? 'frei' : 'test');
      const tage = e.test_tage ?? (demo ? FRISTEN.demo_tage : FRISTEN.test_tage);
      if (!Number.isInteger(tage) || tage < 1 || tage > 60) throw new LeitstandFehler('ungueltig', 'Testtage 1 bis 60');
      const kundeObj = kunde_id ? this.kunde(kunde_id) : null;
      const subdomain = this.freieSubdomain(e.subdomain || kundeObj?.firma || (beispiel ? `pitch-${beispiel}` : 'pitch'));
      pruefeSubdomain(subdomain);
      const status0 = startStatus({ herkunft: e.herkunft, zahlung, demo });
      if (e.stufe && !(e.stufe in STUFEN)) throw new LeitstandFehler('ungueltig', 'Stufe unbekannt');
      const stufe = stufeFuer(e.stufe, zahlung, demo);
      // G1 T-2: Selbstbedienungs-Tests (Formular) begrenzen; Till kann von Hand immer anlegen.
      if (status0 === 'test' && e.herkunft.art === 'formular' && kundeObj) {
        const bisher = this.instanzen({ mitGeloeschten: true }).filter((i) => i.herkunft.art === 'formular' && i.kunde_id).map((i) => ({ mail: this.kunde(i.kunde_id!).mail, erstellt: i.erstellt }));
        const sperre = testSperre(kundeObj.mail, bisher, this.jetzt());
        if (sperre) throw new LeitstandFehler('konflikt', sperre);
      }
      const jetzt = this.iso();
      const neueId = id('i_');
      const host = stufe === 'geteilt' ? this.waehleGeteiltenHost(e.paket, region, demo ? 'pitch' : status0 === 'test' ? 'test' : 'kunde') : this.eigeneMaschine(neueId, region, e.paket);
      const kiWeg: Instanz['ki']['weg'] = status0 === 'test'
        ? (sch.test_ki && !kundeObj?.berufsgeheimnis ? 'hd_test' : ki === 'eigener' || ki === 'ollama' ? 'eigener_schluessel' : 'ohne')
        : ki === 'mock' ? 'ohne' : ki === 'eigener' || ki === 'ollama' ? 'eigener_schluessel' : 'app';
      const instanz: Instanz = {
        id: neueId, kunde_id, subdomain, url: `https://${subdomain}.${this.domain}`, status: 'angelegt', herkunft: e.herkunft, paket: e.paket, region,
        test_ende: status0 === 'test' || status0 === 'demo' ? testEnde(this.jetzt(), tage) : null, loeschen_am: null, erstellt: jetzt, geaendert: jetzt, version: '0.1.0',
        betrieb: { modus: 'normal', ki_verbrauch_cent_monat: 0, ki_kontingent_cent_monat: null, zugaenge_oauth: 0, speicher_bytes: 0, benutzer: 0, letzte_anmeldung_tag: null, backup_letztes: null, backup_ok: true, health: 'ok' },
        ki_vorlage: ki, beispiel, vorher: null, zahlung, kulanz_bis: null, stufe, host: host.id,
        kuendigung_zum: null, test_selbst_verlaengert: false, ki: { weg: kiWeg, egress_freigaben: [] },
      };
      this.speichereInstanz(instanz);
      this.ereignis(wer, 'instanz_anlegen', instanz.id, { herkunft: e.herkunft.art, paket: e.paket, region, beispiel, zahlung, stufe, host: host.id, code: e.herkunft.empfehlungscode ?? null });
      const vorgang: Vorgang = {
        id: id('v_'), art: 'instanz_anlegen', instanz_id: instanz.id, status: 'wartet', ausgeloest_von: wer, erstellt: jetzt,
        schritte: this.bereitsteller.schritte.map((n) => ({ name: n, status: 'wartet' as const })),
      };
      this.speichereVorgang(vorgang);
      const fertig = await this.fuehreAnlageAus(instanz.id, vorgang.id, e.admin_mail ?? kundeObj?.mail ?? null, status0);
      if (kundeObj && status0 !== 'demo') {
        const k = this.kunde(kundeObj.id);
        const neuerStatus = status0 === 'aktiv' ? 'kunde' : k.status === 'kunde' ? 'kunde' : 'test';
        if (k.status !== neuerStatus) this.speichereKunde({ ...k, status: neuerStatus });
      }
      return fertig;
    });
  }

  /** v1.4 3.5: Konto-Token je Instanz. Klartext nur für den Bereitsteller (Umgebung der Instanz), hier nur der Hash. */
  private neuesKontoToken(iid: string): string {
    const t = 'kkt_' + crypto.randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO konto_tokens (hash, instanz_id) VALUES (?, ?) ON CONFLICT(instanz_id) DO UPDATE SET hash = excluded.hash').run(crypto.createHash('sha256').update(t).digest('hex'), iid);
    return t;
  }
  /** Instanz zu einem Konto-Token, oder null. */
  instanzZuKontoToken(t: string | undefined): string | null {
    if (!t || !t.startsWith('kkt_')) return null;
    const r = this.db.prepare('SELECT instanz_id FROM konto_tokens WHERE hash = ?').get(crypto.createHash('sha256').update(t).digest('hex')) as { instanz_id: string } | undefined;
    return r?.instanz_id ?? null;
  }

  /** v1.4 3.4: Grenzen nach Paket, Stufe, Testphase und KI-Weg in die Instanz schreiben. */
  async setzeGrenzen(iid: string) {
    const i = this.instanz(iid);
    const g = grenzenFuer(this.pakete(), i.paket, i.stufe, i.status === 'test' || i.status === 'demo', this.schalter(), i.ki.weg);
    await this.bereitsteller.grenzen(iid, g);
    return g;
  }

  private speichereVorgang(v: Vorgang) {
    this.db.prepare('INSERT INTO vorgaenge (id, instanz_id, erstellt, daten) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten').run(v.id, v.instanz_id, v.erstellt, JSON.stringify(v));
  }
  vorgang(vid: string): Vorgang {
    const r = this.db.prepare('SELECT daten FROM vorgaenge WHERE id = ?').get(vid) as { daten: string } | undefined;
    if (!r) throw new LeitstandFehler('nicht_gefunden', 'Vorgang nicht gefunden');
    return JSON.parse(r.daten) as Vorgang;
  }
  vorgaenge(f: { instanz_id?: string; offen?: boolean } = {}): Vorgang[] {
    return (this.db.prepare('SELECT daten FROM vorgaenge WHERE (? IS NULL OR instanz_id = ?) ORDER BY erstellt DESC').all(f.instanz_id ?? null, f.instanz_id ?? null) as { daten: string }[])
      .map((r) => JSON.parse(r.daten) as Vorgang)
      .filter((v) => !f.offen || v.status === 'wartet' || v.status === 'laeuft' || v.status === 'fehler');
  }

  private async fuehreAnlageAus(iid: string, vid: string, adminMail: string | null, ziel: InstanzStatus): Promise<{ instanz: Instanz; vorgang: Vorgang }> {
    const v = this.vorgang(vid);
    let i = this.instanz(iid);
    v.status = 'laeuft';
    const kontoToken = this.neuesKontoToken(iid);
    for (const s of v.schritte) {
      if (s.status === 'fertig' && s.name !== 'schluessel_erzeugen') continue;
      if (s.status === 'uebersprungen') continue;
      if (s.name === 'beispiel_laden' && !i.beispiel) { s.status = 'uebersprungen'; continue; }
      s.status = 'laeuft';
      try {
        const r = await this.bereitsteller.schritt(s.name, { id: i.id, subdomain: i.subdomain, paket: i.paket, region: i.region, ki_vorlage: i.ki_vorlage, beispiel: i.beispiel, admin_mail: adminMail, stufe: i.stufe, host: i.host, konto_token: kontoToken });
        s.status = 'fertig';
        s.am = this.iso();
        if (r.meldung) s.meldung = r.meldung;
        if (r.url) i.url = r.url;
        if (r.version) i.version = r.version;
      } catch (err) {
        s.status = 'fehler';
        s.am = this.iso();
        s.meldung = (err as Error).message.slice(0, 300);
        v.status = 'fehler';
        this.speichereVorgang(v);
        i = { ...this.instanz(iid), url: i.url, version: i.version };
        if (i.status !== 'fehler') this.setzeStatus(i, 'fehler', 'leitstand', `Schritt ${s.name} gescheitert`);
        return { instanz: this.instanz(iid), vorgang: v };
      }
      this.speichereVorgang(v);
    }
    v.status = 'fertig';
    v.ergebnis = { ziel };
    this.speichereVorgang(v);
    i = { ...this.instanz(iid), url: i.url, version: i.version };
    if (i.status === 'fehler') this.setzeStatus(i, 'angelegt', 'leitstand', 'Vorgang wiederholt');
    i = { ...this.instanz(iid), url: i.url, version: i.version };
    this.setzeStatus(i, ziel, 'leitstand', 'Anlage fertig');
    await this.setzeGrenzen(iid).catch(() => undefined);
    await this.aktualisiereBetrieb(iid).catch(() => undefined);
    if (ziel === 'test' && adminMail) {
      this.mail(`testbeginn:${iid}`, adminMail, 'Dein Zugang ist da',
        `Deine Testphase endet am ${this.datum(i.test_ende)} um 23:59 Uhr. Drei Schritte bis zur ersten Antwort: anmelden, ein Dokument hinzufügen oder die eigene KI anbinden, eine Frage stellen. Der Export-Knopf liegt unter Einstellungen › Konto. Wenn du nichts tust, wird nichts abgebucht.`, iid);
    } else if (ziel === 'aktiv' && adminMail) {
      this.mail(`zugang:${iid}`, adminMail, 'Dein Zugang ist da', 'Deine Instanz ist eingerichtet. Der Einladungslink kommt in einer eigenen Mail. Export jederzeit unter Einstellungen › Konto.', iid);
    }
    return { instanz: this.instanz(iid), vorgang: this.vorgang(vid) };
  }

  /** Gescheiterten Vorgang fortsetzen: bereits fertige Schritte werden nicht wiederholt. */
  async vorgangWiederholen(vid: string, wer: string) {
    const v = this.vorgang(vid);
    if (v.status !== 'fehler') throw new LeitstandFehler('konflikt', 'Nur gescheiterte Vorgänge lassen sich wiederholen');
    if (v.art !== 'instanz_anlegen') throw new LeitstandFehler('ungueltig', 'Nur Anlage-Vorgänge wiederholbar');
    this.ereignis(wer, 'vorgang_wiederholen', v.instanz_id, { vorgang: vid });
    const i = this.instanz(v.instanz_id);
    const ziel = startStatus({ herkunft: i.herkunft, zahlung: i.zahlung, demo: i.herkunft.art === 'pitch' });
    const mail = i.kunde_id ? this.kunde(i.kunde_id).mail : null;
    return this.fuehreAnlageAus(i.id, vid, mail, ziel);
  }

  async aktualisiereBetrieb(iid: string): Promise<Instanz> {
    const i = this.instanz(iid);
    if (i.status === 'geloescht') return i;
    const s = nurBetriebsdaten(await this.bereitsteller.status(iid) as never);
    const { version, ...betrieb } = s;
    i.betrieb = betrieb;
    if (version !== 'unbekannt') i.version = version;
    this.speichereInstanz(i);
    return i;
  }

  async pausieren(iid: string, grund: string, wer: string) {
    const i = this.instanz(iid);
    this.setzeStatus(i, 'pausiert', wer, grund || 'ohne Angabe');
    await this.bereitsteller.modus(iid, 'pausiert');
    return this.instanz(iid);
  }
  async fortsetzen(iid: string, wer: string) {
    const i = this.instanz(iid);
    if (i.status !== 'pausiert' || !i.vorher) throw new LeitstandFehler('konflikt', 'Instanz ist nicht pausiert');
    this.setzeStatus(i, i.vorher, wer, 'fortgesetzt');
    const n = this.instanz(iid);
    await this.bereitsteller.modus(iid, ['test_abgelaufen', 'nur_lesen', 'umzug_laeuft', 'umgezogen', 'loeschung_geplant'].includes(n.status) ? 'nur_lesen' : 'normal');
    return n;
  }

  testVerlaengern(iid: string, tage: number, grund: string, wer: string) {
    if (!Number.isInteger(tage) || tage < 1 || tage > FRISTEN.test_verlaengern_max) throw new LeitstandFehler('ungueltig', `Verlängerung 1 bis ${FRISTEN.test_verlaengern_max} Tage`);
    if (!grund.trim()) throw new LeitstandFehler('ungueltig', 'Grund fehlt');
    const i = this.instanz(iid);
    if (!['test', 'test_abgelaufen', 'demo'].includes(i.status)) throw new LeitstandFehler('konflikt', 'Nur Tests und Pitches lassen sich verlängern');
    const basis = i.test_ende && new Date(i.test_ende) > this.jetzt() ? i.test_ende : this.iso();
    i.test_ende = plusTage(basis, tage);
    i.loeschen_am = null;
    this.speichereInstanz(i);
    this.ereignis(wer, 'test_verlaengert', iid, { tage, grund, neu: i.test_ende });
    if (i.status === 'test_abgelaufen') { this.setzeStatus(this.instanz(iid), 'test', wer, 'verlängert'); void this.bereitsteller.modus(iid, 'normal'); }
    if (i.kunde_id) {
      const k = this.kunde(i.kunde_id);
      this.mail(`verlaengert:${iid}:${i.test_ende}`, k.mail, 'Ihre Testphase wurde verlängert', `Neues Testende: ${this.datum(i.test_ende)}.`, iid);
    }
    return this.instanz(iid);
  }

  /** Kauf ohne Mollie (Rechnung) oder nach Mollie-Zahlung. */
  async aktivieren(iid: string, zahlung: 'rechnung' | 'mollie' | 'frei', referenz: string | undefined, wer: string) {
    const i = this.instanz(iid);
    if (i.status === 'aktiv') return i;
    if (i.status === 'demo') throw new LeitstandFehler('konflikt', 'Pitch erst übernehmen (Beispieldaten entfernen), dann aktivieren');
    i.zahlung = zahlung;
    // Nach dem Kauf gilt der KI-Weg der Voreinstellung (Test-KI endet mit dem Test)
    i.ki.weg = i.ki_vorlage === 'mock' ? 'ohne' : i.ki_vorlage === 'eigener' || i.ki_vorlage === 'ollama' ? 'eigener_schluessel' : 'app';
    i.test_ende = null;
    i.loeschen_am = null;
    i.kulanz_bis = null;
    this.speichereInstanz(i);
    this.setzeStatus(this.instanz(iid), 'aktiv', wer, `aktiviert (${zahlung}${referenz ? `, ${referenz}` : ''})`);
    await this.bereitsteller.modus(iid, 'normal');
    await this.setzeGrenzen(iid).catch(() => undefined);
    if (i.kunde_id) { const k = this.kunde(i.kunde_id); this.speichereKunde({ ...k, status: 'kunde', rechnungsweg: zahlung === 'frei' ? 'keiner' : zahlung }); }
    return this.instanz(iid);
  }

  /** Pitch geht an Interessenten über: Beispieldaten werden vorher gelöscht, dann normale Testphase. */
  async demoUebernehmen(iid: string, kunde_id: string, wer: string) {
    const i = this.instanz(iid);
    if (i.status !== 'demo') throw new LeitstandFehler('konflikt', 'Nur Pitch-Instanzen');
    const k = this.kunde(kunde_id);
    await this.bereitsteller.beispiel(iid, 'entfernen', i.beispiel);
    i.kunde_id = k.id;
    i.beispiel = null;
    i.zahlung = 'test';
    i.test_ende = plusTage(this.iso(), FRISTEN.test_tage);
    this.speichereInstanz(i);
    this.ereignis(wer, 'demo_uebernommen', iid, { kunde_id, beispieldaten: 'entfernt' });
    this.setzeStatus(this.instanz(iid), 'test', wer, 'Pitch übernommen');
    await this.bereitsteller.einladung(iid, k.mail);
    this.speichereKunde({ ...k, status: 'test' });
    return this.instanz(iid);
  }

  async exportieren(iid: string, art: 'umzugspaket' | 'okf', wer: string) {
    const i = this.instanz(iid);
    if (['geloescht', 'angelegt', 'fehler'].includes(i.status)) throw new LeitstandFehler('konflikt', 'Export in diesem Zustand nicht möglich');
    const v: Vorgang = { id: id('v_'), art: 'export', instanz_id: iid, status: 'laeuft', ausgeloest_von: wer, erstellt: this.iso(), schritte: [{ name: 'paket_bauen', status: 'laeuft' }, { name: 'admin_benachrichtigen', status: 'wartet' }] };
    this.speichereVorgang(v);
    this.ereignis(wer, 'export', iid, { art });
    try {
      const r = await this.bereitsteller.export(iid, art);
      v.schritte[0] = { name: 'paket_bauen', status: 'fertig', am: this.iso() };
      v.schritte[1] = { name: 'admin_benachrichtigen', status: 'fertig', am: this.iso(), meldung: 'Download-Link nur an den Admin der Instanz' };
      v.status = 'fertig';
      v.ergebnis = { bytes: r.bytes, sha256: r.sha256, bereit_bis: plusTage(this.iso(), 7) };
    } catch (err) {
      v.schritte[0] = { name: 'paket_bauen', status: 'fehler', am: this.iso(), meldung: (err as Error).message.slice(0, 300) };
      v.status = 'fehler';
    }
    this.speichereVorgang(v);
    return v;
  }

  /** Umzug in eigene Cloud oder lokal: Umzugspaket bauen, Instanz nur lesend, warten auf Prüfbericht der neuen Instanz. */
  async umzugStarten(iid: string, ziel: 'eigene_cloud' | 'lokal' | 'hd', ziel_url: string | undefined, wer: string) {
    const i = this.instanz(iid);
    pruefeWechsel(i.status, 'umzug_laeuft');
    const v = await this.exportieren(iid, 'umzugspaket', wer);
    if (v.status !== 'fertig') throw new LeitstandFehler('intern', 'Umzugspaket konnte nicht gebaut werden');
    const u: Vorgang = {
      id: id('v_'), art: 'umzug', instanz_id: iid, status: 'laeuft', ausgeloest_von: wer, erstellt: this.iso(),
      schritte: [
        { name: 'umzugspaket', status: 'fertig', am: this.iso(), meldung: `sha256 ${String(v.ergebnis?.sha256).slice(0, 12)}…` },
        { name: 'alte_instanz_nur_lesen', status: 'fertig', am: this.iso() },
        { name: 'import_beim_kunden', status: 'wartet', meldung: ziel === 'lokal' ? 'Kunde spielt Paket lokal ein' : 'Kunde spielt Paket in seiner Cloud ein' },
        { name: 'pruefbericht_bestaetigen', status: 'wartet' },
        { name: 'alte_instanz_loeschen', status: 'wartet', meldung: `${FRISTEN.nach_umzug_bis_loeschung} Tage nach Bestätigung` },
      ],
      ergebnis: { ziel, ziel_url: ziel_url ?? null, paket_sha256: v.ergebnis?.sha256 ?? null },
    };
    this.speichereVorgang(u);
    this.setzeStatus(this.instanz(iid), 'umzug_laeuft', wer, `Umzug nach ${ziel}`);
    await this.bereitsteller.modus(iid, 'nur_lesen');
    return { instanz: this.instanz(iid), vorgang: u };
  }

  async umzugBestaetigen(iid: string, pruefbericht_sha256: string, wer: string) {
    if (!/^[a-f0-9]{64}$/.test(pruefbericht_sha256)) throw new LeitstandFehler('ungueltig', 'Prüfbericht: sha256 hex');
    const u = this.vorgaenge({ instanz_id: iid }).find((v) => v.art === 'umzug' && v.status === 'laeuft');
    if (!u) throw new LeitstandFehler('konflikt', 'Kein laufender Umzug');
    for (const s of u.schritte) if (s.name === 'import_beim_kunden' || s.name === 'pruefbericht_bestaetigen') { s.status = 'fertig'; s.am = this.iso(); }
    u.status = 'fertig';
    u.ergebnis = { ...u.ergebnis, pruefbericht_sha256 };
    this.speichereVorgang(u);
    this.setzeStatus(this.instanz(iid), 'umgezogen', wer, 'neue Instanz bestätigt');
    const i = this.instanz(iid);
    i.loeschen_am = plusTage(this.iso(), FRISTEN.nach_umzug_bis_loeschung);
    this.speichereInstanz(i);
    return i;
  }

  umzugAbbrechen(iid: string, grund: string, wer: string) {
    const i = this.instanz(iid);
    const u = this.vorgaenge({ instanz_id: iid }).find((v) => v.art === 'umzug' && v.status === 'laeuft');
    if (u) { u.status = 'fehler'; u.schritte.push({ name: 'abgebrochen', status: 'fertig', am: this.iso(), meldung: grund }); this.speichereVorgang(u); }
    this.setzeStatus(i, 'aktiv', wer, `Umzug abgebrochen: ${grund}`);
    void this.bereitsteller.modus(iid, 'normal');
    return this.instanz(iid);
  }

  /**
   * Löschung planen. Bestätigung = Subdomain abtippen. Ohne `sofort` gilt die Frist (Demo sofort).
   * `sofort` bei Kunden nur mit Beleg (Kundenwunsch in Textform).
   */
  async loeschungPlanen(iid: string, e: { bestaetigung: string; grund: string; sofort?: boolean; beleg?: string }, wer: string) {
    const i = this.instanz(iid);
    if (e.bestaetigung.trim() !== i.subdomain) throw new LeitstandFehler('ungueltig', 'Bestätigung stimmt nicht mit der Subdomain überein');
    if (!e.grund.trim()) throw new LeitstandFehler('ungueltig', 'Grund fehlt');
    if (i.status === 'geloescht') throw new LeitstandFehler('konflikt', 'Bereits gelöscht');
    const istDemo = i.status === 'demo';
    if (e.sofort && !istDemo && !(e.beleg && e.beleg.trim().length >= 3)) throw new LeitstandFehler('ungueltig', 'Sofort löschen nur mit Beleg des Kundenwunschs');
    const am = e.sofort ? this.iso() : loeschDatum(i, this.iso());
    if (i.status !== 'loeschung_geplant') this.setzeStatus(i, 'loeschung_geplant', wer, e.grund);
    const n = this.instanz(iid);
    n.loeschen_am = am;
    this.speichereInstanz(n);
    this.ereignis(wer, 'loeschung_geplant', iid, { am, sofort: !!e.sofort, beleg: e.beleg ? 'liegt vor' : null });
    if (new Date(am) <= this.jetzt()) return this.loeschenAusfuehren(iid, e.grund, wer, e.beleg);
    await this.bereitsteller.modus(iid, 'nur_lesen');
    if (n.kunde_id) { const k = this.kunde(n.kunde_id); this.mail(`loeschung:${iid}:${am}`, k.mail, 'Ankündigung: Löschung Ihrer Instanz', `Ihre Instanz wird am ${this.datum(am)} gelöscht. Bis dahin können Sie lesen und exportieren.`, iid); }
    return n;
  }

  loeschungAbbrechen(iid: string, wer: string) {
    const i = this.instanz(iid);
    if (i.status !== 'loeschung_geplant' || !i.vorher) throw new LeitstandFehler('konflikt', 'Keine Löschung geplant');
    const vorher = i.vorher;
    i.loeschen_am = null;
    this.speichereInstanz(i);
    this.setzeStatus(this.instanz(iid), vorher, wer, 'Löschung abgebrochen');
    void this.bereitsteller.modus(iid, ['aktiv', 'test', 'demo', 'zahlung_offen'].includes(vorher) ? 'normal' : 'nur_lesen');
    return this.instanz(iid);
  }

  private async loeschenAusfuehren(iid: string, grund: string, wer: string, beleg?: string): Promise<Instanz> {
    const i = this.instanz(iid);
    const nachweis = await this.bereitsteller.loeschen(iid);
    const firma = i.kunde_id ? this.kunde(i.kunde_id).firma : null;
    const angekuendigt = this.ereignisse({ instanz_id: iid }).find((e) => e.was === 'loeschung_geplant')?.am ?? null;
    const exportAngeboten = this.vorgaenge({ instanz_id: iid }).some((v) => v.art === 'export' && v.status === 'fertig') || i.status !== 'demo';
    const b: Omit<Loeschbeleg, 'id'> = {
      instanz_id: iid, subdomain: i.subdomain, firma, grund, angekuendigt_am: angekuendigt, geloescht_am: this.iso(), von: wer, export_angeboten: exportAngeboten,
      nachweis: [...nachweis, `Backups laufen nach Aufbewahrungsfrist aus`, ...(beleg ? ['Kundenwunsch in Textform liegt vor'] : [])].join(' · '),
    };
    this.db.prepare('INSERT INTO loeschbelege (daten) VALUES (?)').run(JSON.stringify(b));
    i.status = 'geloescht';
    i.betrieb = { ...i.betrieb, speicher_bytes: 0, benutzer: 0, health: 'aus' };
    this.speichereInstanz(i);
    const h = this.hostOpt(i.host);
    if (h?.stufe === 'eigen') this.speichereHost({ ...h, aktiv: false });
    this.ereignis(wer, 'geloescht', iid, { grund, nachweis });
    if (i.kunde_id) { const k = this.kunde(i.kunde_id); this.mail(`geloescht:${iid}`, k.mail, 'Gelöscht', `Löschprotokoll: ${b.geloescht_am} · ${b.nachweis}`, iid); }
    return i;
  }

  loeschbelege(): Loeschbeleg[] {
    return (this.db.prepare('SELECT id, daten FROM loeschbelege ORDER BY id DESC').all() as { id: number; daten: string }[]).map((r) => ({ id: r.id, ...(JSON.parse(r.daten) as Omit<Loeschbeleg, 'id'>) }));
  }

  // ---------- Stufenwechsel Geteilt ↔ Eigene Maschine ----------
  /**
   * Hoch- oder Herunterstufen. Ablauf wie ein Umzug innerhalb von HD: Ziel bereitstellen, alt nur lesen, Paket,
   * übertragen, einspielen, Prüfsummen vergleichen, umschalten, alt anhalten. Weicht die Prüfsumme ab oder scheitert
   * ein Schritt vor dem Umschalten, wird automatisch zurückgebaut und die alte Instanz läuft normal weiter.
   * Die alte Instanz bleibt FRISTEN.rueckfall_tage angehalten liegen, danach löscht der Planer sie.
   */
  /** Stufenwechsel für heute Nacht (02:00 Europe/Berlin) vormerken; der Planer führt ihn aus. */
  stufeWechselnNachts(iid: string, nach: Stufe, wer: string): { ab: string } {
    const i = this.instanz(iid);
    if (i.stufe === nach) throw new LeitstandFehler('konflikt', `Instanz läuft schon auf „${STUFEN[nach]}“`);
    if (i.status !== 'aktiv') throw new LeitstandFehler('konflikt', 'Stufenwechsel nur für aktive Instanzen (Test, Demo und Pitch bleiben geteilt)');
    const ab = naechsteNacht(this.jetzt());
    this.db.prepare('INSERT INTO geplante_wechsel (instanz_id, nach, ab, von) VALUES (?, ?, ?, ?) ON CONFLICT(instanz_id) DO UPDATE SET nach = excluded.nach, ab = excluded.ab, von = excluded.von').run(iid, nach, ab, wer);
    this.ereignis(wer, 'stufenwechsel_geplant', iid, { nach, ab });
    return { ab };
  }
  geplanteWechsel(): { instanz_id: string; nach: Stufe; ab: string; von: string }[] {
    return this.db.prepare('SELECT * FROM geplante_wechsel ORDER BY ab').all() as never;
  }
  wechselAbsagen(iid: string, wer: string) {
    this.db.prepare('DELETE FROM geplante_wechsel WHERE instanz_id = ?').run(iid);
    this.ereignis(wer, 'stufenwechsel_abgesagt', iid);
  }

  async stufeWechseln(iid: string, nach: Stufe, wer: string, schluessel?: string): Promise<{ instanz: Instanz; vorgang: Vorgang }> {
    return this.mitSchluessel(schluessel ? `stufenwechsel:${schluessel}` : undefined, async () => {
      if (!(nach in STUFEN)) throw new LeitstandFehler('ungueltig', 'Stufe unbekannt');
      this.db.prepare('DELETE FROM geplante_wechsel WHERE instanz_id = ?').run(iid);
      const i = this.instanz(iid);
      if (i.stufe === nach) throw new LeitstandFehler('konflikt', `Instanz läuft schon auf „${STUFEN[nach]}“`);
      if (i.status !== 'aktiv') throw new LeitstandFehler('konflikt', 'Stufenwechsel nur für aktive Instanzen (Test, Demo und Pitch bleiben geteilt)');
      const zielHost = nach === 'geteilt' ? this.waehleGeteiltenHost(i.paket, i.region, 'kunde', i.id) : this.eigeneMaschine(i.id, i.region, i.paket);
      const w: Wechselauftrag = { id: i.id, subdomain: i.subdomain, paket: i.paket, region: i.region, von: { stufe: i.stufe, host: i.host }, nach: { stufe: nach, host: zielHost.id } };
      const v: Vorgang = {
        id: id('v_'), art: 'stufenwechsel', instanz_id: iid, status: 'laeuft', ausgeloest_von: wer, erstellt: this.iso(),
        schritte: this.bereitsteller.wechselSchritte.map((n) => ({ name: n, status: 'wartet' as const })), ergebnis: { von: i.stufe, nach, von_host: i.host, nach_host: zielHost.id },
      };
      this.speichereVorgang(v);
      this.ereignis(wer, 'stufenwechsel_start', iid, { von: i.stufe, nach, ziel: zielHost.id });
      this.setzeStatus(i, 'wechsel_laeuft', wer, `${STUFEN[i.stufe]} → ${STUFEN[nach]}`);
      let umgeschaltet = false;
      for (const s of v.schritte) {
        s.status = 'laeuft';
        this.speichereVorgang(v);
        try {
          const r = await this.bereitsteller.wechselSchritt(s.name, w);
          if (s.name === 'pruefen') {
            const alt = String(r.ergebnis?.alt ?? ''), neu = String(r.ergebnis?.neu ?? '');
            if (!alt || alt !== neu) throw new Error(`Prüfsummen weichen ab (alt ${alt.slice(0, 12)}…, neu ${neu.slice(0, 12)}…)`);
            s.meldung = `Prüfsumme gleich: ${alt.slice(0, 16)}…`;
            v.ergebnis = { ...v.ergebnis, pruefsumme: alt };
          } else if (r.meldung) s.meldung = r.meldung;
          s.status = 'fertig';
          s.am = this.iso();
          if (s.name === 'umschalten') {
            umgeschaltet = true;
            const n = this.instanz(iid);
            n.stufe = nach;
            n.host = zielHost.id;
            this.speichereInstanz(n);
          }
        } catch (err) {
          s.status = 'fehler';
          s.am = this.iso();
          s.meldung = (err as Error).message.slice(0, 300);
          v.status = 'fehler';
          if (!umgeschaltet) {
            await this.bereitsteller.wechselRueckbau(w).catch(() => undefined);
            v.schritte.push({ name: 'rueckbau', status: 'fertig', am: this.iso(), meldung: 'Ziel entfernt, alte Instanz läuft normal weiter' });
            if (nach === 'eigen' && zielHost.stufe === 'eigen') this.db.prepare('DELETE FROM hosts WHERE id = ?').run(zielHost.id);
          } else {
            v.schritte.push({ name: 'rueckbau', status: 'uebersprungen', meldung: 'Neue Instanz läuft bereits; alte bitte von Hand anhalten' });
          }
          this.speichereVorgang(v);
          this.setzeStatus(this.instanz(iid), 'aktiv', 'leitstand', `Stufenwechsel gescheitert bei ${s.name}`);
          return { instanz: this.instanz(iid), vorgang: v };
        }
        this.speichereVorgang(v);
      }
      v.status = 'fertig';
      v.schritte.push({ name: 'alt_loeschen', status: 'wartet', meldung: `automatisch in ${FRISTEN.rueckfall_tage} Tagen` });
      this.speichereVorgang(v);
      this.db.prepare('INSERT OR REPLACE INTO rueckfall (instanz_id, host, loeschen_am, erledigt) VALUES (?, ?, ?, NULL)').run(iid, w.von.host, plusTage(this.iso(), FRISTEN.rueckfall_tage));
      this.setzeStatus(this.instanz(iid), 'aktiv', 'leitstand', `läuft jetzt auf ${STUFEN[nach]} (${zielHost.id})`);
      await this.setzeGrenzen(iid).catch(() => undefined);
      await this.bereitsteller.egress(iid, this.instanz(iid).ki.egress_freigaben).catch(() => undefined);
      const k = i.kunde_id ? this.kunde(i.kunde_id) : null;
      if (k) this.mail(`stufe:${iid}:${v.id}`, k.mail, `Ihre Instanz läuft jetzt auf: ${STUFEN[nach]}`, `Der Wechsel ist abgeschlossen und geprüft (gleiche Prüfsumme an beiden Orten). Adresse und Zugänge bleiben gleich.`, iid);
      await this.aktualisiereBetrieb(iid).catch(() => undefined);
      return { instanz: this.instanz(iid), vorgang: v };
    });
  }

  rueckfaelle(): { instanz_id: string; host: string; loeschen_am: string }[] {
    return this.db.prepare('SELECT instanz_id, host, loeschen_am FROM rueckfall WHERE erledigt IS NULL ORDER BY loeschen_am').all() as never;
  }

  // ---------- Egress-Freigaben (v1.4 3.6/3.7) ----------
  egressListe(iid: string) { return this.instanz(iid).ki.egress_freigaben; }
  async egressFreigeben(iid: string, host: string, grund: string, wer: string) {
    const h = host.trim().toLowerCase();
    if (!/^(?=.{4,200}$)([a-z0-9-]+\.)+[a-z]{2,}(:443)?$/.test(h)) throw new LeitstandFehler('ungueltig', 'Nur ein Hostname (optional :443), keine IP, kein Pfad');
    if (!grund.trim()) throw new LeitstandFehler('ungueltig', 'Grund fehlt');
    const i = this.instanz(iid);
    if (!i.ki.egress_freigaben.includes(h)) i.ki.egress_freigaben.push(h);
    this.speichereInstanz(i);
    await this.bereitsteller.egress(iid, i.ki.egress_freigaben);
    this.db.prepare("UPDATE egress_anfragen SET status = 'freigegeben' WHERE instanz_id = ? AND host = ? AND status = 'offen'").run(iid, h);
    this.ereignis(wer, 'egress_freigegeben', iid, { host: h, grund });
    return i.ki.egress_freigaben;
  }
  async egressEntziehen(iid: string, host: string, grund: string, wer: string) {
    const i = this.instanz(iid);
    i.ki.egress_freigaben = i.ki.egress_freigaben.filter((x) => x !== host);
    this.speichereInstanz(i);
    await this.bereitsteller.egress(iid, i.ki.egress_freigaben);
    this.ereignis(wer, 'egress_entzogen', iid, { host, grund });
    return i.ki.egress_freigaben;
  }
  egressAnfragen(offen = true): { id: number; instanz_id: string; host: string; zweck: string; am: string; status: string }[] {
    return this.db.prepare(`SELECT * FROM egress_anfragen ${offen ? "WHERE status = 'offen'" : ''} ORDER BY id DESC`).all() as never;
  }
  egressAblehnen(anfrage: number, wer: string) {
    const r = this.db.prepare('SELECT instanz_id, host FROM egress_anfragen WHERE id = ?').get(anfrage) as { instanz_id: string; host: string } | undefined;
    if (!r) throw new LeitstandFehler('nicht_gefunden', 'Anfrage nicht gefunden');
    this.db.prepare("UPDATE egress_anfragen SET status = 'abgelehnt' WHERE id = ?").run(anfrage);
    this.ereignis(wer, 'egress_abgelehnt', r.instanz_id, { host: r.host });
  }

  // ---------- Konto-Brücke: Aufrufe aus der Instanz (v1.4 3.5) ----------
  /** Nur Felder, die der Kunden-Admin ohnehin kennt. Keine Hosts, keine Partner, keine Notizen. */
  konto(iid: string) {
    const i = this.instanz(iid);
    const s = this.schalter();
    const p = this.pakete();
    const preise = s.kauf_offen ? Object.fromEntries((['klein', 'betrieb', 'team'] as Paket[]).map((pk) => [pk, { geteilt: preisCent(s, p, pk, 'geteilt', i.ki.weg === 'eigener_schluessel'), eigen: preisCent(s, p, pk, 'eigen', i.ki.weg === 'eigener_schluessel') }])) : null;
    return { status: i.status, paket: i.paket, stufe: i.stufe === 'eigen' ? 'eigene_maschine' : 'geteilt', test_ende: i.test_ende, loeschen_am: i.loeschen_am, kuendigung_zum: i.kuendigung_zum, test_selbst_verlaengert: i.test_selbst_verlaengert, preise, kauf_offen: s.kauf_offen };
  }
  async kontoKaufen(iid: string, e: { paket: Paket; stufe: 'geteilt' | 'eigene_maschine'; intervall: 'monat' | 'jahr' }) {
    const s = this.schalter();
    if (!s.kauf_offen) throw new LeitstandFehler('nicht_erlaubt', 'S-6: Kauf ist noch nicht geöffnet');
    if (!(e.paket in PAKETE)) throw new LeitstandFehler('ungueltig', 'Paket unbekannt');
    if (!this.mollie?.erstelleZahlung) throw new LeitstandFehler('intern', 'Mollie nicht eingerichtet');
    const i = this.instanz(iid);
    if (!['test', 'test_abgelaufen', 'nur_lesen', 'zahlung_offen'].includes(i.status)) throw new LeitstandFehler('konflikt', 'Kauf in diesem Zustand nicht nötig');
    const stufe: Stufe = e.stufe === 'eigene_maschine' ? 'eigen' : 'geteilt';
    const monat = preisCent(s, this.pakete(), e.paket, stufe, i.ki.weg === 'eigener_schluessel');
    const betrag = e.intervall === 'jahr' ? monat * 10 : monat; // G1: jährlich mit zwei Monaten Nachlass
    const k = i.kunde_id ? this.kunde(i.kunde_id) : null;
    const z = await this.mollie.erstelleZahlung({
      betrag_cent: betrag, beschreibung: `${s.produkt_name} ${PAKETE[e.paket]} (${STUFEN[stufe]}), ${e.intervall === 'jahr' ? 'Jahr' : 'Monat'}`,
      redirectUrl: `${i.url}/einstellungen/konto`, webhookUrl: `${this.oeffentlicheUrl}/v1/webhooks/mollie`, sequenceType: 'first',
      metadata: { instanz_id: iid, paket: e.paket, stufe, intervall: e.intervall }, ...(k?.mollie_customer_id ? { customerId: k.mollie_customer_id } : {}),
    });
    this.ereignis('konto', 'kauf_gestartet', iid, { paket: e.paket, stufe, intervall: e.intervall, zahlung: z.id });
    return { checkout_url: z.checkoutUrl };
  }
  async kontoStufe(iid: string, ziel: 'geteilt' | 'eigene_maschine') {
    const i = this.instanz(iid);
    const nach: Stufe = ziel === 'eigene_maschine' ? 'eigen' : 'geteilt';
    if (i.status !== 'aktiv') throw new LeitstandFehler('konflikt', 'Erst kaufen, dann Stufe wechseln (Test läuft immer geteilt)');
    const s = this.schalter();
    const aufpreis = preisCent(s, this.pakete(), i.paket, nach, false) > preisCent(s, this.pakete(), i.paket, i.stufe, false);
    if (aufpreis && i.zahlung === 'mollie') {
      if (!this.mollie?.erstelleZahlung) throw new LeitstandFehler('intern', 'Mollie nicht eingerichtet');
      const k = i.kunde_id ? this.kunde(i.kunde_id) : null;
      const z = await this.mollie.erstelleZahlung({ betrag_cent: s.preise.aufschlag_eigene_maschine, beschreibung: `${s.produkt_name}: Aufschlag Eigene Maschine (erster Monat)`, redirectUrl: `${i.url}/einstellungen/konto`, webhookUrl: `${this.oeffentlicheUrl}/v1/webhooks/mollie`, sequenceType: 'oneoff', metadata: { instanz_id: iid, stufe_wechsel: nach }, ...(k?.mollie_customer_id ? { customerId: k.mollie_customer_id } : {}) });
      this.ereignis('konto', 'stufe_zahlung_gestartet', iid, { nach, zahlung: z.id });
      return { vorgang: null, checkout_url: z.checkoutUrl };
    }
    const r = this.stufeWechselnNachts(iid, nach, 'konto');
    return { vorgang: null, geplant_ab: r.ab };
  }
  kontoKuendigen(iid: string, wer = 'konto') {
    const i = this.instanz(iid);
    if (i.status !== 'aktiv' && i.status !== 'zahlung_offen') throw new LeitstandFehler('konflikt', 'Keine laufende Buchung');
    const abo = this.abos().find((a) => a.kunde_id === i.kunde_id && a.status === 'active');
    const zum = abo?.naechste ? new Date(`${abo.naechste}T00:00:00Z`).toISOString() : plusTage(this.iso(), 30);
    i.kuendigung_zum = zum;
    this.speichereInstanz(i);
    this.ereignis(wer, 'gekuendigt', iid, { zum });
    if (i.kunde_id) { const k = this.kunde(i.kunde_id); this.mail(`kuendigung:${iid}:${zum}`, k.mail, 'Kündigung bestätigt', `Deine Buchung endet am ${this.datum(zum)}. Danach ist alles ${this.schalter().lesefrist_tage} Tage lesbar und herunterladbar.`, iid); }
    return { kuendigung_zum: zum };
  }
  kontoKuendigungZuruecknehmen(iid: string, wer = 'konto') {
    const i = this.instanz(iid);
    if (!i.kuendigung_zum) throw new LeitstandFehler('konflikt', 'Keine Kündigung offen');
    i.kuendigung_zum = null;
    this.speichereInstanz(i);
    this.ereignis(wer, 'kuendigung_zurueckgenommen', iid);
    return { kuendigung_zum: null };
  }
  /** Der Kunde selbst: einmal 14 Tage (M1, v1.4 W10). */
  kontoTestVerlaengern(iid: string) {
    const i = this.instanz(iid);
    if (i.test_selbst_verlaengert) throw new LeitstandFehler('konflikt', 'Die Testphase wurde schon einmal verlängert');
    if (i.status !== 'test' && i.status !== 'test_abgelaufen') throw new LeitstandFehler('konflikt', 'Keine Testphase');
    const n = this.testVerlaengern(iid, FRISTEN.kunde_verlaengern_tage, 'vom Kunden selbst (einmalig)', 'konto');
    n.test_selbst_verlaengert = true;
    this.speichereInstanz(n);
    return this.konto(iid);
  }
  /** Löschwunsch aus der Instanz: Bestätigungsmail mit Einmal-Link; der Klick gilt als Erklärung in Textform. */
  kontoLoeschen(iid: string, bestaetigung: string) {
    const i = this.instanz(iid);
    if (bestaetigung.trim() !== i.subdomain) throw new LeitstandFehler('ungueltig', 'Bestätigung stimmt nicht mit der Subdomain überein');
    const t = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO loesch_links (hash, instanz_id, bis) VALUES (?, ?, ?)').run(crypto.createHash('sha256').update(t).digest('hex'), iid, plusTage(this.iso(), 2));
    const k = i.kunde_id ? this.kunde(i.kunde_id) : null;
    if (k) this.mail(`loeschwunsch:${iid}:${this.iso()}`, k.mail, 'Löschung bestätigen', `Klicke diesen Link, um ${i.subdomain} endgültig zu löschen (48 Stunden gültig): ${this.oeffentlicheUrl}/v1/konto/loeschen/bestaetigen?t=${t}`, iid);
    this.ereignis('konto', 'loeschwunsch', iid);
    return { mail: k ? 'verschickt' : 'kein Konto' };
  }
  async kontoLoeschenBestaetigen(t: string) {
    const h = crypto.createHash('sha256').update(t).digest('hex');
    const r = this.db.prepare('SELECT instanz_id, bis, benutzt FROM loesch_links WHERE hash = ?').get(h) as { instanz_id: string; bis: string; benutzt: string | null } | undefined;
    if (!r || r.benutzt || new Date(r.bis) < this.jetzt()) throw new LeitstandFehler('nicht_erlaubt', 'Link ungültig oder abgelaufen');
    this.db.prepare('UPDATE loesch_links SET benutzt = ? WHERE hash = ?').run(this.iso(), h);
    const i = this.instanz(r.instanz_id);
    return this.loeschungPlanen(i.id, { bestaetigung: i.subdomain, grund: 'Kundenwunsch aus der Instanz', sofort: true, beleg: `Bestätigungslink aus Mail, geklickt ${this.iso()}` }, 'konto');
  }
  kontoEgressAnfrage(iid: string, host: string, zweck: string) {
    if (!host.trim() || !zweck.trim() || host.length > 200 || zweck.length > 300) throw new LeitstandFehler('ungueltig', 'Host und Zweck angeben');
    this.db.prepare('INSERT INTO egress_anfragen (instanz_id, host, zweck, am) VALUES (?, ?, ?, ?)').run(iid, host.trim().toLowerCase(), zweck.trim(), this.iso());
    this.ereignis('konto', 'egress_anfrage', iid, { host: host.trim().toLowerCase() });
    return { status: 'wartet auf Freigabe' };
  }

  // ---------- Pitch ----------
  /** Pitch in einem Schritt: Beispieldaten, Zeitlimit, automatische Aufräumung. */
  pitchAnlegen(e: { beispiel: Beispiel; tage?: number; fuer?: string; paket?: Paket; ki_vorlage?: KiVorlage }, wer: string, schluessel?: string) {
    const tage = e.tage ?? FRISTEN.demo_tage;
    if (tage < 1 || tage > 30) throw new LeitstandFehler('ungueltig', 'Pitch 1 bis 30 Tage');
    const sub = e.fuer ? `pitch-${e.fuer}` : `pitch-${e.beispiel.split('-')[1]}`;
    return this.instanzAnlegen({ herkunft: { art: 'pitch', ...(e.fuer ? { notiz: `für ${e.fuer}` } : {}) }, paket: e.paket ?? 'betrieb', beispiel: e.beispiel, test_tage: tage, subdomain: sub, ki_vorlage: e.ki_vorlage ?? 'mock' }, wer, schluessel);
  }

  // ---------- Partner ----------
  partnerOpt(code: string): Partner | null {
    const r = this.db.prepare('SELECT daten FROM partner WHERE code = ?').get(code) as { daten: string } | undefined;
    return r ? (JSON.parse(r.daten) as Partner) : null;
  }
  partnerListe(): Partner[] { return (this.db.prepare('SELECT daten FROM partner ORDER BY code').all() as { daten: string }[]).map((r) => JSON.parse(r.daten) as Partner); }
  partnerAnlegen(p: Omit<Partner, 'code'> & { code: string }, wer: string): Partner {
    const code = normalisiereCode(p.code);
    if (code.length < 3) throw new LeitstandFehler('ungueltig', 'Code: mindestens 3 Zeichen A–Z, 0–9, Bindestrich');
    if (this.partnerOpt(code)) throw new LeitstandFehler('konflikt', 'Code existiert bereits');
    if (!(p.provision_prozent >= 0 && p.provision_prozent <= 50)) throw new LeitstandFehler('ungueltig', 'Provision 0 bis 50 %');
    if (!(Number.isInteger(p.laufzeit_monate) && p.laufzeit_monate >= 0 && p.laufzeit_monate <= 36)) throw new LeitstandFehler('ungueltig', 'Laufzeit 0 bis 36 Monate');
    const neu: Partner = { ...p, code };
    this.db.prepare('INSERT INTO partner (code, daten) VALUES (?, ?)').run(code, JSON.stringify(neu));
    this.ereignis(wer, 'partner_angelegt', null, { code, art: p.art, provision_prozent: p.provision_prozent });
    return neu;
  }
  partnerAendern(code: string, patch: Partial<Omit<Partner, 'code'>>, wer: string): Partner {
    const p = this.partnerOpt(code);
    if (!p) throw new LeitstandFehler('nicht_gefunden', 'Partner nicht gefunden');
    const neu = { ...p, ...patch, code };
    this.db.prepare('UPDATE partner SET daten = ? WHERE code = ?').run(JSON.stringify(neu), code);
    this.ereignis(wer, 'partner_geaendert', null, { code, felder: Object.keys(patch) });
    return neu;
  }
  partnerZahlen(code: string) {
    const kunden = this.kunden().filter((k) => k.zuordnung?.code === code);
    const ids = new Set(kunden.map((k) => k.id));
    const inst = this.instanzen({ mitGeloeschten: true }).filter((i) => (i.kunde_id && ids.has(i.kunde_id)) || i.herkunft.empfehlungscode === code);
    return { kunden: kunden.length, tests: inst.filter((i) => i.status === 'test').length, aktiv: inst.filter((i) => i.status === 'aktiv').length, kaeufe: kunden.filter((k) => k.status === 'kunde').length };
  }

  /** Auszahlungsliste: je Partner, Monat, Zahlung die Provision. Ausgezahlt wird von Hand, hier nur vermerkt. */
  auszahlungsliste(): Auszahlungszeile[] {
    if (!this.schalter().partner_provisionen) return []; // v1.4 Abschnitt 17: keine Provisionen, außer Till schaltet es frei
    const zahlungen = this.zahlungen().filter((z) => z.status === 'paid' && z.kunde_id);
    const vermerkt = new Map((this.db.prepare('SELECT partner, monat, am FROM auszahlungen').all() as { partner: string; monat: string; am: string }[]).map((r) => [`${r.partner}|${r.monat}`, r.am]));
    const erste = new Map<string, string>();
    for (const z of [...zahlungen].sort((a, b) => a.am.localeCompare(b.am))) if (!erste.has(z.kunde_id!)) erste.set(z.kunde_id!, z.am);
    const out: Auszahlungszeile[] = [];
    for (const z of zahlungen) {
      const k = this.kunden().find((x) => x.id === z.kunde_id) ?? null;
      const p = k?.zuordnung ? this.partnerOpt(k.zuordnung.code) : null;
      const prov = provisionCent(z, k, p, erste.get(z.kunde_id!) ?? null);
      if (!prov || !p || !k) continue;
      const monat = z.am.slice(0, 7);
      const am = vermerkt.get(`${p.code}|${monat}`) ?? null;
      out.push({ partner: p.code, name: p.name, monat, kunde: k.firma, zahlung_id: z.id, betrag_cent: z.betrag_cent, provision_cent: prov, status: am ? 'ausgezahlt' : 'offen', ausgezahlt_am: am });
    }
    return out.sort((a, b) => b.monat.localeCompare(a.monat) || a.partner.localeCompare(b.partner));
  }
  auszahlungVermerken(code: string, monat: string, vermerk: string, wer: string) {
    if (!/^\d{4}-\d{2}$/.test(monat)) throw new LeitstandFehler('ungueltig', 'Monat JJJJ-MM');
    const zeilen = this.auszahlungsliste().filter((z) => z.partner === code && z.monat === monat);
    if (!zeilen.length) throw new LeitstandFehler('nicht_gefunden', 'Keine Provision in diesem Monat');
    const summe = zeilen.reduce((s, z) => s + z.provision_cent, 0);
    this.db.prepare('INSERT INTO auszahlungen (partner, monat, betrag_cent, am, von, vermerk) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(partner, monat) DO NOTHING').run(code, monat, summe, this.iso(), wer, vermerk || null);
    this.ereignis(wer, 'auszahlung_vermerkt', null, { code, monat, betrag_cent: summe });
    return summe;
  }

  // ---------- Mollie (nur lesend gespiegelt) ----------
  zahlungen(): Zahlung[] { return (this.db.prepare('SELECT daten FROM zahlungen').all() as { daten: string }[]).map((r) => JSON.parse(r.daten) as Zahlung).sort((a, b) => b.am.localeCompare(a.am)); }
  abos(): Abo[] { return (this.db.prepare('SELECT daten FROM abos').all() as { daten: string }[]).map((r) => JSON.parse(r.daten) as Abo); }

  /**
   * Mollie-Webhook. Holt die Zahlung über die API, spiegelt sie, und ruft für einen neuen Kauf denselben Vorgang
   * instanz_anlegen wie die Konsole. Idempotent über (Zahlungs-ID, Status) und den Schlüssel `mollie:<id>`.
   */
  async mollieWebhook(zahlungId: string): Promise<{ ergebnis: string }> {
    if (!this.mollie) throw new LeitstandFehler('intern', 'Mollie nicht eingerichtet');
    if (!/^tr_[A-Za-z0-9]{4,40}$/.test(zahlungId)) return { ergebnis: 'ignoriert: keine Zahlungs-ID' };
    const z = await this.mollie.holeZahlung(zahlungId);
    const gesehen = this.db.prepare('SELECT ergebnis FROM webhooks WHERE zahlung_id = ? AND status = ?').get(z.id, z.status) as { ergebnis: string } | undefined;
    if (gesehen) return { ergebnis: `wiederholt: ${gesehen.ergebnis}` };

    const meta = (z.metadata ?? {}) as Record<string, unknown>;
    let instanz: Instanz | null = null;
    const metaIid = typeof meta.instanz_id === 'string' ? meta.instanz_id : null;
    if (metaIid) { try { instanz = this.instanz(metaIid); } catch { instanz = null; } }
    if (!instanz && z.subscriptionId) instanz = this.instanzen().find((i) => this.zahlungen().some((x) => x.abo_id === z.subscriptionId && x.instanz_id === i.id)) ?? null;
    if (!instanz && z.customerId) {
      const k = this.kunden().find((x) => x.mollie_customer_id === z.customerId);
      if (k) instanz = this.instanzen({ kunde_id: k.id }).find((i) => i.status !== 'geloescht') ?? null;
    }

    let ergebnis = 'gespiegelt';
    if (z.status === 'paid') {
      if (instanz && (meta.stufe_wechsel === 'eigen' || meta.stufe_wechsel === 'geteilt') && instanz.status === 'aktiv') {
        // v1.4 3.5: Hochstufen mit Aufpreis erst nach bestätigter Zahlung
        const r = await this.stufeWechseln(instanz.id, meta.stufe_wechsel, 'mollie', `mollie-stufe:${z.id}`);
        ergebnis = r.vorgang.status === 'fertig' ? 'stufe_gewechselt' : 'stufenwechsel_fehler';
      } else if (instanz) {
        if (['test', 'test_abgelaufen', 'zahlung_offen', 'nur_lesen'].includes(instanz.status)) {
          // Kauf aus der Instanz: gewähltes Paket übernehmen, Daten bleiben (G1 T-9), Kunde mit Mollie verknüpfen
          if (typeof meta.paket === 'string' && meta.paket in PAKETE && meta.paket !== instanz.paket) { const n = this.instanz(instanz.id); n.paket = meta.paket as Paket; this.speichereInstanz(n); }
          if (instanz.kunde_id && z.customerId) { const k = this.kunde(instanz.kunde_id); if (!k.mollie_customer_id) this.speichereKunde({ ...k, mollie_customer_id: z.customerId }); }
          await this.aktivieren(instanz.id, 'mollie', z.id, 'mollie');
          ergebnis = 'aktiviert';
          if (meta.stufe === 'eigen') {
            const r = await this.stufeWechseln(instanz.id, 'eigen', 'mollie', `mollie-kauf-stufe:${z.id}`);
            ergebnis = r.vorgang.status === 'fertig' ? 'aktiviert, eigene Maschine' : 'aktiviert, Stufenwechsel gescheitert';
          }
          await this.setzeGrenzen(instanz.id).catch(() => undefined);
        }
      } else if (meta.kunde && typeof meta.paket === 'string') {
        const mk = meta.kunde as { firma?: string; name?: string; mail?: string };
        const r = await this.instanzAnlegen({
          kunde: {
            firma: String(mk.firma ?? ''), ansprechpartner: String(mk.name ?? ''), mail: String(mk.mail ?? ''), rechnungsweg: 'mollie', typ: 'selbstbucher',
            ...(z.customerId ? { mollie_customer_id: z.customerId } : {}), quelle: 'Mollie-Checkout',
            ...(typeof meta.empfehlungscode === 'string' ? { empfehlungscode: meta.empfehlungscode, zuordnung_weg: meta.code_weg === 'link' ? 'link' : 'checkout', zuordnung_zustimmung: meta.zuordnung_zustimmung === true } : {}),
          } as never,
          herkunft: { art: 'mollie', ...(typeof meta.empfehlungscode === 'string' && meta.zuordnung_zustimmung === true ? { empfehlungscode: normalisiereCode(meta.empfehlungscode) } : {}) },
          paket: meta.paket as Paket,
          zahlung: 'mollie',
          ...(meta.stufe === 'eigen' ? { stufe: 'eigen' as const } : {}),
          admin_mail: String(mk.mail ?? ''),
          ki_vorlage: typeof meta.ki_vorlage === 'string' && meta.ki_vorlage in KI_VORLAGEN ? (meta.ki_vorlage as KiVorlage) : 'mock',
        }, 'mollie', `mollie:${z.id}`);
        instanz = r.instanz;
        ergebnis = r.vorgang.status === 'fertig' ? 'angelegt' : 'anlage_fehler';
      } else ergebnis = 'bezahlt, keine Instanz zuordenbar';
    } else if (['failed', 'expired', 'canceled'].includes(z.status) && z.sequenceType === 'recurring' && instanz?.status === 'aktiv') {
      this.setzeStatus(instanz, 'zahlung_offen', 'mollie', `Abbuchung ${z.status}`);
      const n = this.instanz(instanz.id);
      n.kulanz_bis = plusTage(this.iso(), FRISTEN.kulanz_tage);
      this.speichereInstanz(n);
      instanz = n;
      ergebnis = 'zahlung_offen';
    }

    const kunde_id = instanz?.kunde_id ?? null;
    const zeile: Zahlung = {
      id: z.id, kunde_id, instanz_id: instanz?.id ?? null, abo_id: z.subscriptionId ?? null, betrag_cent: centAus(z.amount), waehrung: z.amount.currency,
      status: z.status, art: z.sequenceType ?? 'oneoff', am: z.paidAt ?? z.createdAt,
    };
    if (z.status === 'paid' && kunde_id && this.rechnungen) {
      try {
        const sch = this.schalter();
        const r = await this.rechnungen.entwurf({ kunde: this.kunde(kunde_id), zahlung_id: z.id, betrag_cent: zeile.betrag_cent, position: `${sch.produkt_name} ${instanz ? PAKETE[instanz.paket] : ''}`.trim(), festschreiben: sch.rechnung_stehende_freigabe });
        zeile.rechnung = { entwurf: r.id, ...(r.link ? { link: r.link } : {}), festgeschrieben: sch.rechnung_stehende_freigabe };
      } catch (e) { this.ereignis('leitstand', 'rechnung_fehler', instanz?.id ?? null, { zahlung: z.id, meldung: (e as Error).message.slice(0, 200) }); }
    }
    this.db.prepare('INSERT INTO zahlungen (id, daten) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten').run(z.id, JSON.stringify(zeile));
    if (z.subscriptionId && z.customerId) {
      try {
        const a = await this.mollie.holeAbo(z.customerId, z.subscriptionId);
        const abo: Abo = { id: a.id, kunde_id, status: a.status, betrag_cent: centAus(a.amount), intervall: a.interval, naechste: a.nextPaymentDate ?? null };
        this.db.prepare('INSERT INTO abos (id, daten) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET daten = excluded.daten').run(a.id, JSON.stringify(abo));
        // v1.4 W11: beendet Mollie das Abo bei offener Zahlung, sofort nur_lesen
        if (instanz && ['canceled', 'suspended', 'completed'].includes(a.status) && this.instanz(instanz.id).status === 'zahlung_offen') {
          this.setzeStatus(this.instanz(instanz.id), 'nur_lesen', 'mollie', `Abo von Mollie beendet (${a.status})`);
          await this.bereitsteller.modus(instanz.id, 'nur_lesen');
          ergebnis = 'nur_lesen';
        }
      } catch { /* Abo-Abruf ist Zusatz, Zahlung bleibt gespiegelt */ }
    }
    this.db.prepare('INSERT OR IGNORE INTO webhooks (zahlung_id, status, am, ergebnis) VALUES (?, ?, ?, ?)').run(z.id, z.status, this.iso(), ergebnis);
    this.ereignis('mollie', 'webhook', instanz?.id ?? null, { zahlung: z.id, status: z.status, ergebnis });
    return { ergebnis };
  }

  // ---------- Postausgang ----------
  mail(schluessel: string, an: string, betreff: string, text: string, instanz_id?: string) {
    if (!an) return;
    this.db.prepare('INSERT OR IGNORE INTO postausgang (schluessel, an, betreff, text, instanz_id, am) VALUES (?, ?, ?, ?, ?, ?)').run(schluessel, an, betreff, text, instanz_id ?? null, this.iso());
  }
  postausgang(): { id: number; an: string; betreff: string; am: string; status: string; instanz_id: string | null }[] {
    return this.db.prepare('SELECT id, an, betreff, am, status, instanz_id FROM postausgang ORDER BY id DESC LIMIT 100').all() as never;
  }
  private datum(iso: string | null) { return iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'; }

  // ---------- Planer ----------
  /** Täglicher Lauf. Tut, was ohne Till sicher ist; alles andere landet als Klick auf der Heute-Seite. */
  async planer(): Promise<{ automatisch: string[]; klick: { instanz_id: string; grund: string }[] }> {
    const automatisch: string[] = [];
    const klick: { instanz_id: string; grund: string }[] = [];
    for (const i0 of this.instanzen()) {
      let i = i0;
      try { i = await this.aktualisiereBetrieb(i.id); } catch { /* Status nicht abrufbar → Health bleibt */ }
      // Zwei Durchgänge: ein Statuswechsel (z. B. Test abgelaufen) löst im selben Lauf die Folgefrist aus.
      for (let durchgang = 0; durchgang < 2; durchgang++) {
      const statusVorher = i.status;
      for (const a of planerAbsicht(i, this.jetzt(), this.schalter().lesefrist_tage)) {
        if (durchgang === 1 && a.tun !== 'loeschung_ankuendigen') continue;
        const k = i.kunde_id ? this.kunde(i.kunde_id) : null;
        switch (a.tun) {
          case 'erinnern':
            if (k && a.art === 'test_endet') {
              const lf = this.schalter().lesefrist_tage;
              this.mail(`erinnerung:${i.id}:${a.tage}:${i.test_ende}`, k.mail, `Deine Testphase endet am ${this.datum(i.test_ende)}`,
                `Gleich gestaltete Knöpfe: Kaufen · ${i.test_selbst_verlaengert ? '' : 'Einmal 14 Tage verlängern · '}Alles herunterladen · Jetzt löschen. Wenn du nichts tust, wird nichts abgebucht. Danach ist alles ${lf} Tage nur lesbar, du kannst alles herunterladen, dann löschen wir und sagen vorher Bescheid.`, i.id);
              automatisch.push(`${i.subdomain}: Erinnerung ${a.tage} Tag(e) vor Testende vorgemerkt`);
            } else if (k && a.art === 'halbzeit') {
              this.mail(`halbzeit:${i.id}`, k.mail, 'Halbzeit', 'Halbzeit deiner Testphase. Deine Kontextbilanz zeigt, was schon drin ist und was als Nächstes hilft.', i.id);
              automatisch.push(`${i.subdomain}: Halbzeit-Mail vorgemerkt`);
            } else if (k && a.art === 'loeschung_bald') {
              this.mail(`loeschung:${i.id}:${i.loeschen_am}`, k.mail, `Löschung am ${this.datum(i.loeschen_am)}`, `Deine Instanz wird am ${this.datum(i.loeschen_am)} gelöscht. Bis dahin kannst du alles herunterladen.`, i.id);
              automatisch.push(`${i.subdomain}: Löschankündigung vorgemerkt`);
            }
            break;
          case 'status':
            this.setzeStatus(i, a.nach, 'planer', a.grund);
            await this.bereitsteller.modus(i.id, 'nur_lesen');
            if (k) {
              const am = plusTage(a.nach === 'test_abgelaufen' && i.test_ende ? i.test_ende : this.iso(), this.schalter().lesefrist_tage);
              this.mail(`statusende:${i.id}:${a.nach}:${i.test_ende ?? i.kuendigung_zum ?? i.kulanz_bis}`, k.mail, a.nach === 'test_abgelaufen' ? 'Testphase beendet' : 'Deine Instanz ist jetzt nur lesbar',
                `${a.grund}. Alles bleibt lesbar und herunterladbar bis ${this.datum(am)}, dann löschen wir und sagen vorher Bescheid.`, i.id);
            }
            automatisch.push(`${i.subdomain}: ${a.grund}, jetzt nur lesen`);
            i = this.instanz(i.id);
            break;
          case 'loeschung_ankuendigen': {
            i.loeschen_am = a.am;
            this.speichereInstanz(i);
            const ank = new Date(a.am).getTime() - FRISTEN.loeschung_ankuendigen_vor * 86_400_000;
            if (k && this.jetzt().getTime() >= ank) this.mail(`loeschung:${i.id}:${a.am}`, k.mail, 'Ankündigung: Löschung Ihrer Instanz', `Ihre Instanz wird am ${this.datum(a.am)} gelöscht. Bis dahin können Sie exportieren.`, i.id);
            this.ereignis('planer', 'loeschung_terminiert', i.id, { am: a.am });
            automatisch.push(`${i.subdomain}: Löschung zum ${this.datum(a.am)} terminiert`);
            break;
          }
          case 'loeschen':
            if (i.status !== 'loeschung_geplant') { this.setzeStatus(i, 'loeschung_geplant', 'planer', a.grund); }
            await this.loeschenAusfuehren(i.id, a.grund, 'planer');
            automatisch.push(`${i.subdomain}: gelöscht (${a.grund})`);
            break;
          case 'klick':
            klick.push({ instanz_id: i.id, grund: a.grund });
            break;
          default:
            break;
        }
      }
      i = this.instanz(i.id);
      if (i.status === statusVorher || i.status === 'geloescht') break;
      }
      // Termin in Status übersetzen: test_abgelaufen/nur_lesen mit erreichtem loeschen_am → loeschung_geplant
      const n = this.instanz(i.id);
      if ((n.status === 'test_abgelaufen' || n.status === 'nur_lesen' || n.status === 'umgezogen') && n.loeschen_am && new Date(n.loeschen_am) <= this.jetzt()) {
        this.setzeStatus(n, 'loeschung_geplant', 'planer', 'Frist erreicht');
        await this.loeschenAusfuehren(n.id, 'Frist erreicht', 'planer');
        automatisch.push(`${n.subdomain}: gelöscht (Frist erreicht)`);
      }
    }
    for (const g of this.geplanteWechsel()) {
      if (new Date(g.ab) > this.jetzt()) continue;
      try {
        const r = await this.stufeWechseln(g.instanz_id, g.nach, `planer (für ${g.von})`);
        if (r.vorgang.status === 'fertig') automatisch.push(`${r.instanz.subdomain}: nachts auf ${STUFEN[g.nach]} gewechselt`);
        else klick.push({ instanz_id: g.instanz_id, grund: 'Nächtlicher Stufenwechsel gescheitert und zurückgebaut' });
      } catch (e) {
        this.db.prepare('DELETE FROM geplante_wechsel WHERE instanz_id = ?').run(g.instanz_id);
        klick.push({ instanz_id: g.instanz_id, grund: `Stufenwechsel nicht möglich: ${(e as Error).message}` });
      }
    }
    for (const r of this.rueckfaelle()) {
      if (new Date(r.loeschen_am) > this.jetzt()) continue;
      const nachweis = await this.bereitsteller.altLoeschen(r.instanz_id, r.host);
      this.db.prepare('UPDATE rueckfall SET erledigt = ? WHERE instanz_id = ? AND host = ?').run(this.iso(), r.instanz_id, r.host);
      const h = this.hostOpt(r.host);
      if (h?.stufe === 'eigen' && h.instanz_id === r.instanz_id && this.instanz(r.instanz_id).host !== h.id) this.hostAendern(h.id, { aktiv: false }, 'planer');
      this.ereignis('planer', 'rueckfall_geloescht', r.instanz_id, { host: r.host, nachweis });
      automatisch.push(`${r.instanz_id}: alte Instanz auf ${r.host} gelöscht (Rückfallfrist vorbei)`);
    }
    this.ereignis('planer', 'planerlauf', null, { automatisch: automatisch.length, klick: klick.length });
    return { automatisch, klick };
  }

  // ---------- Heute ----------
  heute() {
    const jetzt = this.jetzt();
    const alle = this.instanzen();
    const kname = (i: Instanz) => (i.kunde_id ? this.kunde(i.kunde_id).firma : i.herkunft.notiz ?? 'Pitch');
    const klick: { instanz: Instanz; kunde: string; grund: string; aktion: string }[] = [];
    for (const i of alle) for (const a of planerAbsicht(i, jetzt)) if (a.tun === 'klick') klick.push({ instanz: i, kunde: kname(i), grund: a.grund, aktion: i.status === 'zahlung_offen' ? 'Kunde anrufen oder nur lesen schalten' : i.status === 'fehler' ? 'Vorgang wiederholen' : 'Prüfen' });
    for (const i of alle.filter((x) => x.status === 'zahlung_offen' && !(x.kulanz_bis && new Date(x.kulanz_bis) <= jetzt))) klick.push({ instanz: i, kunde: kname(i), grund: `Abbuchung fehlgeschlagen, Kulanz bis ${this.datum(i.kulanz_bis)}`, aktion: 'Mollie versucht erneut; bei Bedarf anrufen' });
    const tests = alle.filter((i) => i.status === 'test' && (tageBis(jetzt, i.test_ende) ?? 99) <= 7).map((i) => ({ instanz: i, kunde: kname(i), tage: tageBis(jetzt, i.test_ende) ?? 0 }));
    const pitches = alle.filter((i) => i.status === 'demo').map((i) => ({ instanz: i, kunde: kname(i), tage: tageBis(jetzt, i.test_ende) ?? 0 }));
    const umzuege = alle.filter((i) => i.status === 'umzug_laeuft' || i.status === 'umgezogen').map((i) => ({ instanz: i, kunde: kname(i) }));
    const loeschungen = alle.filter((i) => i.loeschen_am && ['loeschung_geplant', 'test_abgelaufen', 'nur_lesen', 'umgezogen'].includes(i.status)).map((i) => ({ instanz: i, kunde: kname(i), tage: tageBis(jetzt, i.loeschen_am) ?? 0 }));
    const offeneAuszahlungen = this.auszahlungsliste().filter((z) => z.status === 'offen');
    const fehlZahlungen = this.zahlungen().filter((z) => z.status === 'failed' && new Date(z.am).getTime() > jetzt.getTime() - 30 * 86_400_000);
    const je_status: Record<string, number> = {};
    for (const i of alle) je_status[i.status] = (je_status[i.status] ?? 0) + 1;
    return {
      klick, tests, pitches, umzuege, loeschungen, offeneAuszahlungen, fehlZahlungen, je_status,
      offene_vorgaenge: this.vorgaenge({ offen: true }).length,
      letzte: this.ereignisse({ seit: new Date(jetzt.getTime() - 86_400_000).toISOString(), limit: 12 }),
      mrr_cent: this.abos().filter((a) => a.status === 'active').reduce((s, a) => s + a.betrag_cent, 0),
    };
  }

  uebersicht() {
    const h = this.heute();
    return {
      je_status: h.je_status,
      tests_enden_7_tage: h.tests.length,
      backups_fehlgeschlagen: this.instanzen().filter((i) => !i.betrieb.backup_ok).length,
      speicher_frei_bytes: null as number | null,
      offene_vorgaenge: h.offene_vorgaenge,
    };
  }

  rechnungsUrl(k: Kunde): string | null {
    if (!this.rechnungLink || !k.rechnung_ref) return null;
    return this.rechnungLink.replace('{ref}', encodeURIComponent(k.rechnung_ref));
  }
}
