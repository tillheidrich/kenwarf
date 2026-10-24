import { describe, expect, it } from 'vitest';
import { aufbau, konto, TAG } from './hilfe.js';
import type { MollieZahlung } from '../src/mollie.js';

const zahlung = (p: Partial<MollieZahlung> & { id: string }): MollieZahlung => ({ status: 'paid', amount: { value: '129.00', currency: 'EUR' }, sequenceType: 'first', createdAt: '2026-10-01T08:00:00.000Z', paidAt: '2026-10-01T08:00:00.000Z', metadata: null, ...p });

describe('Ein Ablauf für alle Herkünfte', () => {
  it('Handanlage und Mollie-Kauf durchlaufen dieselben Schritte', async () => {
    const { l, m } = aufbau();
    const k = konto(l);
    const hand = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'betrieb', zahlung: 'rechnung' }, 'till');
    m.zahlungen.set('tr_abcd1234', zahlung({ id: 'tr_abcd1234', customerId: 'cst_x1', metadata: { kunde: { firma: 'Elektro Tamsen', name: 'Hauke', mail: 'h@tamsen.example' }, paket: 'betrieb' } }));
    await l.mollieWebhook('tr_abcd1234');
    const mollie = l.instanzen({ herkunft: 'mollie' })[0]!;
    const sh = l.vorgaenge({ instanz_id: hand.instanz.id })[0]!.schritte.map((s) => s.name);
    const sm = l.vorgaenge({ instanz_id: mollie.id })[0]!.schritte.map((s) => s.name);
    expect(sm).toEqual(sh);
    expect(hand.instanz.status).toBe('aktiv');
    expect(mollie.status).toBe('aktiv');
    expect(l.kunde(mollie.kunde_id!).typ).toBe('selbstbucher');
  });

  it('ist idempotent: gleicher Schlüssel legt nichts doppelt an', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const e = { kunde_id: k.id, herkunft: { art: 'manuell' as const }, paket: 'klein' as const };
    const a = await l.instanzAnlegen(e, 'till', 'formular-123');
    const b = await l.instanzAnlegen(e, 'till', 'formular-123');
    expect(b.instanz.id).toBe(a.instanz.id);
    expect(l.instanzen()).toHaveLength(1);
  });

  it('Mollie-Webhook doppelt zugestellt: eine Instanz, ein Abruf je Status', async () => {
    const { l, m } = aufbau();
    m.zahlungen.set('tr_dopp1234', zahlung({ id: 'tr_dopp1234', metadata: { kunde: { firma: 'Hofladen', name: 'Insa', mail: 'i@hof.example' }, paket: 'klein' } }));
    await l.mollieWebhook('tr_dopp1234');
    const zweit = await l.mollieWebhook('tr_dopp1234');
    expect(zweit.ergebnis).toMatch(/^wiederholt/);
    expect(l.instanzen()).toHaveLength(1);
    expect(l.zahlungen()).toHaveLength(1);
  });

  it('gescheiterter Schritt → fehler; Wiederholen setzt fort, ohne fertige Schritte zu wiederholen', async () => {
    const { l, b } = aufbau();
    b.fehlerBei.set('healthz_warten', 1);
    const k = konto(l);
    const r = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    expect(r.vorgang.status).toBe('fehler');
    expect(r.instanz.status).toBe('fehler');
    const volumeVorher = b.aufrufe.filter((x) => x.startsWith('volume_anlegen')).length;
    const w = await l.vorgangWiederholen(r.vorgang.id, 'till');
    expect(w.vorgang.status).toBe('fertig');
    expect(w.instanz.status).toBe('test');
    expect(b.aufrufe.filter((x) => x.startsWith('volume_anlegen')).length).toBe(volumeVorher);
  });

  it('ohne Konto nur Pitch-Instanzen', async () => {
    const { l } = aufbau();
    await expect(l.instanzAnlegen({ herkunft: { art: 'manuell' }, paket: 'klein' }, 'till')).rejects.toThrow(/Pitch/);
  });
});

