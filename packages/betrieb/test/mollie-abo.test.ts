/**
 * Mollie: Abo nach Erstzahlung, Stufenwechsel tagesgenau über das Mandat, Kündigung, Fehlzahlung mit Lesephase,
 * Vorankündigung, Webhook-Prüfung (Abruf per ID). Gegen MollieFake und gegen MollieHttp mit aufgezeichneten Antworten.
 * Keine echten Schlüssel.
 */
import { describe, expect, it } from 'vitest';
import { aufbau, konto, TAG } from './hilfe.js';
import { anteilig, naechsterTermin, vorankuendigungFaellig } from '../src/abrechnung.js';
import { MollieHttp } from '../src/mollie.js';
import { erstelleApp } from '../src/app.js';
import { Admins } from '../src/auth.js';

async function gekauft(intervall: 'monat' | 'jahr' = 'monat', paket: 'klein' | 'betrieb' = 'betrieb') {
  const w = aufbau();
  const k = konto(w.l);
  const { instanz } = await w.l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
  const r = await w.l.kontoKaufen(instanz.id, { paket, stufe: 'geteilt', intervall });
  expect(r.checkout_url).toMatch(/checkout/);
  const z = w.m.zahlungen.get('tr_fake000001')!;
  w.m.zahlungen.set(z.id, { ...z, status: 'paid', paidAt: '2026-10-01T09:00:00Z', customerId: 'cst_kunde1' });
  expect((await w.l.mollieWebhook(z.id)).ergebnis).toBe('aktiviert');
  return { ...w, k, iid: instanz.id };
}

describe('Abrechnungsregeln', () => {
  it('tagesgenaue Differenz, Monatsende wie Mollie', () => {
    expect(anteilig({ alt_cent: 6900, neu_cent: 16800, beginn: '2026-10-01', ende: '2026-11-01', heute: '2026-10-17' })).toEqual({ cent: Math.round((9900 * 15) / 31), resttage: 15, tage: 31 });
    expect(anteilig({ alt_cent: 16800, neu_cent: 6900, beginn: '2026-10-01', ende: '2026-11-01', heute: '2026-10-31' }).cent).toBe(Math.round((-9900 * 1) / 31));
    expect(naechsterTermin('2026-01-31', 'monat')).toBe('2026-02-28');
    expect(naechsterTermin('2026-12-15', 'monat')).toBe('2027-01-15');
    expect(naechsterTermin('2028-02-29', 'jahr')).toBe('2029-02-28');
    expect(vorankuendigungFaellig('2026-11-01', '2026-10-29')).toBe(true);
    expect(vorankuendigungFaellig('2026-11-01', '2026-10-28')).toBe(false);
  });
});

describe('Abo nach Erstzahlung (Subscriptions API)', () => {
  it('legt nach bezahlter Erstzahlung das Abo an: Betrag aus G1, Intervall, Start nach dem ersten Zeitraum, gültiges Mandat; idempotent', async () => {
    const { l, m, iid } = await gekauft();
    const a = l.aboZu(iid)!;
    expect(a).toMatchObject({ betrag_cent: 6900, intervall: '1 month', naechste: '2026-11-01', customer_id: 'cst_kunde1', mandat_id: 'mdt_kunde1', zeitraum_beginn: '2026-10-01' });
    expect(m.aboAufrufe).toEqual(['anlegen:cst_kunde1:6900:1 month:2026-11-01']);
    await l.mollieWebhook('tr_fake000001'); // Mollie wiederholt den Webhook
    expect(m.aboAufrufe).toHaveLength(1);
    expect(l.heute().mrr_cent).toBe(6900);
  });
  it('jährlich: zehn Monatsbeträge, Intervall 12 months', async () => {
    const { l, iid } = await gekauft('jahr', 'klein');
    expect(l.aboZu(iid)).toMatchObject({ betrag_cent: 29000, intervall: '12 months', naechste: '2027-10-01' });
  });
  it('ohne gültiges Mandat kein Abo, Ereignis im Prüfprotokoll', async () => {
    const w = aufbau();
    w.m.mandateListe.set('cst_ohne', [{ id: 'mdt_x', status: 'pending', method: 'directdebit' }]);
    const k = konto(w.l);
    const { instanz } = await w.l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
    await w.l.kontoKaufen(instanz.id, { paket: 'klein', stufe: 'geteilt', intervall: 'monat' });
    const z = w.m.zahlungen.get('tr_fake000001')!;
    w.m.zahlungen.set(z.id, { ...z, status: 'paid', customerId: 'cst_ohne' });
    await w.l.mollieWebhook(z.id);
    expect(w.l.aboZu(instanz.id)).toBeNull();
    expect(w.l.ereignisse().find((e) => e.was === 'abo_nicht_angelegt')?.daten).toMatchObject({ grund: 'kein gültiges Mandat' });
  });
});

