/** CONTRACT v1.4: Schalter, Konto-Brücke, Egress, Grenzen, Rechnungsentwurf, nächtlicher Stufenwechsel. */
import { describe, expect, it } from 'vitest';
import { aufbau, konto, TAG } from './hilfe.js';
import { Admins } from '../src/auth.js';
import { erstelleApp } from '../src/app.js';
import { oeffneDb } from '../src/db.js';
import { Leitstand } from '../src/leitstand.js';
import { DummyBereitsteller } from '../src/bereitsteller/dummy.js';

describe('Schalter (Abschnitt 16)', () => {
  it('Standard: Kauf und Testformular zu, Test-KI aus, Lesefrist 30, keine Provisionen', () => {
    const l = new Leitstand({ db: oeffneDb(':memory:'), bereitsteller: new DummyBereitsteller() });
    const s = l.schalter();
    expect([s.kauf_offen, s.tests_offen, s.test_ki, s.berufsgeheimnis_offen, s.partner_provisionen, s.lesefrist_tage, s.managed_domain]).toEqual([false, false, false, false, false, 30, null]);
  });
  it('S-2: ohne Domain startet Managed nicht', async () => {
    const l = new Leitstand({ db: oeffneDb(':memory:'), bereitsteller: new DummyBereitsteller(), geteilteHosts: [{ id: 'h-01', name: 'h', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: 5, ram_mb: 8192, speicher_bytes: 500 * 1024 ** 3 } }] });
    await expect(l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till')).rejects.toThrow(/S-2/);
    l.setzeSchalter({ managed_domain: 'kern.example' }, 'till');
    await expect(l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till')).resolves.toBeTruthy();
  });
  it('S-6 und S-8 sperren nur das Testformular, nicht Tills Handanlage', async () => {
    const { l } = aufbau({ schalter: { tests_offen: false } });
    const k = konto(l);
    await expect(l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular')).rejects.toThrow(/S-6/);
    l.setzeSchalter({ tests_offen: true, neue_tests_pausiert: true }, 'till');
    await expect(l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular')).rejects.toThrow(/S-8/);
    await expect(l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till')).resolves.toBeTruthy();
    expect(l.ereignisse().some((e) => e.was === 'schalter' && 'neue_tests_pausiert' in (e.daten ?? {}))).toBe(true);
  });
  it('S-12: Berufsgeheimnisträger nicht im Managed-Betrieb', async () => {
    const { l } = aufbau();
    const k = l.kundeAnlegen({ firma: 'Kanzlei Thormählen', ansprechpartner: '', mail: 'o@k.example', typ: 'direkt', rechnungsweg: 'rechnung', berufsgeheimnis: true }, 'till');
    await expect(l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till')).rejects.toThrow(/S-12/);
  });
  it('S-11: Lesefrist unter 30 Tagen wird abgelehnt (Data Act)', () => {
    const { l } = aufbau();
    expect(() => l.setzeSchalter({ lesefrist_tage: 14 }, 'till')).toThrow(/30/);
    expect(l.setzeSchalter({ lesefrist_tage: 45 }, 'till').lesefrist_tage).toBe(45);
  });
});

describe('Grenzen und KI-Weg (3.1, 3.4)', () => {
  it('Test ohne Test-KI: kein Kontingent; Kauf setzt Paketgrenzen', async () => {
    const { l, b } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'betrieb', ki_vorlage: 'mistral' }, 'till');
    expect(instanz.ki.weg).toBe('ohne');
    expect(b.instanzen.get(instanz.id)!.grenzen).toMatchObject({ nutzer_max: 5, speicher_max_bytes: 5 * 1024 ** 3, ki_kontingent_cent_monat: null });
    await l.aktivieren(instanz.id, 'rechnung', undefined, 'till');
    expect(l.instanz(instanz.id).ki.weg).toBe('app');
    expect(b.instanzen.get(instanz.id)!.grenzen).toMatchObject({ nutzer_max: 15, speicher_max_bytes: 15 * 1024 ** 3, ki_kontingent_cent_monat: 1500 });
  });
  it('mit S-1 bekommt der Test das Test-Kontingent', async () => {
    const { l, b } = aufbau({ schalter: { test_ki: true } });
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'team' }, 'till');
    expect(instanz.ki.weg).toBe('hd_test');
    expect(b.instanzen.get(instanz.id)!.grenzen?.ki_kontingent_cent_monat).toBe(500);
  });
});

describe('Zahlungsausfall und Kündigung (W11, 3.2)', () => {
  it('zahlung_offen wird nach 14 Tagen automatisch nur_lesen, dann Löschung nach Lesefrist', async () => {
    const { l, m, vor } = aufbau();
    m.zahlungen.set('tr_a0000001', { id: 'tr_a0000001', status: 'paid', amount: { value: '29.00', currency: 'EUR' }, sequenceType: 'first', customerId: 'cst_1', createdAt: '2026-10-01T08:00:00Z', metadata: { kunde: { firma: 'Hof', name: 'X', mail: 'x@hof.example' }, paket: 'klein' } });
    await l.mollieWebhook('tr_a0000001');
    const iid = l.instanzen()[0]!.id;
    m.zahlungen.set('tr_a0000002', { id: 'tr_a0000002', status: 'failed', amount: { value: '29.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_1', createdAt: '2026-10-01T08:00:00Z', metadata: null });
    await l.mollieWebhook('tr_a0000002');
    expect(l.instanz(iid).status).toBe('zahlung_offen');
    vor(15); await l.planer();
    expect(l.instanz(iid).status).toBe('nur_lesen');
    expect(l.instanz(iid).loeschen_am).not.toBeNull();
  });
  it('Kündigung: aktiv mit kuendigung_zum, zum Datum nur_lesen, zurücknehmbar', async () => {
    const { l, vor } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    const r = l.kontoKuendigen(instanz.id);
    expect(l.instanz(instanz.id).status).toBe('aktiv');
    l.kontoKuendigungZuruecknehmen(instanz.id);
    expect(l.instanz(instanz.id).kuendigung_zum).toBeNull();
    l.kontoKuendigen(instanz.id);
    vor(31); await l.planer();
    expect(l.instanz(instanz.id).status).toBe('nur_lesen');
    expect(r.kuendigung_zum).toBeTruthy();
  });
});

describe('Konto-Brücke /v1/konto (3.5)', () => {
  async function bruecke() {
    const a = aufbau();
    const admins = new Admins(a.db);
    const { app } = erstelleApp({ leitstand: a.l, admins, secret: 'x'.repeat(40) });
    const k = konto(a.l);
    const { instanz } = await a.l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'betrieb' }, 'till');
    const token = a.b.instanzen.get(instanz.id)!.konto_token;
    let n = 0;
    const rufe = (pfad: string, body?: object, t = token) => app.request(pfad, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...(body ? { 'idempotency-key': `konto-${++n}-${Date.now()}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { ...a, app, instanz, token, rufe };
  }
  it('Token gilt nur für die eigene Instanz und öffnet keine Betreiberrouten', async () => {
    const { rufe, app, token } = await bruecke();
    expect((await rufe('/v1/konto', undefined, 'kkt_falsch')).status).toBe(401);
    const r = await rufe('/v1/konto');
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ status: 'test', paket: 'betrieb', stufe: 'geteilt', test_selbst_verlaengert: false });
    expect(JSON.stringify(j)).not.toMatch(/host|geteilt-01|notiz|partner/i);
    expect((await app.request('/v1/instanzen', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('einmal 14 Tage selbst verlängern', async () => {
    const { rufe } = await bruecke();
    expect((await rufe('/v1/konto/test-verlaengern', {})).status).toBe(200);
    expect((await rufe('/v1/konto/test-verlaengern', {})).status).toBe(409);
  });
  it('kaufen liefert Mollie-Checkout; bezahlte Zahlung aktiviert dieselbe Instanz', async () => {
    const { rufe, m, l, instanz } = await bruecke();
    const r = await rufe('/v1/konto/kaufen', { paket: 'klein', stufe: 'geteilt', intervall: 'monat' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { checkout_url: string }).checkout_url).toMatch(/mollie/);
    expect(m.angelegt[0]).toMatchObject({ betrag_cent: 2900, sequenceType: 'first', metadata: { instanz_id: instanz.id, paket: 'klein' } });
    const z = m.zahlungen.get('tr_fake000001')!;
    m.zahlungen.set(z.id, { ...z, status: 'paid', paidAt: '2026-10-01T09:00:00Z', customerId: 'cst_neu' });
    await l.mollieWebhook(z.id);
    expect(l.instanz(instanz.id)).toMatchObject({ status: 'aktiv', paket: 'klein', zahlung: 'mollie' });
    expect(l.instanzen()).toHaveLength(1);
  });
  it('kaufen ist gesperrt, solange S-6 zu ist', async () => {
    const { rufe, l } = await bruecke();
    l.setzeSchalter({ kauf_offen: false }, 'till');
    expect((await rufe('/v1/konto/kaufen', { paket: 'klein', stufe: 'geteilt', intervall: 'monat' })).status).toBe(403);
  });
  it('löschen: Mail mit Einmal-Link, GET fragt nur nach, POST löscht sofort mit Beleg', async () => {
    const { rufe, app, l, instanz, db } = await bruecke();
    expect((await rufe('/v1/konto/loeschen', { bestaetigung: 'falsch' })).status).toBe(400);
    expect((await rufe('/v1/konto/loeschen', { bestaetigung: instanz.subdomain })).status).toBe(200);
    const text = (db.prepare("SELECT text FROM postausgang WHERE betreff = 'Löschung bestätigen'").get() as { text: string }).text;
    const t = /t=([A-Za-z0-9_-]+)/.exec(text)![1]!;
    expect((await app.request(`/v1/konto/loeschen/bestaetigen?t=${t}`)).status).toBe(200);
    expect(l.instanz(instanz.id).status).toBe('test'); // GET allein löscht nicht
    const post = () => app.request('/v1/konto/loeschen/bestaetigen', { method: 'POST', body: new URLSearchParams({ t }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await post()).status).toBe(200);
    expect(l.instanz(instanz.id).status).toBe('geloescht');
    expect(l.loeschbelege()[0]!.nachweis).toMatch(/Textform/);
    expect((await post()).status).toBe(400); // Link nur einmal
  });
  it('egress-anfrage landet bei Till; Freigabe geht an den Bereitsteller', async () => {
    const { rufe, l, b, instanz } = await bruecke();
    await rufe('/v1/konto/egress-anfrage', { host: 'llm.firma.example', zweck: 'eigenes Modell' });
    expect(l.egressAnfragen()).toHaveLength(1);
    await l.egressFreigeben(instanz.id, 'llm.firma.example', 'Anfrage geprüft', 'till');
    expect(b.instanzen.get(instanz.id)!.egress).toEqual(['llm.firma.example']);
    expect(l.egressAnfragen()).toHaveLength(0);
    await expect(l.egressFreigeben(instanz.id, '10.0.0.1', 'x', 'till')).rejects.toThrow(/Hostname/);
  });
});

describe('Stufenwechsel nachts (3.6) und aus dem Konto', () => {
  it('vorgemerkt für 02:00, Planer führt ihn aus', async () => {
    const { l, uhr } = aufbau();
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    const { ab } = l.stufeWechselnNachts(instanz.id, 'eigen', 'till');
    await l.planer();
    expect(l.instanz(instanz.id).stufe).toBe('geteilt');
    uhr.t = Date.parse(ab) + 60_000;
    await l.planer();
    expect(l.instanz(instanz.id).stufe).toBe('eigen');
    expect(l.geplanteWechsel()).toHaveLength(0);
  });
  it('Mollie-Kunde: Hochstufen aus dem Konto erst nach bezahltem Aufschlag', async () => {
    const { l, m } = aufbau();
    m.zahlungen.set('tr_b0000001', { id: 'tr_b0000001', status: 'paid', amount: { value: '29.00', currency: 'EUR' }, sequenceType: 'first', customerId: 'cst_2', createdAt: '2026-10-01T08:00:00Z', metadata: { kunde: { firma: 'Kfz Behn', name: 'Y', mail: 'y@behn.example' }, paket: 'klein' } });
    await l.mollieWebhook('tr_b0000001');
    const iid = l.instanzen()[0]!.id;
    const r = await l.kontoStufe(iid, 'eigene_maschine');
    expect(r.checkout_url).toBeTruthy();
    expect(l.instanz(iid).stufe).toBe('geteilt');
    const z = m.zahlungen.get('tr_fake000001')!;
    m.zahlungen.set(z.id, { ...z, status: 'paid' });
    expect((await l.mollieWebhook(z.id)).ergebnis).toBe('stufe_gewechselt');
    expect(l.instanz(iid).stufe).toBe('eigen');
  });
});

describe('Rechnungsentwurf je Zahlung (3.6, S-9)', () => {
  it('legt Entwurf an, festgeschrieben nur mit stehender Freigabe', async () => {
    const entwuerfe: { festschreiben: boolean; betrag_cent: number }[] = [];
    const db = oeffneDb(':memory:');
    const { MollieFake } = await import('../src/mollie.js');
    const m = new MollieFake();
    const l = new Leitstand({ db, bereitsteller: new DummyBereitsteller(), mollie: m, domain: 'kern.example', geteilteHosts: [{ id: 'h-01', name: 'h', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: 5, ram_mb: 8192, speicher_bytes: 500 * 1024 ** 3 } }],
      rechnungen: { entwurf: async (e) => { entwuerfe.push(e); return { id: `E-${entwuerfe.length}` }; } } });
    m.zahlungen.set('tr_c0000001', { id: 'tr_c0000001', status: 'paid', amount: { value: '69.00', currency: 'EUR' }, sequenceType: 'first', createdAt: '2026-10-01T08:00:00Z', metadata: { kunde: { firma: 'Z', name: 'Z', mail: 'z@z.example' }, paket: 'betrieb' } });
    await l.mollieWebhook('tr_c0000001');
    expect(entwuerfe[0]).toMatchObject({ betrag_cent: 6900, festschreiben: false });
    expect(l.zahlungen()[0]!.rechnung).toEqual({ entwurf: 'E-1', festgeschrieben: false });
  });
});

describe('Hosts nach Zweck (3.1, W13)', () => {
  it('Pitches auf den Bestandshost, Tests und Kunden auf den Kern-Host', async () => {
    const l = new Leitstand({ db: oeffneDb(':memory:'), bereitsteller: new DummyBereitsteller(), domain: 'kern.example', schalter: { tests_offen: true },
      geteilteHosts: [
        { id: 'host-01', name: 'Bestand', region: 'de-nbg', aktiv: true, zweck: ['pitch'], kapazitaet: { container_max: 10, ram_mb: 4096, speicher_bytes: 80 * 1024 ** 3 } },
        { id: 'kern-01', name: 'Kern', region: 'de-nbg', aktiv: true, zweck: ['test', 'kunde'], kapazitaet: { container_max: 30, ram_mb: 12288, speicher_bytes: 400 * 1024 ** 3 } },
      ] });
    const p = await l.pitchAnlegen({ beispiel: 'kanzlei-behrens' }, 'till');
    expect(p.instanz.host).toBe('host-01');
    const k = konto(l);
    const t = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
    expect(t.instanz.host).toBe('kern-01');
    await l.aktivieren(t.instanz.id, 'rechnung', undefined, 'till');
    expect(l.instanz(t.instanz.id).host).toBe('kern-01'); // Kauf im Test erzwingt keinen Umzug
  });
});

void TAG;
