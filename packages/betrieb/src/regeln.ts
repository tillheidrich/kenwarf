/**
 * Ablaufregeln als reine Funktionen (ohne Datenbank, ohne Uhr). Getestet in test/regeln.test.ts.
 * Quelle der Fristen: O1 v14-betrieb.md 1.3 und 1.6. Abweichungen sind markiert.
 */
import type { Instanz, InstanzStatus, Kunde } from './typen.js';
import { LeitstandFehler } from './typen.js';

export const FRISTEN = {
  test_tage: 14,
  test_verlaengern_max: 30,
  /** v1.4 3.2: `demo` endet nach 30 Tagen, per Klick verlängerbar; in der Konsole 1 bis 30 wählbar. */
  demo_tage: 30,
  kulanz_tage: 14,
  /** Standard; maßgeblich ist Schalter S-11 `lesefrist_tage`. */
  nur_lesen_bis_loeschung: 30,
  /** v1.4 3.3: Halbzeit-Mail an Tag 7. */
  halbzeit_tag: 7,
  /** v1.4 3.1: neue Container nur, solange RAM-Reservierung und Platte unter 70 % liegen (W5). */
  belegung_max: 0.7,
  kunde_verlaengern_tage: 14,
  nach_umzug_bis_loeschung: 14,
  erinnerung_vor_testende: [4, 1],
  loeschung_ankuendigen_vor: 7,
  /** Nach einem Stufenwechsel bleibt die alte Instanz angehalten als Rückfallebene, dann löscht der Planer sie. */
  rueckfall_tage: 7,
  /** G1 T-2: höchstens ein Test je Mail-Domain in 12 Monaten, höchstens 5 neue Tests je Tag (Selbstbedienung). */
  tests_je_tag: 5,
} as const;

/** Welche Stufe eine neue Instanz bekommt: Test, Demo, Pitch immer geteilt. */
export function stufeFuer(wunsch: 'geteilt' | 'eigen' | undefined, zahlung: string, demo: boolean): 'geteilt' | 'eigen' {
  if (demo || zahlung === 'test') return 'geteilt';
  return wunsch ?? 'geteilt';
}

/**
 * Passt ein Container mit diesem Bedarf auf den Host? Belegung zählt den Speicher-Anspruch des Pakets (nicht die
 * tatsächliche Größe), damit ein wachsender Kunde nicht einen vollen Host überraschend sprengt.
 */
export function passtAufHost(
  host: { kapazitaet: { container_max: number; speicher_bytes: number; ram_mb: number }; aktiv: boolean },
  belegt: { container: number; speicher_bytes: number; ram_mb: number },
  bedarf: { ram_mb: number; speicher_bytes: number },
): { passt: boolean; grund?: string } {
  if (!host.aktiv) return { passt: false, grund: 'Host nimmt keine neuen Container' };
  if (belegt.container + 1 > host.kapazitaet.container_max) return { passt: false, grund: 'Containergrenze erreicht' };
  if (belegt.ram_mb + bedarf.ram_mb > host.kapazitaet.ram_mb * FRISTEN.belegung_max) return { passt: false, grund: 'RAM-Reservierung über 70 %' };
  if (belegt.speicher_bytes + bedarf.speicher_bytes > host.kapazitaet.speicher_bytes * FRISTEN.belegung_max) return { passt: false, grund: 'Platte über 70 %' };
  return { passt: true };
}

/** Ampel für die Auslastung: ab 70 % gelb, ab 85 % rot (Planungsreserve für Wachstum und Backups) [Annahme]. */
export function auslastungStufe(anteil: number): 'ok' | 'warnung' | 'voll' {
  return anteil >= 0.85 ? 'voll' : anteil >= 0.7 ? 'warnung' : 'ok';
}