describe('Stufenwechsel mit Aufpreis (P-9, W-3, v1.4 3.5)', () => {
  it('tagesgenaue Differenz über das Mandat ohne Checkout, Wechsel erst nach Zahlung, danach Abo-Betrag neu', async () => {
    const { l, m, iid, vor } = await gekauft();
    vor(16); // 17.10.
    const r = await l.kontoStufe(iid, 'eigene_maschine');
    expect(r.checkout_url).toBeNull();
    const z = m.angelegt.at(-1)!;
    expect(z).toMatchObject({ sequenceType: 'recurring', customerId: 'cst_kunde1', mandateId: 'mdt_kunde1', betrag_cent: Math.round((9900 * 15) / 31) });
    expect(l.instanz(iid).stufe).toBe('geteilt');
    const id = [...m.zahlungen.keys()].at(-1)!;
    m.zahlungen.set(id, { ...m.zahlungen.get(id)!, status: 'paid' });
    expect((await l.mollieWebhook(id)).ergebnis).toBe('stufe_gewechselt');
    expect(l.instanz(iid).stufe).toBe('eigen');
    expect(l.aboZu(iid)!.betrag_cent).toBe(6900 + 9900);
    expect(m.aboAufrufe.at(-1)).toBe(`aendern:${l.aboZu(iid)!.id}:16800`);
    expect(l.postausgang().some((p) => p.betreff === 'Deine Instanz läuft jetzt auf: Eigene Maschine')).toBe(true);
  });
  it('scheitert der Wechsel nach der Zahlung, wird erstattet (W-2)', async () => {
    const { l, m, b, iid } = await gekauft();
    await l.kontoStufe(iid, 'eigene_maschine');
    const id = [...m.zahlungen.keys()].at(-1)!;
    m.zahlungen.set(id, { ...m.zahlungen.get(id)!, status: 'paid' });
    b.pruefsummeFalsch = true;
    expect((await l.mollieWebhook(id)).ergebnis).toBe('stufenwechsel_fehler, erstattet');
    expect(m.erstattungen).toEqual([{ zahlung: id, betrag_cent: Math.round((9900 * 31) / 31), beschreibung: 'Stufenwechsel nicht ausgeführt, Betrag zurück' }]);
    expect(l.aboZu(iid)!.betrag_cent).toBe(6900);
  });
});

