import { describe, expect, it } from 'vitest';
import {
  darfWechseln, normalisiereSubdomain, pruefeSubdomain, planerAbsicht, provisionCent, passtAufHost, stufeFuer, testSperre, auslastungStufe, startStatus, loeschDatum, FRISTEN, plusTage,
} from '../src/regeln.js';
import { nurBetriebsdaten } from '../src/bereitsteller/typ.js';
import { testEnde, naechsteNacht, kalenderTageBis } from '../src/regeln.js';
import type { Instanz } from '../src/typen.js';

describe('Zeiten Europe/Berlin', () => {
  it('Test endet am Tag 14 um 23:59 Berliner Zeit (Sommer- und Winterzeit)', () => {
    expect(testEnde(new Date('2026-10-01T08:00:00Z'), 14)).toBe('2026-10-15T21:59:00.000Z'); // MESZ
    expect(testEnde(new Date('2026-10-20T08:00:00Z'), 14)).toBe('2026-11-03T22:59:00.000Z'); // über die Umstellung am 25.10. in MEZ
  });
  it('nächste Nacht ist 02:00 Berliner Zeit', () => {
    expect(naechsteNacht(new Date('2026-10-20T10:00:00Z'))).toBe('2026-10-21T00:00:00.000Z');
    expect(naechsteNacht(new Date('2026-11-10T00:30:00Z'))).toBe('2026-11-10T01:00:00.000Z');
  });
  it('Kalendertage zählen Berliner Daten', () => {
    expect(kalenderTageBis(new Date('2026-10-11T21:30:00Z'), '2026-10-15T21:59:00.000Z')).toBe(4); // 23:30 Berlin am 11., Ende am 15.
  });
});

const basis = (p: Partial<Instanz>): Instanz => ({
  id: 'i_aaaaaaaaaa', kunde_id: 'k_1', subdomain: 'x', url: '', status: 'test', herkunft: { art: 'manuell' }, paket: 'klein', region: 'de-nbg', test_ende: null, loeschen_am: null,
  erstellt: '2026-10-01T00:00:00.000Z', geaendert: '', version: '0.1.0', betrieb: { modus: 'normal', ki_verbrauch_cent_monat: 0, ki_kontingent_cent_monat: null, zugaenge_oauth: 0, speicher_bytes: 0, benutzer: 0, letzte_anmeldung_tag: null, backup_letztes: null, backup_ok: true, health: 'ok' },
  ki_vorlage: 'mock', beispiel: null, vorher: null, zahlung: 'test', kulanz_bis: null, stufe: 'geteilt', host: 'geteilt-01',
  kuendigung_zum: null, test_selbst_verlaengert: false, ki: { weg: 'ohne', egress_freigaben: [] }, ...p,
});
const J = new Date('2026-10-24T08:00:00.000Z');

describe('Zustände', () => {
  it('erlaubt nur definierte Übergänge', () => {
    expect(darfWechseln('test', 'aktiv')).toBe(true);
    expect(darfWechseln('test', 'umzug_laeuft')).toBe(false);
    expect(darfWechseln('geloescht', 'aktiv')).toBe(false);
    expect(darfWechseln('demo', 'aktiv')).toBe(false); // erst übernehmen, Beispieldaten weg
    expect(darfWechseln('aktiv', 'wechsel_laeuft')).toBe(true);
    expect(darfWechseln('test', 'wechsel_laeuft')).toBe(false);
  });
  it('pausiert und Löschung kehren nur zum vorherigen Status zurück', () => {
    expect(darfWechseln('pausiert', 'aktiv', 'aktiv')).toBe(true);
    expect(darfWechseln('pausiert', 'aktiv', 'test')).toBe(false);
    expect(darfWechseln('loeschung_geplant', 'test_abgelaufen', 'test_abgelaufen')).toBe(true);
  });
  it('Startstatus: Pitch → demo, Test → test, Rechnung → aktiv', () => {
    expect(startStatus({ herkunft: { art: 'pitch' }, zahlung: 'frei', demo: true })).toBe('demo');
    expect(startStatus({ herkunft: { art: 'formular' }, zahlung: 'test', demo: false })).toBe('test');
    expect(startStatus({ herkunft: { art: 'manuell' }, zahlung: 'rechnung', demo: false })).toBe('aktiv');
  });
});