/** G1 T-2: Selbstbedienungs-Tests begrenzen. Liefert null, wenn erlaubt, sonst den Grund. */
export function testSperre(mail: string, bisher: { mail: string; erstellt: string }[], jetzt: Date): string | null {
  const domain = mail.split('@')[1]?.toLowerCase() ?? '';
  const frei = ['gmail.com', 'gmx.de', 'gmx.net', 'web.de', 'outlook.com', 'hotmail.com', 'yahoo.com', 't-online.de', 'icloud.com', 'posteo.de', 'mailbox.org'];
  const jahr = jetzt.getTime() - 365 * 86_400_000;
  const heute = jetzt.toISOString().slice(0, 10);
  if (bisher.filter((b) => b.erstellt.slice(0, 10) === heute).length >= FRISTEN.tests_je_tag) return 'Heute schon 5 neue Tests, bitte morgen oder von Hand anlegen';
  const gleich = (b: { mail: string }) => (frei.includes(domain) ? b.mail.toLowerCase() === mail.toLowerCase() : b.mail.split('@')[1]?.toLowerCase() === domain);
  if (bisher.some((b) => gleich(b) && new Date(b.erstellt).getTime() > jahr)) return 'Für diese Firma lief in den letzten 12 Monaten schon ein Test';
  return null;
}

/** Erlaubte Übergänge (O1 1.3). `pausiert` und `loeschung_geplant` kehren über `vorher` zurück. */
const UEBERGAENGE: Record<InstanzStatus, InstanzStatus[]> = {
  angelegt: ['test', 'aktiv', 'demo', 'fehler'],
  test: ['aktiv', 'test_abgelaufen', 'pausiert', 'loeschung_geplant'],
  demo: ['test', 'loeschung_geplant', 'pausiert'],
  aktiv: ['pausiert', 'zahlung_offen', 'umzug_laeuft', 'loeschung_geplant', 'nur_lesen', 'wechsel_laeuft'],
  wechsel_laeuft: ['aktiv'],
  zahlung_offen: ['aktiv', 'nur_lesen', 'pausiert', 'loeschung_geplant'],
  test_abgelaufen: ['aktiv', 'loeschung_geplant', 'test'],
  nur_lesen: ['aktiv', 'loeschung_geplant'],
  pausiert: [], // zurück nur zu `vorher`
  umzug_laeuft: ['umgezogen', 'aktiv'],
  umgezogen: ['loeschung_geplant'],
  loeschung_geplant: ['geloescht'], // Abbruch zurück zu `vorher`
  geloescht: [],
  fehler: ['angelegt'],
};

export function darfWechseln(von: InstanzStatus, nach: InstanzStatus, vorher: InstanzStatus | null = null): boolean {
  if ((von === 'pausiert' || von === 'loeschung_geplant') && vorher && nach === vorher) return true;
  return UEBERGAENGE[von].includes(nach);
}

export function pruefeWechsel(von: InstanzStatus, nach: InstanzStatus, vorher: InstanzStatus | null = null): void {
  if (!darfWechseln(von, nach, vorher)) throw new LeitstandFehler('konflikt', `Statuswechsel ${von} → ${nach} ist nicht erlaubt`);
}

/** Stunde und Datum in Europe/Berlin. */
function berlin(d: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t: string) => Number(f.find((x) => x.type === t)?.value);
  return { j: g('year'), m: g('month'), t: g('day'), h: g('hour'), min: g('minute') };
}
/** UTC-Zeitpunkt für eine Berliner Uhrzeit an einem Berliner Kalendertag (Sommer- und Winterzeit). */
function berlinZeitpunkt(j: number, m: number, t: number, h: number, min: number): Date {
  const roh = Date.UTC(j, m - 1, t, h, min);
  for (const off of [1, 2]) {
    const d = new Date(roh - off * 3600_000);
    const b = berlin(d);
    if (b.h === h && b.min === min && b.t === t) return d;
  }
  return new Date(roh - 3600_000);
}
/** v1.4 3.2: Test endet am Tag 14 um 23:59 Europe/Berlin. */
export function testEnde(start: Date, tage: number): string {
  const b = berlin(start);
  const tag = new Date(Date.UTC(b.j, b.m - 1, b.t + tage));
  return berlinZeitpunkt(tag.getUTCFullYear(), tag.getUTCMonth() + 1, tag.getUTCDate(), 23, 59).toISOString();
}
/** Nächster Zeitpunkt 02:00 Europe/Berlin (Stufenwechsel „nacht“). */
export function naechsteNacht(jetzt: Date): string {
  const b = berlin(jetzt);
  let z = berlinZeitpunkt(b.j, b.m, b.t, 2, 0);
  if (z <= jetzt) { const d = new Date(Date.UTC(b.j, b.m - 1, b.t + 1)); z = berlinZeitpunkt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 2, 0); }
  return z.toISOString();
}

