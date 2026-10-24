/**
 * Schalter S-1 bis S-12 (CONTRACT v1.4 Abschnitt 16) und Paketwerte (3.1). Standard = Spalte „Standard bis zur Antwort“.
 * Gespeichert in `leitstand/schalter.json` und `leitstand/pakete.json` (bzw. DB-Tabelle `einstellungen`), änderbar in der
 * Konsole; jede Änderung landet im Prüfprotokoll. Alle Paketzahlen [Schätzung].
 */
import type { Paket, Stufe } from './typen.js';

export interface Schalter {
  /** S-1 Test-KI von HD im Test. */ test_ki: boolean;
  /** S-2 Domain für Kundeninstanzen; ohne Domain startet Managed nicht. */ managed_domain: string | null;
  /** S-3 Produktname. */ produkt_name: string;
  /** S-4 Preise öffentlich auf der Produktseite (wirkt auf der Website, hier nur gespeichert). */ preise_oeffentlich: boolean;
  /** S-5 Preise (Cent je Monat) und Aufschlag Eigene Maschine, Startwerte G1 N-2 ohne Freigabe. */
  preise: { geteilt: Record<Paket, number>; aufschlag_eigene_maschine: number; freigegeben: boolean };
  /** S-6 Kauf-Knopf offen. */ kauf_offen: boolean;
  /** S-6 Testformular offen. */ tests_offen: boolean;
  /** S-7 Abgrenzung Arbeitgeberfeld: Vorbedingung für S-6, kein Code, nur Vermerk. */ abgrenzung_vermerk: string | null;
  /** S-8 Neue Tests pausiert (ehrlicher Hinweis, keine Warteliste). */ neue_tests_pausiert: boolean;
  /** S-8 Zeitrahmen Managed in Stunden je Monat (Annahme). */ zeitrahmen_stunden_monat: number;
  /** S-9 Stehende Rechnungsfreigabe für feste Katalogpositionen. */ rechnung_stehende_freigabe: boolean;
  /** S-10 Leitstand öffentlich (Repo, kein Code). */ leitstand_oeffentlich: boolean;
  /** S-11 Lesephase nach Testende in Tagen. */ lesefrist_tage: number;
  /** S-12 Berufsgeheimnisträger im Managed-Betrieb. */ berufsgeheimnis_offen: boolean;
  /** Nicht im Vertrag (v1.4 Abschnitt 17 schließt Provisionen aus): Provisionsliste für Partner, nur auf Tills ausdrücklichen Wunsch. */
  partner_provisionen: boolean;
}

export const SCHALTER_STANDARD: Schalter = {
  test_ki: false,
  managed_domain: null,
  produkt_name: 'Kern',
  preise_oeffentlich: false,
  preise: { geteilt: { klein: 2900, betrieb: 6900, team: 13900 }, aufschlag_eigene_maschine: 9900, freigegeben: false }, // G1 N-2, P-11
  kauf_offen: false,
  tests_offen: false,
  abgrenzung_vermerk: null,
  neue_tests_pausiert: false,
  zeitrahmen_stunden_monat: 5,
  rechnung_stehende_freigabe: false,
  leitstand_oeffentlich: false,
  lesefrist_tage: 30,
  berufsgeheimnis_offen: false,
  partner_provisionen: false,
};

export const SCHALTER_TEXT: Record<keyof Schalter, { nr: string; text: string }> = {
  test_ki: { nr: 'S-1', text: 'Test-KI von HD im Test' },
  managed_domain: { nr: 'S-2', text: 'Domain für Kundeninstanzen' },
  produkt_name: { nr: 'S-3', text: 'Produktname' },
  preise_oeffentlich: { nr: 'S-4', text: 'Preise öffentlich auf der Produktseite' },
  preise: { nr: 'S-5', text: 'Preise und Aufschlag Eigene Maschine' },
  kauf_offen: { nr: 'S-6', text: 'Kauf-Knopf offen' },
  tests_offen: { nr: 'S-6', text: 'Testformular offen' },
  abgrenzung_vermerk: { nr: 'S-7', text: 'Abgrenzung zum Arbeitgeberfeld (Vermerk)' },
  neue_tests_pausiert: { nr: 'S-8', text: 'Neue Tests pausiert' },
  zeitrahmen_stunden_monat: { nr: 'S-8', text: 'Zeitrahmen Managed (Stunden je Monat)' },
  rechnung_stehende_freigabe: { nr: 'S-9', text: 'Stehende Rechnungsfreigabe' },
  leitstand_oeffentlich: { nr: 'S-10', text: 'Leitstand öffentlich unter AGPL' },
  lesefrist_tage: { nr: 'S-11', text: 'Lesephase nach Testende (Tage)' },
  berufsgeheimnis_offen: { nr: 'S-12', text: 'Berufsgeheimnisträger im Managed-Betrieb' },
  partner_provisionen: { nr: 'A1', text: 'Provisionsliste für Partner (außerhalb v1.4, Abschnitt 17)' },
};