describe('Testphase ohne Dark Patterns', () => {
  it('Erinnerung 4 und 1 Tag vorher, dann nur lesen, Löschung 30 Tage nach Testende', async () => {
    const { l, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
    expect(instanz.status).toBe('test');
    expect(l.postausgang().some((p) => p.betreff === 'Dein Zugang ist da')).toBe(true);
    for (let d = 1; d <= 14; d++) { vor(1); await l.planer(); }
    expect(l.instanz(instanz.id).status).toBe('test'); // Tag 14 bis 23:59 Berliner Zeit
    vor(1); await l.planer();
    const post = l.postausgang().map((p) => p.betreff);
    expect(post.filter((b) => b.startsWith('Deine Testphase endet'))).toHaveLength(2); // Tag 10 und 13
    expect(post).toContain('Halbzeit');
    const i = l.instanz(instanz.id);
    expect(i.status).toBe('test_abgelaufen');
    expect(i.loeschen_am).toBe(new Date(Date.parse(i.test_ende!) + 30 * TAG).toISOString());
    for (let d = 0; d < 31; d++) { vor(1); await l.planer(); }
    expect(l.instanz(instanz.id).status).toBe('geloescht');
    const titel = l.postausgang().map((p) => p.betreff);
    expect(titel.filter((b) => b.startsWith('Löschung am'))).toHaveLength(1); // Testende + 23
    expect(titel).toContain('Gelöscht');
    // v1.4 3.2: vor der Löschung mindestens zwei Mails mit Löschdatum
    expect(titel.filter((b) => b === 'Testphase beendet' || b.startsWith('Löschung am')).length).toBeGreaterThanOrEqual(2);
    const beleg = l.loeschbelege()[0]!;
    expect(beleg.subdomain).toBe(i.subdomain);
    expect(beleg.von).toBe('planer');
  });

  it('Kauf im Test aktiviert ohne Neuanlage', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    await l.aktivieren(instanz.id, 'rechnung', 'AN-2026-17', 'till');
    const i = l.instanz(instanz.id);
    expect(i.status).toBe('aktiv');
    expect(i.test_ende).toBeNull();
    expect(l.kunde(k.id).status).toBe('kunde');
  });

  it('Verlängern braucht Grund, erzeugt Mail und Protokoll; holt abgelaufene Tests zurück', async () => {
    const { l, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    expect(() => l.testVerlaengern(instanz.id, 7, ' ', 'till')).toThrow(/Grund/);
    expect(() => l.testVerlaengern(instanz.id, 45, 'x', 'till')).toThrow();
    vor(15); await l.planer();
    expect(l.instanz(instanz.id).status).toBe('test_abgelaufen');
    l.testVerlaengern(instanz.id, 7, 'GF im Urlaub', 'till');
    expect(l.instanz(instanz.id).status).toBe('test');
    expect(l.instanz(instanz.id).loeschen_am).toBeNull();
    expect(l.ereignisse({ instanz_id: instanz.id }).some((e) => e.was === 'test_verlaengert' && e.daten?.grund === 'GF im Urlaub')).toBe(true);
  });
});

describe('Pitch', () => {
  it('startet geteilt mit Beispieldaten und wird nach Ablauf automatisch weggeräumt', async () => {
    const { l, vor, b } = aufbau();
    const r = await l.pitchAnlegen({ beispiel: 'kanzlei-behrens', tage: 3, fuer: 'anwaltverein' }, 'till');
    expect(r.instanz.status).toBe('demo');
    expect(r.instanz.stufe).toBe('geteilt');
    expect(r.instanz.kunde_id).toBeNull();
    expect(b.instanzen.get(r.instanz.id)!.beispiel).toBe('kanzlei-behrens');
    vor(2); await l.planer();
    expect(l.instanz(r.instanz.id).status).toBe('demo');
    vor(2); await l.planer();
    expect(l.instanz(r.instanz.id).status).toBe('geloescht');
    expect(b.instanzen.has(r.instanz.id)).toBe(false);
    expect(l.loeschbelege()[0]!.grund).toMatch(/Pitch/);
  });

  it('Übernahme: Beispieldaten weg, dann normale Testphase', async () => {
    const { l, b } = aufbau();
    const r = await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
    const k = konto(l);
    await expect(l.aktivieren(r.instanz.id, 'rechnung', undefined, 'till')).rejects.toThrow(/übernehmen/);
    const i = await l.demoUebernehmen(r.instanz.id, k.id, 'till');
    expect(i.status).toBe('test');
    expect(i.beispiel).toBeNull();
    expect(b.instanzen.get(r.instanz.id)!.beispiel).toBeNull();
  });
});

describe('Löschen', () => {
  it('braucht die abgetippte Subdomain und einen Grund', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    await expect(l.loeschungPlanen(instanz.id, { bestaetigung: 'falsch', grund: 'x' }, 'till')).rejects.toThrow(/Bestätigung/);
    await expect(l.loeschungPlanen(instanz.id, { bestaetigung: instanz.subdomain, grund: '' }, 'till')).rejects.toThrow(/Grund/);
    await expect(l.loeschungPlanen(instanz.id, { bestaetigung: instanz.subdomain, grund: 'x', sofort: true }, 'till')).rejects.toThrow(/Beleg/);
  });

  it('zahlender Kunde: Planer löscht am Termin nicht selbst, Heute zeigt den Klick', async () => {
    const { l, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    await l.loeschungPlanen(instanz.id, { bestaetigung: instanz.subdomain, grund: 'Kündigung zum 31.10.' }, 'till');
    vor(31);
    const r = await l.planer();
    expect(l.instanz(instanz.id).status).toBe('loeschung_geplant');
    expect(r.klick.some((x) => x.instanz_id === instanz.id)).toBe(true);
    expect(l.heute().klick.some((x) => x.instanz.id === instanz.id)).toBe(true);
  });

  it('sofort mit Beleg schreibt einen Löschbeleg ohne Inhalte', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    const i = await l.loeschungPlanen(instanz.id, { bestaetigung: instanz.subdomain, grund: 'Kundenwunsch', sofort: true, beleg: 'Mail 24.10. „Bitte löschen“' }, 'till');
    expect(i.status).toBe('geloescht');
    expect(l.loeschbelege()[0]!.nachweis).toMatch(/Container.*Volume/);
  });
});