/** Kalendertage in Europe/Berlin zwischen heute und dem Datum (für Mails „Tag 10 und 13“). */
export function kalenderTageBis(jetzt: Date, iso: string | null): number | null {
  if (!iso) return null;
  const a = berlin(jetzt), b = berlin(new Date(iso));
  return Math.round((Date.UTC(b.j, b.m - 1, b.t) - Date.UTC(a.j, a.m - 1, a.t)) / 86_400_000);
}

export function plusTage(isoDatum: string, tage: number): string {
  const d = new Date(isoDatum);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString();
}

export function tageBis(jetzt: Date, iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - jetzt.getTime()) / 86_400_000);
}

/** Subdomain: klein, a–z, 0–9, Bindestrich, 3–40 Zeichen, keine reservierten Namen. */
const RESERVIERT = new Set(['www', 'admin', 'api', 'konsole', 'leitstand', 'mail', 'status', 'demo', 'test', 'app', 'login', 'kern', 'betrieb']);
export function normalisiereSubdomain(roh: string): string {
  return roh
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
}
export function pruefeSubdomain(s: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s)) throw new LeitstandFehler('ungueltig', 'Subdomain: 3–40 Zeichen, a–z, 0–9, Bindestrich');
  if (RESERVIERT.has(s)) throw new LeitstandFehler('ungueltig', `Subdomain „${s}“ ist reserviert`);
}

/** Welcher Startstatus ergibt sich aus Herkunft und Zahlung? */
export function startStatus(e: { herkunft: Instanz['herkunft']; zahlung: Instanz['zahlung']; demo: boolean }): InstanzStatus {
  if (e.demo || e.herkunft.art === 'pitch') return 'demo';
  if (e.zahlung === 'test') return 'test';
  return 'aktiv';
}

/** Löschfrist, wenn Till ohne `sofort` löscht (O1: 30 Tage Test/nur lesen, 14 Tage nach Umzug, Demo sofort). */
export function loeschDatum(i: Pick<Instanz, 'status'>, jetztIso: string, lesefrist: number = FRISTEN.nur_lesen_bis_loeschung): string {
  if (i.status === 'demo') return jetztIso;
  if (i.status === 'umgezogen') return plusTage(jetztIso, FRISTEN.nach_umzug_bis_loeschung);
  return plusTage(jetztIso, lesefrist);
}

/**
 * Was der tägliche Planer mit einer Instanz tut. Rein: liefert nur die Absicht, der Leitstand führt aus.
 * Ergebnis „klick“ heißt: nichts automatisch, Till muss entscheiden (taucht auf der Heute-Seite auf).
 */
export type PlanerAbsicht =
  | { tun: 'nichts' }
  | { tun: 'erinnern'; art: 'test_endet' | 'halbzeit' | 'loeschung_bald'; tage: number }
  | { tun: 'status'; nach: InstanzStatus; grund: string }
  | { tun: 'loeschung_ankuendigen'; am: string }
  | { tun: 'loeschen'; grund: string }
  | { tun: 'klick'; grund: string };