/** Paketgrenzen je Stufe (CONTRACT v1.4 3.1). Speicher in Bytes, KI in Cent je Monat, RAM-Reservierung für die Platzwahl. */
export interface PaketWerte { nutzer: number; cpu: number; ram_mb: number; ram_reserviert_mb: number; prozesse: number; speicher_bytes: Record<Stufe, number>; upload_bytes: number; ki_cent: Record<Stufe, number> }
const GB = 1024 ** 3, MB = 1024 ** 2;
export const PAKETE_STANDARD: Record<Paket | 'test', PaketWerte> = {
  klein: { nutzer: 5, cpu: 1.0, ram_mb: 768, ram_reserviert_mb: 256, prozesse: 256, speicher_bytes: { geteilt: 5 * GB, eigen: 10 * GB }, upload_bytes: 50 * MB, ki_cent: { geteilt: 500, eigen: 1000 } },
  betrieb: { nutzer: 15, cpu: 1.5, ram_mb: 1024, ram_reserviert_mb: 384, prozesse: 256, speicher_bytes: { geteilt: 15 * GB, eigen: 25 * GB }, upload_bytes: 50 * MB, ki_cent: { geteilt: 1500, eigen: 2000 } },
  team: { nutzer: 50, cpu: 2.0, ram_mb: 1536, ram_reserviert_mb: 512, prozesse: 512, speicher_bytes: { geteilt: 40 * GB, eigen: 75 * GB }, upload_bytes: 100 * MB, ki_cent: { geteilt: 3000, eigen: 4000 } },
  test: { nutzer: 5, cpu: 1.0, ram_mb: 768, ram_reserviert_mb: 256, prozesse: 256, speicher_bytes: { geteilt: 5 * GB, eigen: 5 * GB }, upload_bytes: 50 * MB, ki_cent: { geteilt: 500, eigen: 500 } },
};

/** Grenzen, die der Leitstand per `/_betrieb/grenzen` in die Instanz schreibt. */
export function grenzenFuer(p: Record<Paket | 'test', PaketWerte>, paket: Paket, stufe: Stufe, imTest: boolean, s: Pick<Schalter, 'test_ki'>, kiWeg: 'hd_test' | 'eigener_schluessel' | 'app' | 'ohne') {
  const w = imTest ? p.test : p[paket];
  const ki = imTest ? (s.test_ki && kiWeg === 'hd_test' ? w.ki_cent[stufe] : null) : kiWeg === 'eigener_schluessel' || kiWeg === 'ohne' ? null : w.ki_cent[stufe];
  return {
    nutzer_max: w.nutzer,
    speicher_max_bytes: w.speicher_bytes[stufe],
    upload_max_bytes: w.upload_bytes,
    ki_kontingent_cent_monat: ki,
    ki_tagesdeckel_cent: ki === null ? null : Math.ceil(ki / 10),
  };
}

/** G1 P-11 und P-7: Eigene Maschine = Geteilt + fester Aufschlag; eigener KI-Schlüssel senkt um das Kontingent. */
export function preisCent(s: Schalter, p: Record<Paket | 'test', PaketWerte>, paket: Paket, stufe: Stufe, eigenerSchluessel: boolean): number {
  return s.preise.geteilt[paket] + (stufe === 'eigen' ? s.preise.aufschlag_eigene_maschine : 0) - (eigenerSchluessel ? p[paket].ki_cent[stufe] : 0);
}