describe('Kündigung, Fehlzahlung, Lesephase, Vorankündigung', () => {
  it('Kündigung beendet das Abo sofort (keine Abbuchung am Stichtag), Rücknahme legt es zum alten Termin neu an', async () => {
    const { l, m, iid } = await gekauft();
    const aboId = l.aboZu(iid)!.id;
    expect(l.kontoKuendigen(iid).kuendigung_zum).toBe('2026-11-01T00:00:00.000Z');
    await l.hintergrund;
    expect(m.aboAufrufe).toContain(`kuendigen:${aboId}`);
    expect(l.aboZu(iid)).toBeNull();
    l.kontoKuendigungZuruecknehmen(iid);
    await l.hintergrund;
    expect(m.aboAufrufe.at(-1)).toBe('anlegen:cst_kunde1:6900:1 month:2026-11-01');
    expect(l.aboZu(iid)!.naechste).toBe('2026-11-01');
  });
  it('Vorankündigung 3 Tage vor dem Einzug, einmal je Termin', async () => {
    const { l, vor } = await gekauft();
    vor(26); await l.planer(); // 27.10.: noch zu früh
    expect(l.postausgang().filter((p) => p.betreff.startsWith('Einzug am'))).toHaveLength(0);
    vor(2); await l.planer(); await l.planer(); // 29.10.
    expect(l.postausgang().filter((p) => p.betreff.startsWith('Einzug am')).map((p) => p.betreff)).toEqual(['Einzug am 01.11.2026: 69,00 €']);
  });
  it('fehlgeschlagener Einzug: Mail, Mollie versucht erneut, Zahlung danach → aktiv; sonst nach 14 Tagen nur lesen, Lesephase Tag 1/14/28, Abo beendet', async () => {
    const { l, m, iid, vor } = await gekauft();
    const abo = l.aboZu(iid)!;
    m.zahlungen.set('tr_fehl0001', { id: 'tr_fehl0001', status: 'failed', amount: { value: '69.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_kunde1', subscriptionId: abo.id, createdAt: '2026-11-01T05:00:00Z', metadata: { instanz_id: iid } });
    vor(31);
    expect((await l.mollieWebhook('tr_fehl0001')).ergebnis).toBe('zahlung_offen');
    expect(l.postausgang().some((p) => p.betreff === 'Abbuchung hat nicht geklappt')).toBe(true);
    for (let d = 0; d < 15; d++) { vor(1); await l.planer(); }
    expect(l.instanz(iid).status).toBe('nur_lesen');
    expect(m.abos.get(abo.id)!.status).toBe('canceled');
    for (let d = 0; d < 31; d++) { vor(1); await l.planer(); }
    const b = l.postausgang().map((p) => p.betreff);
    expect(b.filter((x) => x.startsWith('Lesephase Tag')).map((x) => x.split(':')[0])).toEqual(['Lesephase Tag 28', 'Lesephase Tag 14', 'Lesephase Tag 1']);
    expect(l.instanz(iid).status).toBe('geloescht');
    expect(b).toContain('Gelöscht');
  });
  it('Zahlung nach Fehlschlag (Mollie-Wiederholung) setzt wieder aktiv', async () => {
    const { l, m, iid, vor } = await gekauft();
    const abo = l.aboZu(iid)!;
    m.zahlungen.set('tr_fehl0002', { id: 'tr_fehl0002', status: 'failed', amount: { value: '69.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_kunde1', subscriptionId: abo.id, createdAt: '2026-11-01T05:00:00Z', metadata: { instanz_id: iid } });
    vor(31); await l.mollieWebhook('tr_fehl0002');
    m.zahlungen.set('tr_nach0002', { id: 'tr_nach0002', status: 'paid', amount: { value: '69.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_kunde1', subscriptionId: abo.id, createdAt: '2026-11-02T05:00:00Z', paidAt: '2026-11-02T05:00:00Z', metadata: { instanz_id: iid } });
    vor(1); await l.mollieWebhook('tr_nach0002');
    expect(l.instanz(iid).status).toBe('aktiv');
    expect(l.aboZu(iid)).toBeTruthy();
  });
});

describe('Webhook-Prüfung: Mollie signiert klassische Webhooks nicht, also immer per ID abrufen', () => {
  it('nur die ID zählt; unbekannte ID → 200 ohne Wirkung; Status aus dem Körper wird ignoriert', async () => {
    const w = aufbau();
    const admins = new Admins(w.db);
    const { app } = erstelleApp({ leitstand: w.l, admins, secret: 'x'.repeat(40), websiteUrl: 'https://x.example' } as never);
    const abrufe0 = w.m.abrufe;
    const r = await app.request('/v1/webhooks/mollie', { method: 'POST', body: new URLSearchParams({ id: 'tr_unbekannt1', status: 'paid', amount: '9999' }) });
    expect(r.status).toBe(200);
    expect(w.m.abrufe).toBe(abrufe0 + 1); // genau ein Abruf über die API
    expect(w.l.zahlungen()).toHaveLength(0);
    expect(w.l.ereignisse().some((e) => e.was === 'webhook_fehler')).toBe(true);
    expect((await app.request('/v1/webhooks/mollie', { method: 'POST', body: new URLSearchParams({ id: '../../x' }) })).status).toBe(200);
  });
});

describe('MollieHttp gegen aufgezeichnete Antworten (Form nach docs.mollie.com/reference, v2)', () => {
  it('Abo anlegen, ändern, kündigen, Mandate, Erstattung, wiederkehrende Zahlung: Pfade, Körper, Kopfzeilen', async () => {
    const aufrufe: { m: string; u: string; b: unknown; h: Headers }[] = [];
    const antworten: Record<string, unknown> = {
      'POST /v2/customers/cst_a1/subscriptions': { resource: 'subscription', id: 'sub_n1', status: 'active', amount: { value: '69.00', currency: 'EUR' }, interval: '1 month', nextPaymentDate: '2026-11-01', customerId: 'cst_a1' },
      'PATCH /v2/customers/cst_a1/subscriptions/sub_n1': { resource: 'subscription', id: 'sub_n1', status: 'active', amount: { value: '168.00', currency: 'EUR' }, interval: '1 month', customerId: 'cst_a1' },
      'DELETE /v2/customers/cst_a1/subscriptions/sub_n1': { resource: 'subscription', id: 'sub_n1', status: 'canceled', amount: { value: '168.00', currency: 'EUR' }, interval: '1 month', customerId: 'cst_a1' },
      'GET /v2/customers/cst_a1/mandates': { count: 1, _embedded: { mandates: [{ resource: 'mandate', id: 'mdt_m1', status: 'valid', method: 'directdebit' }] } },
      'POST /v2/payments/tr_abcd1234/refunds': { resource: 'refund', id: 're_r1' },
      'POST /v2/payments': { resource: 'payment', id: 'tr_rec00001', status: 'pending', _links: {} },
    };
    const f = (async (u: string, i: RequestInit) => { const p = new URL(u).pathname; aufrufe.push({ m: i.method ?? 'GET', u: p, b: i.body ? JSON.parse(String(i.body)) : null, h: new Headers(i.headers) }); const a = antworten[`${i.method ?? 'GET'} ${p}`]; return new Response(JSON.stringify(a ?? { status: 404, detail: 'nicht da' }), { status: a ? 200 : 404 }); }) as unknown as typeof fetch;
    expect(() => new MollieHttp('falsch')).toThrow(/live_/);
    const m = new MollieHttp('test_' + 'a'.repeat(30), 'https://api.mollie.com/v2', f);
    expect((await m.erstelleAbo('cst_a1', { betrag_cent: 6900, intervall: '1 month', beschreibung: 'Kern x', startDate: '2026-11-01', webhookUrl: 'https://l.example/v1/webhooks/mollie', metadata: { instanz_id: 'i_x' }, mandateId: 'mdt_m1' })).id).toBe('sub_n1');
    expect(aufrufe[0]!.b).toEqual({ amount: { currency: 'EUR', value: '69.00' }, interval: '1 month', description: 'Kern x', startDate: '2026-11-01', webhookUrl: 'https://l.example/v1/webhooks/mollie', metadata: { instanz_id: 'i_x' }, mandateId: 'mdt_m1' });
    expect(aufrufe[0]!.h.get('authorization')).toBe('Bearer test_' + 'a'.repeat(30));
    await m.aendereAbo('cst_a1', 'sub_n1', { betrag_cent: 16800 });
    expect(aufrufe[1]).toMatchObject({ m: 'PATCH', b: { amount: { currency: 'EUR', value: '168.00' } } });
    expect((await m.kuendigeAbo('cst_a1', 'sub_n1')).status).toBe('canceled');
    expect((await m.mandate('cst_a1'))[0]).toMatchObject({ id: 'mdt_m1', status: 'valid' });
    await m.erstatte('tr_abcd1234', 1234, 'zurück');
    expect(aufrufe.at(-1)!.b).toEqual({ amount: { currency: 'EUR', value: '12.34' }, description: 'zurück' });
    const z = await m.erstelleZahlung({ betrag_cent: 4790, beschreibung: 'anteilig', webhookUrl: 'https://l.example/v1/webhooks/mollie', sequenceType: 'recurring', customerId: 'cst_a1', mandateId: 'mdt_m1', metadata: { idempotenz: 'stufe:i_x:eigen:2026-10-17' } });
    expect(z).toEqual({ id: 'tr_rec00001', checkoutUrl: null });
    expect(aufrufe.at(-1)!.h.get('idempotency-key')).toBe('stufe:i_x:eigen:2026-10-17');
    await expect(m.erstelleZahlung({ betrag_cent: 1, beschreibung: 'x', webhookUrl: 'u', sequenceType: 'recurring', metadata: {} })).rejects.toThrow(/mandateId/);
    await expect(m.kuendigeAbo('cst_a1', '../x')).rejects.toThrow(/ungültige/);
  });
});

void TAG;