describe('Subdomain', () => {
  it('normalisiert Umlaute und Sonderzeichen', () => {
    expect(normalisiereSubdomain('Zimmerei Wiese & Söhne')).toBe('zimmerei-wiese-soehne');
    expect(normalisiereSubdomain('--Bäckerei  Groß--')).toBe('baeckerei-gross');
  });
  it('lehnt reservierte und ungültige Namen ab', () => {
    expect(() => pruefeSubdomain('admin')).toThrow();
    expect(() => pruefeSubdomain('ab')).toThrow();
    expect(() => pruefeSubdomain('-abc')).toThrow();
    expect(() => pruefeSubdomain('tischlerei-wendt')).not.toThrow();
  });
});

describe('Planer-Absichten', () => {
  it('erinnert 4 und 1 Tag vor Testende, sonst nicht', () => {
    expect(planerAbsicht(basis({ test_ende: plusTage(J.toISOString(), 4) }), J)).toEqual([{ tun: 'erinnern', art: 'test_endet', tage: 4 }]);
    expect(planerAbsicht(basis({ test_ende: plusTage(J.toISOString(), 1) }), J)).toEqual([{ tun: 'erinnern', art: 'test_endet', tage: 1 }]);
    expect(planerAbsicht(basis({ test_ende: plusTage(J.toISOString(), 3) }), J)).toEqual([]);
  });
  it('Testende → nur lesen; danach Löschung 30 Tage nach Testende', () => {
    const ende = plusTage(J.toISOString(), -1);
    expect(planerAbsicht(basis({ test_ende: ende }), J)[0]).toMatchObject({ tun: 'status', nach: 'test_abgelaufen' });
    expect(planerAbsicht(basis({ status: 'test_abgelaufen', test_ende: ende }), J)[0]).toEqual({ tun: 'loeschung_ankuendigen', am: plusTage(ende, FRISTEN.nur_lesen_bis_loeschung) });
  });
  it('Pitch wird nach Ablauf automatisch gelöscht', () => {
    expect(planerAbsicht(basis({ status: 'demo', kunde_id: null, test_ende: plusTage(J.toISOString(), -0.01) }), J)[0]).toMatchObject({ tun: 'loeschen' });
  });
  it('zahlende Kunden löscht der Planer nie selbst', () => {
    const r = planerAbsicht(basis({ status: 'loeschung_geplant', vorher: 'aktiv', loeschen_am: plusTage(J.toISOString(), -1) }), J);
    expect(r).toEqual([{ tun: 'klick', grund: expect.stringContaining('bestätigen') }]);
    const t = planerAbsicht(basis({ status: 'loeschung_geplant', vorher: 'test_abgelaufen', loeschen_am: plusTage(J.toISOString(), -1) }), J);
    expect(t[0]).toMatchObject({ tun: 'loeschen' });
  });
  it('Kulanzfrist vorbei → nur lesen (automatisch), kaputtes Backup braucht einen Klick', () => {
    expect(planerAbsicht(basis({ status: 'zahlung_offen', kulanz_bis: plusTage(J.toISOString(), -1) }), J)[0]).toMatchObject({ tun: 'status', nach: 'nur_lesen' }); // v1.4 W11
    expect(planerAbsicht(basis({ status: 'aktiv', betrieb: { ...basis({}).betrieb, backup_ok: false } }), J)).toEqual([{ tun: 'klick', grund: 'Letztes Backup fehlgeschlagen' }]);
  });
  it('Löschdatum: Demo sofort, nach Umzug 14 Tage, sonst 30', () => {
    const j = J.toISOString();
    expect(loeschDatum({ status: 'demo' }, j)).toBe(j);
    expect(loeschDatum({ status: 'umgezogen' }, j)).toBe(plusTage(j, 14));
    expect(loeschDatum({ status: 'aktiv' }, j)).toBe(plusTage(j, 30));
  });
});

describe('Provision', () => {
  const p = { code: 'ANNA', provision_prozent: 15, laufzeit_monate: 12, aktiv: true };
  it('nur mit Zuordnung (Zustimmung) und nur bezahlte Zahlungen', () => {
    expect(provisionCent({ betrag_cent: 12900, status: 'paid', am: '2026-10-01' }, { zuordnung: { code: 'ANNA', weg: 'link', zustimmung_am: '2026-10-01' } }, p, '2026-10-01')).toBe(1935);
    expect(provisionCent({ betrag_cent: 12900, status: 'paid', am: '2026-10-01' }, {}, p, '2026-10-01')).toBe(0);
    expect(provisionCent({ betrag_cent: 12900, status: 'failed', am: '2026-10-01' }, { zuordnung: { code: 'ANNA', weg: 'link', zustimmung_am: '' } }, p, null)).toBe(0);
  });
  it('endet nach der Laufzeit', () => {
    expect(provisionCent({ betrag_cent: 12900, status: 'paid', am: '2027-10-02' }, { zuordnung: { code: 'ANNA', weg: 'link', zustimmung_am: '' } }, p, '2026-10-01')).toBe(0);
  });
});