export function planerAbsicht(i: Instanz, jetzt: Date, lesefrist: number = FRISTEN.nur_lesen_bis_loeschung): PlanerAbsicht[] {
  const jetztIso = jetzt.toISOString();
  const out: PlanerAbsicht[] = [];
  const tTest = tageBis(jetzt, i.test_ende);
  const tLoesch = tageBis(jetzt, i.loeschen_am);
  // v1.4 3.3: Ankündigung der Löschung 7 Tage vorher (Testende + 23 bei 30 Tagen Lesefrist)
  if (i.loeschen_am && tLoesch === FRISTEN.loeschung_ankuendigen_vor && ['test_abgelaufen', 'nur_lesen', 'umgezogen', 'loeschung_geplant'].includes(i.status)) out.push({ tun: 'erinnern', art: 'loeschung_bald', tage: tLoesch });
  switch (i.status) {
    case 'test': {
      if (tTest !== null && new Date(i.test_ende!) <= jetzt) { out.push({ tun: 'status', nach: 'test_abgelaufen', grund: 'Testphase beendet' }); break; }
      const kTest = kalenderTageBis(jetzt, i.test_ende);
      if (kTest !== null && (FRISTEN.erinnerung_vor_testende as readonly number[]).includes(kTest)) out.push({ tun: 'erinnern', art: 'test_endet', tage: kTest });
      const tagSeitStart = -(kalenderTageBis(jetzt, i.erstellt) ?? 0);
      if (tagSeitStart === FRISTEN.halbzeit_tag && !i.test_selbst_verlaengert) out.push({ tun: 'erinnern', art: 'halbzeit', tage: tagSeitStart });
      break;
    }
    case 'demo':
      if (i.test_ende && new Date(i.test_ende) <= jetzt) out.push({ tun: 'loeschen', grund: 'Pitch-Zeit abgelaufen (automatische Aufräumung)' });
      break;
    case 'test_abgelaufen':
    case 'nur_lesen': {
      if (!i.loeschen_am) {
        const basis = i.status === 'test_abgelaufen' && i.test_ende ? i.test_ende : jetztIso;
        out.push({ tun: 'loeschung_ankuendigen', am: plusTage(basis, lesefrist) });
      }
      break;
    }
    case 'aktiv':
      // v1.4 3.2: gekündigt = aktiv mit kuendigung_zum; zum Datum nach nur_lesen
      if (i.kuendigung_zum && new Date(i.kuendigung_zum) <= jetzt) out.push({ tun: 'status', nach: 'nur_lesen', grund: 'Kündigung wirksam' });
      break;
    case 'umgezogen':
      if (!i.loeschen_am) out.push({ tun: 'loeschung_ankuendigen', am: plusTage(jetztIso, FRISTEN.nach_umzug_bis_loeschung) });
      break;
    case 'loeschung_geplant':
      if (i.loeschen_am && new Date(i.loeschen_am) <= jetzt) {
        // Von Till geplante Löschung eines zahlenden Kunden nie ohne Klick.
        if (i.vorher === 'aktiv' || i.vorher === 'zahlung_offen') out.push({ tun: 'klick', grund: 'Löschtermin erreicht, Kunde hat bezahlt: bitte bestätigen' });
        else out.push({ tun: 'loeschen', grund: 'Löschfrist erreicht' });
      }
      break;
    case 'zahlung_offen':
      // v1.4 W11: Kulanz 14 Tage oder Abo-Ende durch Mollie, was zuerst eintritt, dann nur_lesen (automatisch)
      if (i.kulanz_bis && new Date(i.kulanz_bis) <= jetzt) out.push({ tun: 'status', nach: 'nur_lesen', grund: 'Kulanzfrist vorbei' });
      break;
    case 'fehler':
      out.push({ tun: 'klick', grund: 'Vorgang gescheitert: wiederholen oder prüfen' });
      break;
    default:
      break;
  }
  if (!['geloescht', 'angelegt', 'pausiert'].includes(i.status) && i.betrieb.health !== 'ok') out.push({ tun: 'klick', grund: `Health: ${i.betrieb.health}` });
  if (['aktiv', 'test', 'zahlung_offen'].includes(i.status) && !i.betrieb.backup_ok) out.push({ tun: 'klick', grund: 'Letztes Backup fehlgeschlagen' });
  return out;
}

/** Provision einer Zahlung, wenn das Konto einem Partnercode zugeordnet ist (mit Zustimmung) und die Laufzeit noch läuft. */
export function provisionCent(
  z: { betrag_cent: number; status: string; am: string },
  kunde: Pick<Kunde, 'zuordnung'> | null,
  partner: { code: string; provision_prozent: number; laufzeit_monate: number; aktiv: boolean } | null,
  ersteZahlungAm: string | null,
): number {
  if (!kunde?.zuordnung || !partner || z.status !== 'paid') return 0;
  if (kunde.zuordnung.code !== partner.code) return 0;
  if (ersteZahlungAm) {
    const ende = new Date(ersteZahlungAm);
    ende.setUTCMonth(ende.getUTCMonth() + partner.laufzeit_monate);
    if (new Date(z.am) >= ende) return 0;
  }
  return Math.round((z.betrag_cent * partner.provision_prozent) / 100);
}

/** Empfehlungscode: Großbuchstaben, Ziffern, Bindestrich, 3–32 Zeichen. */
export function normalisiereCode(roh: string): string {
  return roh.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
}
