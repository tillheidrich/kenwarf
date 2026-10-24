import { describe, expect, it } from 'vitest';
import { Admins, totp, totpZaehler, pruefeTotp, base32, base32Decode } from '../src/auth.js';
import { erstelleApp } from '../src/app.js';
import { aufbau, konto } from './hilfe.js';

function app() {
  const a = aufbau();
  const admins = new Admins(a.db);
  const { secret } = admins.anlegen('till', 'ein-langes-passwort-123');
  const { app: h } = erstelleApp({ leitstand: a.l, admins, secret: 'x'.repeat(40) });
  return { ...a, admins, secret, h };
}

async function anmelden(h: ReturnType<typeof app>['h'], secret: string, ms = Date.now()) {
  const body = new URLSearchParams({ name: 'till', passwort: 'ein-langes-passwort-123', code: totp(secret, totpZaehler(ms)) });
  const r = await h.request('/anmelden', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
  const seite = await h.request('/heute', { headers: { cookie } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await seite.text())?.[1] ?? '';
  return { r, cookie, csrf };
}

describe('TOTP (RFC 6238)', () => {
  it('stimmt mit dem RFC-Testvektor überein (SHA-1, 59 s → 94287082 → 287082)', () => {
    const s = base32(Buffer.from('12345678901234567890'));
    expect(totp(s, totpZaehler(59_000))).toBe('287082');
    expect(base32Decode(s).toString()).toBe('12345678901234567890');
    expect(pruefeTotp(s, '287082', 59_000)).toBe(1);
    expect(pruefeTotp(s, '000000', 59_000)).toBeNull();
  });
});

describe('Anmeldung', () => {
  it('ohne Anmeldung: Konsole leitet um, API 401', async () => {
    const { h } = app();
    expect((await h.request('/heute')).status).toBe(303);
    expect((await h.request('/v1/instanzen')).status).toBe(401);
  });
  it('Passwort allein reicht nicht; derselbe Code gilt nur einmal', async () => {
    const { h, secret, admins } = app();
    const ohne = await h.request('/anmelden', { method: 'POST', body: new URLSearchParams({ name: 'till', passwort: 'ein-langes-passwort-123', code: '000000' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(ohne.headers.get('location')).toMatch(/fehler/);
    const code = totp(secret, totpZaehler(Date.now()));
    expect(admins.pruefe('till', 'ein-langes-passwort-123', code)).toBe(true);
    expect(admins.pruefe('till', 'ein-langes-passwort-123', code)).toBe(false);
  });
  it('sperrt nach 5 Fehlversuchen je Name', async () => {
    const { h, secret } = app();
    for (let n = 0; n < 5; n++) await h.request('/anmelden', { method: 'POST', body: new URLSearchParams({ name: 'till', passwort: 'falsch', code: '123456' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const { r } = await anmelden(h, secret);
    expect(r.headers.get('location')).toMatch(/fehler/);
  });
  it('Passwort unter 14 Zeichen wird abgelehnt', () => {
    const { admins } = app();
    expect(() => admins.anlegen('zweiter', 'kurz')).toThrow(/14/);
  });
});

describe('Konsole', () => {
  it('alle Seiten antworten nach Anmeldung, mit strenger CSP', async () => {
    const { h, secret, l } = app();
    const { cookie } = await anmelden(h, secret);
    const k = konto(l);
    const i = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein' }, 'till');
    for (const p of ['/heute', '/instanzen', '/instanzen/neu', '/instanzen/neu?art=pitch', `/instanzen/${i.instanz.id}`, '/hosts', '/kunden', `/kunden/${k.id}`, '/kunden/neu', '/partner', '/abrechnung', '/protokoll', '/protokoll?ansicht=loeschungen', '/protokoll?ansicht=post']) {
      const r = await h.request(p, { headers: { cookie } });
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    }
  });
  it('Formular ohne CSRF-Token wird abgewiesen', async () => {
    const { h, secret } = app();
    const { cookie } = await anmelden(h, secret);
    const r = await h.request('/instanzen/pitch', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ beispiel: 'tischlerei-wendt' }) });
    expect(r.status).toBe(403);
  });
  it('Pitch in einem Klick über das Formular, doppeltes Absenden legt nur einen an', async () => {
    const { h, secret, l } = app();
    const { cookie, csrf } = await anmelden(h, secret);
    const body = () => new URLSearchParams({ _csrf: csrf, _idem: 'pitch-klick-1', beispiel: 'kanzlei-behrens', tage: '3' });
    const r1 = await h.request('/instanzen/pitch', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body() });
    await h.request('/instanzen/pitch', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: body() });
    expect(r1.status).toBe(303);
    expect(l.instanzen({ status: 'demo' })).toHaveLength(1);
    expect(l.ereignisse().some((e) => e.wer === 'till' && e.was === 'instanz_anlegen')).toBe(true);
  });
});

describe('/v1-API', () => {
  it('schreibende Aufrufe brauchen Idempotency-Key; Bearer-Token funktioniert', async () => {
    const { h, admins } = app();
    const t = admins.tokenErzeugen('website');
    const auth = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
    const ohne = await h.request('/v1/kunden', { method: 'POST', headers: auth, body: JSON.stringify({ firma: 'A', ansprechpartner: '', mail: 'a@a.example', typ: 'direkt', rechnungsweg: 'rechnung' }) });
    expect(ohne.status).toBe(400);
    const mit = await h.request('/v1/kunden', { method: 'POST', headers: { ...auth, 'idempotency-key': 'k-12345678' }, body: JSON.stringify({ firma: 'A', ansprechpartner: '', mail: 'a@a.example', typ: 'direkt', rechnungsweg: 'rechnung' }) });
    expect(mit.status).toBe(201);
    const k = (await mit.json()) as { id: string };
    const inst = await h.request('/v1/instanzen', { method: 'POST', headers: { ...auth, 'idempotency-key': 'i-12345678' }, body: JSON.stringify({ kunde_id: k.id, herkunft: { art: 'formular' }, paket: 'klein' }) });
    expect(inst.status).toBe(202);
    const { instanz } = (await inst.json()) as { instanz: { id: string } };
    const status = (await (await h.request(`/v1/instanzen/${instanz.id}`, { headers: auth })).json()) as Record<string, unknown>;
    expect(Object.keys(status.betrieb as object).sort()).toEqual(['backup_letztes', 'backup_ok', 'benutzer', 'health', 'ki_kontingent_cent_monat', 'ki_verbrauch_cent_monat', 'letzte_anmeldung_tag', 'modus', 'speicher_bytes', 'zugaenge_oauth']);
    expect(status.stufe).toBe('geteilt');
  });
  it('Mollie-Webhook antwortet immer 200, auch bei Unsinn', async () => {
    const { h } = app();
    const r = await h.request('/v1/webhooks/mollie', { method: 'POST', body: new URLSearchParams({ id: 'quatsch' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(200);
  });
  it('Fehlerform { fehler, code }', async () => {
    const { h, admins } = app();
    const t = admins.tokenErzeugen('x');
    const r = await h.request('/v1/instanzen/i_nichtda000', { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ fehler: 'Instanz nicht gefunden', code: 'nicht_gefunden' });
  });
});
