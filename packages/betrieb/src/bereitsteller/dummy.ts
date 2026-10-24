/**
 * Dummy-Bereitsteller: hält alles im Speicher. Für Tests und für die Vorführung der Konsole ohne Docker.
 * Fehler lassen sich gezielt auslösen (`fehlerBei`), damit Wiederholung und Fehlerzustand prüfbar sind.
 */
import crypto from 'node:crypto';
import type { Auftrag, Bereitsteller, Modus, StatusAntwort, Wechselauftrag } from './typ.js';
import { STANDARD_SCHRITTE, WECHSEL_SCHRITTE } from './typ.js';
import type { Beispiel } from '../typen.js';

interface Eintrag { grenzen?: import('./typ.js').Grenzen; egress: string[]; konto_token: string; host: string; a: Auftrag; modus: Modus; status: StatusAntwort; beispiel: Beispiel | null; einladungen: string[] }

export class DummyBereitsteller implements Bereitsteller {
  readonly name = 'dummy';
  readonly schritte = STANDARD_SCHRITTE;
  readonly wechselSchritte = WECHSEL_SCHRITTE;
  /** Wechselziele (Kopie der Daten auf dem neuen Host), Schlüssel Instanz-ID. */
  readonly ziele = new Map<string, { host: string; bytes: number }>();
  angehalten: string[] = [];
  /** Für Tests: die Prüfsumme am Ziel weicht ab. */
  pruefsummeFalsch = false;
  readonly instanzen = new Map<string, Eintrag>();
  /** Schrittname → wie oft er noch scheitern soll. */
  fehlerBei = new Map<string, number>();
  aufrufe: string[] = [];

  constructor(private domain = 'kern.example') {}

  async schritt(name: string, a: Auftrag) {
    this.aufrufe.push(`${name}:${a.id}`);
    const rest = this.fehlerBei.get(name) ?? 0;
    if (rest > 0) {
      this.fehlerBei.set(name, rest - 1);
      throw new Error(`Dummy: ${name} gescheitert`);
    }
    const e = this.instanzen.get(a.id);
    switch (name) {
      case 'volume_anlegen':
        if (!e) this.instanzen.set(a.id, { egress: [], konto_token: a.konto_token, host: a.host, a, modus: 'normal', beispiel: null, einladungen: [], status: { version: '0.1.0', modus: 'normal', ki_verbrauch_cent_monat: 0, ki_kontingent_cent_monat: null, zugaenge_oauth: 0, speicher_bytes: 48_213, benutzer: 0, letzte_anmeldung_tag: null, backup_letztes: null, backup_ok: true, health: 'ok' } });
        return {};
      case 'container_starten':
        return { url: `https://${a.subdomain}.${this.domain}`, version: '0.1.0' };
      case 'admin_einladen':
        if (a.admin_mail && e) { e.einladungen.push(a.admin_mail); e.status.benutzer = Math.max(1, e.status.benutzer); }
        return a.admin_mail ? { meldung: 'Einladung verschickt' } : { meldung: 'keine Mail angegeben' };
      case 'beispiel_laden':
        if (!a.beispiel) return { meldung: 'übersprungen' };
        if (e) { e.beispiel = a.beispiel; e.status.speicher_bytes += 1_204_771; e.status.benutzer = 5; }
        return { meldung: `Beispiel ${a.beispiel} geladen` };
      default:
        return {};
    }
  }

  private hole(id: string) {
    const e = this.instanzen.get(id);
    if (!e) throw new Error(`Dummy: Instanz ${id} unbekannt`);
    return e;
  }

  async status(id: string) { const e = this.hole(id); return { ...e.status, modus: e.modus, ki_kontingent_cent_monat: e.grenzen?.ki_kontingent_cent_monat ?? null }; }
  async modus(id: string, m: Modus) { this.hole(id).modus = m; }
  async grenzen(id: string, g: import('./typ.js').Grenzen) { this.hole(id).grenzen = g; }
  async egress(id: string, hosts: string[]) { this.hole(id).egress = [...hosts]; }
  async export(id: string, art: 'umzugspaket' | 'okf') {
    const e = this.hole(id);
    return { bytes: e.status.speicher_bytes, sha256: crypto.createHash('sha256').update(`${id}:${art}:${e.status.speicher_bytes}`).digest('hex') };
  }
  async beispiel(id: string, aktion: 'laden' | 'entfernen', satz: Beispiel | null) { this.hole(id).beispiel = aktion === 'laden' ? satz : null; }
  async einladung(id: string, mail: string) { this.hole(id).einladungen.push(mail); }
  async loeschen(id: string) {
    const war = this.instanzen.delete(id);
    return war ? ['Container', 'Volume', 'Instanzschlüssel'] : ['nichts mehr vorhanden'];
  }

  async wechselSchritt(name: string, w: Wechselauftrag): Promise<{ meldung?: string; ergebnis?: Record<string, string | number> }> {
    this.aufrufe.push(`${name}:${w.id}`);
    const rest = this.fehlerBei.get(name) ?? 0;
    if (rest > 0) { this.fehlerBei.set(name, rest - 1); throw new Error(`Dummy: ${name} gescheitert`); }
    const e = this.hole(w.id);
    switch (name) {
      case 'ziel_bereitstellen': return { meldung: w.nach.stufe === 'eigen' ? `Maschine ${w.nach.host} angelegt (${w.region})` : `Container auf ${w.nach.host} reserviert` };
      case 'alt_nur_lesen': e.modus = 'nur_lesen'; return {};
      case 'paket_bauen': return { ergebnis: { bytes: e.status.speicher_bytes } };
      case 'uebertragen': this.ziele.set(w.id, { host: w.nach.host, bytes: e.status.speicher_bytes }); return {};
      case 'einspielen': return { meldung: 'kern import ok' };
      case 'pruefen': {
        const alt = crypto.createHash('sha256').update(`${w.id}:${e.status.speicher_bytes}`).digest('hex');
        const z = this.ziele.get(w.id);
        const neu = this.pruefsummeFalsch ? 'f'.repeat(64) : crypto.createHash('sha256').update(`${w.id}:${z?.bytes ?? -1}`).digest('hex');
        return { ergebnis: { alt, neu } };
      }
      case 'umschalten': e.host = w.nach.host; e.modus = 'normal'; this.ziele.delete(w.id); return { meldung: `Route ${w.subdomain} → ${w.nach.host}` };
      case 'alt_anhalten': this.angehalten.push(`${w.id}@${w.von.host}`); return {};
      default: return {};
    }
  }
  async wechselRueckbau(w: Wechselauftrag) { this.ziele.delete(w.id); const e = this.instanzen.get(w.id); if (e) e.modus = 'normal'; this.aufrufe.push(`rueckbau:${w.id}`); }
  async altLoeschen(id: string, host: string) { this.angehalten = this.angehalten.filter((x) => x !== `${id}@${host}`); return [`alter Container auf ${host}`, 'altes Volume']; }
  async hostLast(host: string) {
    const auf = [...this.instanzen.values()].filter((e) => e.host === host);
    return auf.length ? { container: auf.length, speicher_belegt: auf.reduce((s, e) => s + e.status.speicher_bytes, 0), quelle: 'gemessen' as const } : null;
  }

  /** Nur für Vorführung und Tests: Betriebswerte setzen. */
  setzeStatus(id: string, s: Partial<StatusAntwort>) { Object.assign(this.hole(id).status, s); }
}