describe('Stufen und Kapazität', () => {
  it('Test, Demo und Pitch immer geteilt', () => {
    expect(stufeFuer('eigen', 'test', false)).toBe('geteilt');
    expect(stufeFuer('eigen', 'frei', true)).toBe('geteilt');
    expect(stufeFuer('eigen', 'rechnung', false)).toBe('eigen');
    expect(stufeFuer(undefined, 'rechnung', false)).toBe('geteilt');
  });
  it('Host-Grenzen: Container, RAM, Speicher', () => {
    const h = { aktiv: true, kapazitaet: { container_max: 2, ram_mb: 1000, speicher_bytes: 100 } };
    expect(passtAufHost(h, { container: 1, ram_mb: 300, speicher_bytes: 30 }, { ram_mb: 400, speicher_bytes: 40 }).passt).toBe(true); // genau 70 %
    expect(passtAufHost(h, { container: 1, ram_mb: 301, speicher_bytes: 0 }, { ram_mb: 400, speicher_bytes: 1 }).grund).toBe('RAM-Reservierung über 70 %');
    expect(passtAufHost(h, { container: 0, ram_mb: 0, speicher_bytes: 60 }, { ram_mb: 1, speicher_bytes: 11 }).grund).toBe('Platte über 70 %');
    expect(passtAufHost(h, { container: 2, ram_mb: 0, speicher_bytes: 0 }, { ram_mb: 1, speicher_bytes: 1 }).grund).toBe('Containergrenze erreicht');
    expect(passtAufHost({ ...h, aktiv: false }, { container: 0, ram_mb: 0, speicher_bytes: 0 }, { ram_mb: 1, speicher_bytes: 1 }).passt).toBe(false);
    expect([auslastungStufe(0.5), auslastungStufe(0.7), auslastungStufe(0.9)]).toEqual(['ok', 'warnung', 'voll']);
  });
  it('G1 T-2: ein Test je Firmen-Domain in 12 Monaten, Freemail je Adresse, 5 je Tag', () => {
    const j = new Date('2026-10-24T10:00:00Z');
    expect(testSperre('a@firma.example', [{ mail: 'b@firma.example', erstellt: '2026-03-01T00:00:00Z' }], j)).toMatch(/12 Monaten/);
    expect(testSperre('a@firma.example', [{ mail: 'b@firma.example', erstellt: '2025-09-01T00:00:00Z' }], j)).toBeNull();
    expect(testSperre('a@gmail.com', [{ mail: 'b@gmail.com', erstellt: '2026-10-01T00:00:00Z' }], j)).toBeNull();
    expect(testSperre('x@neu.example', Array.from({ length: 5 }, (_, n) => ({ mail: `${n}@d${n}.example`, erstellt: '2026-10-24T08:00:00Z' })), j)).toMatch(/5 neue Tests/);
  });
});

describe('Nur Betriebsdaten', () => {
  it('wirft Inhalte und Fremdfelder weg', () => {
    const r = nurBetriebsdaten({ speicher_bytes: 10, benutzer: 2, health: 'ok', version: '0.1.0', backup_ok: true, letzte_anmeldung_tag: '2026-10-23', backup_letztes: null,
      titel: 'Geheimes Mandat', dateien: ['wissen/x.md'], letzte_frage: 'Wer schuldet uns Geld?' } as never);
    expect(Object.keys(r).sort()).toEqual(['backup_letztes', 'backup_ok', 'benutzer', 'health', 'ki_kontingent_cent_monat', 'ki_verbrauch_cent_monat', 'letzte_anmeldung_tag', 'modus', 'speicher_bytes', 'version', 'zugaenge_oauth']);
    expect(JSON.stringify(r)).not.toMatch(/Mandat|wissen|Geld/);
  });
  it('nimmt bei der letzten Anmeldung nur ein Datum, keinen Namen', () => {
    expect(nurBetriebsdaten({ letzte_anmeldung_tag: 'Jörn Wendt 2026-10-23' } as never).letzte_anmeldung_tag).toBeNull();
    expect(nurBetriebsdaten({ version: '0.1.0; rm -rf' } as never).version).toBe('unbekannt');
  });
});