describe('Mollie nur lesend', () => {
  it('Fehlabbuchung → zahlung_offen mit Kulanz, spätere Zahlung → aktiv', async () => {
    const { l, m, vor } = aufbau();
    m.zahlungen.set('tr_erst1234', zahlung({ id: 'tr_erst1234', customerId: 'cst_a1', subscriptionId: 'sub_a1', metadata: { kunde: { firma: 'Bäckerei Ahrens', name: 'Ina', mail: 'ina@ahrens.example' }, paket: 'klein' } }));
    m.abos.set('sub_a1', { id: 'sub_a1', status: 'active', amount: { value: '59.00', currency: 'EUR' }, interval: '1 month', customerId: 'cst_a1' });
    await l.mollieWebhook('tr_erst1234');
    const iid = l.instanzen()[0]!.id;
    vor(30);
    m.zahlungen.set('tr_folg1234', zahlung({ id: 'tr_folg1234', status: 'failed', sequenceType: 'recurring', customerId: 'cst_a1', subscriptionId: 'sub_a1' }));
    expect((await l.mollieWebhook('tr_folg1234')).ergebnis).toBe('zahlung_offen');
    expect(l.instanz(iid).status).toBe('zahlung_offen');
    expect(l.instanz(iid).kulanz_bis).not.toBeNull();
    expect(l.heute().klick.some((x) => x.instanz.id === iid)).toBe(true);
    m.zahlungen.set('tr_nach1234', zahlung({ id: 'tr_nach1234', sequenceType: 'recurring', customerId: 'cst_a1', subscriptionId: 'sub_a1' }));
    await l.mollieWebhook('tr_nach1234');
    expect(l.instanz(iid).status).toBe('aktiv');
    expect(l.abos()[0]!.status).toBe('active');
  });

  it('ungültige IDs werden ignoriert, ohne Mollie zu fragen', async () => {
    const { l, m } = aufbau();
    expect((await l.mollieWebhook('../../etc/passwd')).ergebnis).toMatch(/ignoriert/);
    expect(m.abrufe).toBe(0);
  });
});

describe('Partner ohne Tracking-Cookies', () => {
  it('Code wird nur mit Zustimmung gespeichert; Provisionsliste nur mit Schalter (v1.4 Abschnitt 17)', async () => {
    const { l, m } = aufbau();
    l.partnerAnlegen({ code: 'linkedin-anna', name: 'Anna', art: 'influencer', provision_prozent: 15, laufzeit_monate: 12, aktiv: true }, 'till');
    m.zahlungen.set('tr_ohne1234', zahlung({ id: 'tr_ohne1234', metadata: { kunde: { firma: 'Ohne Zustimmung', name: 'A', mail: 'a@ohne.example' }, paket: 'klein', empfehlungscode: 'LINKEDIN-ANNA', zuordnung_zustimmung: false } }));
    m.zahlungen.set('tr_mitz1234', zahlung({ id: 'tr_mitz1234', metadata: { kunde: { firma: 'Mit Zustimmung', name: 'B', mail: 'b@mit.example' }, paket: 'betrieb', empfehlungscode: 'LINKEDIN-ANNA', zuordnung_zustimmung: true, code_weg: 'link' } }));
    await l.mollieWebhook('tr_ohne1234');
    await l.mollieWebhook('tr_mitz1234');
    const ohne = l.kunden({ suche: 'Ohne' })[0]!;
    const mit = l.kunden({ suche: 'Mit Zust' })[0]!;
    expect(ohne.zuordnung).toBeUndefined();
    expect(JSON.stringify(ohne)).not.toContain('ANNA');
    expect(mit.zuordnung).toMatchObject({ code: 'LINKEDIN-ANNA', weg: 'link' });
    expect(l.auszahlungsliste()).toEqual([]); // Standard: keine Provisionen
    expect(l.partnerZahlen('LINKEDIN-ANNA')).toMatchObject({ kunden: 1, aktiv: 1 });
    l.setzeSchalter({ partner_provisionen: true }, 'till');
    const liste = l.auszahlungsliste();
    expect(liste).toHaveLength(1);
    expect(liste[0]!.provision_cent).toBe(1935);
    l.auszahlungVermerken('LINKEDIN-ANNA', liste[0]!.monat, 'Überweisung 01.11.', 'till');
    expect(l.auszahlungsliste()[0]!.status).toBe('ausgezahlt');
  });

  it('unbekannter oder pausierter Code wird verworfen', () => {
    const { l } = aufbau();
    l.partnerAnlegen({ code: 'PAUSE', name: 'P', art: 'empfehler', provision_prozent: 0, laufzeit_monate: 0, aktiv: false }, 'till');
    const k = l.kundeAnlegen({ firma: 'X', ansprechpartner: '', mail: 'x@x.example', typ: 'direkt', rechnungsweg: 'rechnung', empfehlungscode: 'PAUSE', zuordnung_zustimmung: true }, 'till');
    expect(k.zuordnung).toBeUndefined();
  });
});

describe('Prüfprotokoll', () => {
  it('ist nur anhängbar', async () => {
    const { l, db } = aufbau();
    konto(l);
    const p = await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
    await l.loeschungPlanen(p.instanz.id, { bestaetigung: p.instanz.subdomain, grund: 'Pitch vorbei' }, 'till');
    expect(l.loeschbelege()).toHaveLength(1);
    expect(l.ereignisse().length).toBeGreaterThan(0);
    expect(() => db.prepare('UPDATE ereignisse SET wer = ?').run('jemand')).toThrow(/nur anhängbar/);
    expect(() => db.prepare('DELETE FROM ereignisse').run()).toThrow(/nur anhängbar/);
    expect(() => db.prepare('DELETE FROM loeschbelege').run()).toThrow(/nur anhängbar/);
  });
  it('protokolliert jede Bedienaktion mit Wer', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    await l.pausieren(instanz.id, 'Missbrauchsverdacht', 'till');
    await l.fortsetzen(instanz.id, 'till');
    const was = l.ereignisse({ instanz_id: instanz.id }).map((e) => `${e.wer}:${e.was}`);
    expect(was).toEqual(expect.arrayContaining(['till:instanz_anlegen', 'till:status']));
    expect(l.instanz(instanz.id).status).toBe('aktiv');
  });
});

describe('Betriebsstufen', () => {
  it('Test, Pitch und Demo laufen geteilt, auch wenn „eigen“ gewünscht', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const t = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', stufe: 'eigen' }, 'till');
    expect(t.instanz.stufe).toBe('geteilt');
    expect(t.instanz.host).toBe('geteilt-01');
  });

  it('eigene Maschine sofort bei Rechnungskunden; ein Klick, gleicher Ablauf', async () => {
    const { l } = aufbau();
    const k = konto(l);
    const r = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'team', zahlung: 'rechnung', stufe: 'eigen' }, 'till');
    expect(r.instanz.stufe).toBe('eigen');
    expect(l.hostOpt(r.instanz.host)?.instanz_id).toBe(r.instanz.id);
  });

  it('Hochstufen: Prüfsumme gleich → umgeschaltet, alte Instanz Rückfallebene, Planer löscht sie nach 7 Tagen', async () => {
    const { l, b, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'betrieb', zahlung: 'rechnung' }, 'till');
    const r = await l.stufeWechseln(instanz.id, 'eigen', 'till');
    expect(r.vorgang.status).toBe('fertig');
    expect(r.instanz.stufe).toBe('eigen');
    expect(r.instanz.status).toBe('aktiv');
    expect(r.vorgang.schritte.find((s) => s.name === 'pruefen')!.meldung).toMatch(/gleich/);
    expect(l.rueckfaelle()).toHaveLength(1);
    expect((await l.hostLast('geteilt-01')).rueckfall).toBe(1);
    vor(8); await l.planer();
    expect(l.rueckfaelle()).toHaveLength(0);
    expect(b.angehalten).toHaveLength(0);
    // und zurück
    const z = await l.stufeWechseln(instanz.id, 'geteilt', 'till');
    expect(z.instanz.stufe).toBe('geteilt');
    expect(z.instanz.host).toBe('geteilt-01');
  });

  it('Prüfsumme weicht ab → automatischer Rückbau, alte Instanz läuft normal weiter', async () => {
    const { l, b } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    b.pruefsummeFalsch = true;
    const r = await l.stufeWechseln(instanz.id, 'eigen', 'till');
    expect(r.vorgang.status).toBe('fehler');
    expect(r.instanz.stufe).toBe('geteilt');
    expect(r.instanz.status).toBe('aktiv');
    expect(b.aufrufe).toContain(`rueckbau:${instanz.id}`);
    expect(b.aufrufe).not.toContain(`umschalten:${instanz.id}`);
    expect(b.instanzen.get(instanz.id)!.modus).toBe('normal');
  });

  it('kein Wechsel für Test oder Pitch', async () => {
    const { l } = aufbau();
    const p = await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
    await expect(l.stufeWechseln(p.instanz.id, 'eigen', 'till')).rejects.toThrow(/aktive/);
  });

  it('voller geteilter Host: klare Meldung statt Überbelegung', async () => {
    const { l } = aufbau({ container_max: 1 });
    await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
    await expect(l.pitchAnlegen({ beispiel: 'kanzlei-behrens' }, 'till')).rejects.toThrow(/Platz/);
  });

  it('Selbstbedienungs-Test: höchstens einer je Firmen-Domain', async () => {
    const { l } = aufbau();
    const a = konto(l, 'Firma A', 'a@gleich.example');
    const b = konto(l, 'Firma A Filiale', 'b@gleich.example');
    await l.instanzAnlegen({ kunde_id: a.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
    await expect(l.instanzAnlegen({ kunde_id: b.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular')).rejects.toThrow(/12 Monaten/);
    // Till kann von Hand trotzdem
    await expect(l.instanzAnlegen({ kunde_id: b.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till')).resolves.toBeTruthy();
  });
});

describe('Umzug in eigene Cloud', () => {
  it('Export, nur lesen, Bestätigung mit Prüfbericht, Löschung nach 14 Tagen', async () => {
    const { l, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    const u = await l.umzugStarten(instanz.id, 'eigene_cloud', undefined, 'till');
    expect(u.instanz.status).toBe('umzug_laeuft');
    expect(l.heute().umzuege).toHaveLength(1);
    await expect(l.umzugBestaetigen(instanz.id, 'abc', 'till')).rejects.toThrow();
    const i = await l.umzugBestaetigen(instanz.id, 'a'.repeat(64), 'till');
    expect(i.status).toBe('umgezogen');
    vor(15); await l.planer();
    expect(l.instanz(instanz.id).status).toBe('geloescht');
  });
});

describe('Subdomain aus Firmennamen', () => {
  it('kurze und reservierte Namen werden aufgefüllt, Dubletten nummeriert', async () => {
    const { l } = aufbau();
    const a = await l.instanzAnlegen({ kunde_id: konto(l, 'A').id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    const b = await l.instanzAnlegen({ kunde_id: konto(l, 'Admin', 'x@admin.example').id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    const c = await l.instanzAnlegen({ kunde_id: konto(l, 'A', 'y@a2.example').id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    expect([a.instanz.subdomain, b.instanz.subdomain, c.instanz.subdomain]).toEqual(['kunde-a', 'admin-kunde', 'kunde-a-2']);
  });
});
