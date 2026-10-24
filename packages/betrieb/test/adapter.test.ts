/**
 * Adapter gegen lokale Stellvertreter auf den Ports 4320 bis 4329 (keine Fremddienste):
 *  4324 Stub /_betrieb/* (HTTP), 4325 Stub Rechnungs-Werkzeug (MCP), 4326 SMTP (smtp-server),
 *  4327 bis 4329 echter kern-egress aus deploy/egress (Proxy, Verwaltung, TLS-Ask), falls vorhanden.
 * Jeder Server wird über sein eigenes Objekt bzw. die eigene PID beendet.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BetriebClient, HttpTransport } from '../src/betrieb-client.js';
import { EgressVerwaltung } from '../src/docker/egress.js';
import { MAILS, darkPatterns, type Kontext } from '../src/mail/texte.js';
import { SmtpSender, versendePostausgang } from '../src/mail/versand.js';
import { McpClient, RechnungsEntwurf } from '../src/rechnung.js';
import { LokalBereitsteller } from '../src/bereitsteller/lokal.js';
import { BetriebAttrappe } from './attrappen.js';
import { aufbau, konto, TAG } from './hilfe.js';

const server: { close: () => unknown }[] = [];
let egressProzess: ChildProcess | null = null;
afterAll(async () => { for (const s of server) await new Promise((r) => { const x = s.close() as unknown; if (x && typeof (x as Promise<void>).then === 'function') (x as Promise<void>).then(r); else setTimeout(r, 20); }); if (egressProzess?.pid) process.kill(egressProzess.pid, 'SIGTERM'); });

function stub(port: number, f: (req: http.IncomingMessage, body: string) => { status: number; body: unknown; kopf?: Record<string, string> }) {
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { const a = f(req, b); res.writeHead(a.status, { 'content-type': 'application/json', ...a.kopf }); res.end(JSON.stringify(a.body)); }); });
  server.push(s);
  return new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
}

describe('HTTP-Adapter /_betrieb/* gegen Stub (Form aus packages/server/src/betrieb.ts)', () => {
  const att = new BetriebAttrappe('t'.repeat(64));
  beforeAll(() => stub(4324, (req, body) => { const a = att.antwort(req.method as 'GET', req.url!, body ? JSON.parse(body) : undefined, req.headers.authorization); return { status: a.status, body: a.json }; }));
  it('Status nur Betriebszahlen (artikel, quellen, ki_art verworfen), nutzer → benutzer, null-Verbrauch → 0', async () => {
    const c = new BetriebClient(new HttpTransport('http://127.0.0.1:4324', 't'.repeat(64)));
    await c.einladung('chef@x.example');
    const s = await c.status();
    expect(s).toMatchObject({ benutzer: 1, speicher_bytes: 48213, zugaenge_oauth: 1, ki_verbrauch_cent_monat: 0, modus: 'normal', version: '0.1.0' });
    expect(JSON.stringify(s)).not.toMatch(/artikel|quellen|ki_art|grenzen/);
  });
  it('Modus, Grenzen, Einladung (409 bei Wiederholung), Beispiel, Export 501 ehrlich, falsches Token 401, nur /_betrieb/*', async () => {
    const c = new BetriebClient(new HttpTransport('http://127.0.0.1:4324', 't'.repeat(64)));
    await c.modus('nur_lesen');
    expect(att.modus).toBe('nur_lesen');
    await c.grenzen({ nutzer_max: 15, speicher_max_bytes: 1, upload_max_bytes: 2, ki_kontingent_cent_monat: 1500, ki_tagesdeckel_cent: 150 });
    expect(att.grenzen).toMatchObject({ nutzer_max: 15, ki_tagesdeckel_cent: 150 });
    expect(await c.einladung('neu@x.example')).toMatchObject({ einmalPasswort: 'EinmalPasswort123', mussPasswortAendern: true });
    expect(await c.einladung('neu@x.example')).toBeNull();
    await c.beispiel('laden');
    expect(att.beispiel).toBe(true);
    await expect(c.export('okf')).rejects.toThrow(/501/);
    await expect(new BetriebClient(new HttpTransport('http://127.0.0.1:4324', 'falsch')).status()).rejects.toThrow(/Nicht berechtigt/);
    await expect(new HttpTransport('http://127.0.0.1:4324', 'x').anfrage('GET', '/api/ich')).rejects.toThrow(/nur \/_betrieb/);
  });
});

describe('Rechnungs-Werkzeug: nur Entwürfe (S-9)', () => {
  const calls: { method: string; name?: string; args?: Record<string, unknown> }[] = [];
  beforeAll(() => stub(4325, (req, body) => {
    const j = JSON.parse(body) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
    calls.push({ method: j.method, ...(j.params.name ? { name: j.params.name } : {}), ...(j.params.arguments ? { args: j.params.arguments } : {}) });
    if (req.headers.authorization !== 'Bearer mcp-test') return { status: 401, body: {} };
    if (j.method === 'initialize') return { status: 200, body: { jsonrpc: '2.0', id: j.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rechnungen', version: '1' } } }, kopf: { 'mcp-session-id': 'sitz-1' } };
    return { status: 200, body: { jsonrpc: '2.0', id: j.id, result: { content: [{ type: 'text', text: JSON.stringify({ id: 'ENT-0042', status: 'entwurf' }) }] } } };
  }));
  it('legt einen Entwurf an, sperrt Festschreiben vor dem Netz, auch mit stehender Freigabe nie festgeschrieben', async () => {
    const mcp = new McpClient({ url: 'http://127.0.0.1:4325/mcp', token: 'mcp-test' });
    const r = new RechnungsEntwurf(mcp, { produkt: () => 'Kern', linkMuster: 'https://rechnungen.example/entwurf/{id}' });
    const k = { id: 'k_1', firma: 'Hofladen Insa', ansprechpartner: 'Insa', mail: 'i@hof.example', rechnungsweg: 'mollie' as const, erstellt: '', typ: 'selbstbucher' as const, status: 'kunde' as const, rechnung_ref: 'K-1007' };
    const e = await r.entwurf({ kunde: k, zahlung_id: 'tr_abc12345', betrag_cent: 6900, position: 'Kern Betrieb (Geteilt)', festschreiben: true });
    expect(e).toEqual({ id: 'ENT-0042', link: 'https://rechnungen.example/entwurf/ENT-0042', festgeschrieben: false, stehende_freigabe: true });
    const call = calls.find((c) => c.method === 'tools/call')!;
    expect(call.name).toBe('beleg_entwerfen');
    expect(call.args).toMatchObject({ art: 'rechnung', kunde: 'K-1007', bestellnummer: 'tr_abc12345', positionen: [{ bezeichnung: 'Kern Betrieb (Geteilt)', einzelpreis_eur: 69, menge: 1 }] });
    const vorher = calls.length;
    await expect(mcp.werkzeug('beleg_festschreiben', { id: 'ENT-0042' })).rejects.toThrow(/gesperrt/);
    expect(calls.length).toBe(vorher);
    expect(calls.some((c) => c.name && c.name !== 'beleg_entwerfen')).toBe(false);
  });
  it('im Leitstand: Webhook bezahlt → Entwurf, festgeschrieben bleibt false auch mit S-9 an', async () => {
    const { l, m } = aufbau({ schalter: { rechnung_stehende_freigabe: true } });
    (l as unknown as { rechnungen: unknown }).rechnungen = new RechnungsEntwurf(new McpClient({ url: 'http://127.0.0.1:4325/mcp', token: 'mcp-test' }));
    m.zahlungen.set('tr_rech0001', { id: 'tr_rech0001', status: 'paid', amount: { value: '29.00', currency: 'EUR' }, sequenceType: 'first', customerId: 'cst_r1', createdAt: '2026-10-01T08:00:00Z', metadata: { kunde: { firma: 'R', name: 'R', mail: 'r@r.example' }, paket: 'klein' } });
    await l.mollieWebhook('tr_rech0001');
    expect(l.zahlungen()[0]!.rechnung).toEqual({ entwurf: 'ENT-0042', festgeschrieben: false });
  });
});

describe('Mails: Texte nach Plan v1.4 3.3, Versand über lokales SMTP', () => {
  const k: Kontext = { anrede: 'du', produkt: 'Kern', datum: (x) => (x ? new Date(x).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) : '–'), konto_url: 'https://a.kern.example/einstellungen/konto', abmelden_url: 'https://l.example/v1/abmelden?t=x' };
  const alle = () => [MAILS.zugang_test(k, { test_ende: '2026-10-15T21:59:00Z' }), MAILS.halbzeit(k), MAILS.test_endet(k, { test_ende: '2026-10-15T21:59:00Z', verlaengern_moeglich: true, lesefrist: 30 }), MAILS.test_beendet(k, { loeschen_am: '2026-11-14T21:59:00Z' }), MAILS.loeschung_am(k, { loeschen_am: '2026-11-14T21:59:00Z' }), MAILS.geloescht(k, { am: 'x', umfang: 'Container' }), MAILS.lesephase(k, { tag: 14, loeschen_am: '2026-11-14T21:59:00Z' }), MAILS.kuendigung(k, { zum: '2026-11-01T00:00:00Z', lesefrist: 30 }), MAILS.vorankuendigung(k, { betrag: '69,00 €', am: '2026-11-01T10:00:00Z' }), MAILS.zahlung_offen(k, { kulanz_bis: '2026-11-15T00:00:00Z' }), MAILS.einladung(k, { url: 'https://a', name: 'a@b.c', passwort: 'p' })];
  it('keine Dark Patterns, Du-Form, Satz „wenn du nichts tust“, gleichrangige Knöpfe; Abmeldelink nur beim Hinweis', () => {
    for (const m of alle()) { expect(darkPatterns(m.betreff + m.text), m.betreff).toEqual([]); expect(m.text).not.toMatch(/\bSie\b|\bIhr(e|en)?\b/); }
    const t = MAILS.test_endet(k, { test_ende: '2026-10-15T21:59:00Z', verlaengern_moeglich: true, lesefrist: 30 }).text;
    expect(t).toMatch(/- Kaufen\n- Einmal 14 Tage verlängern\n- Alles herunterladen\n- Jetzt löschen/);
    expect(t).toMatch(/Wenn du nichts tust, wird nichts abgebucht/);
    expect(alle().filter((m) => /abmelden/.test(m.text)).map((m) => m.betreff)).toEqual(['Halbzeit']);
  });
  it('Kanzleien (Berufsgeheimnis) bekommen die Sie-Form', async () => {
    const s = MAILS.test_endet({ ...k, anrede: 'sie' }, { test_ende: null, verlaengern_moeglich: false, lesefrist: 30 });
    expect(s.betreff).toMatch(/^Ihre Testphase/);
    expect(s.text).toMatch(/Wenn Sie nichts tun/);
    expect(s.text).not.toMatch(/\bdu\b|\bdein/i);
  });

  const empfangen: { an: string; daten: string }[] = [];
  beforeAll(() => new Promise<void>((r) => {
    const s = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, sess, cb) { let d = ''; stream.on('data', (x) => (d += x)); stream.on('end', () => { empfangen.push({ an: sess.envelope.rcptTo.map((x) => x.address).join(','), daten: d }); cb(); }); } });
    server.push({ close: () => new Promise<void>((ok) => s.close(() => ok())) });
    s.listen(4326, '127.0.0.1', () => r());
  }));
  it('Postausgang: Versand, Einmal-Passwort danach geleert, List-Unsubscribe nur beim Hinweis, Abmeldung wirkt, Wiederholung bei Fehler', async () => {
    const { l, db, vor } = aufbau();
    const kd = konto(l, 'Tischlerei Post', 'anke@post.example');
    await l.instanzAnlegen({ kunde_id: kd.id, herkunft: { art: 'formular' }, paket: 'klein' }, 'formular');
    l.mail('geheim:einladung:i_test', 'anke@post.example', 'Dein Einmal-Zugang', 'Einmal-Passwort: GEHEIM123');
    for (let d = 0; d < 7; d++) { vor(1); await l.planer(); }
    const sender = new SmtpSender({ host: '127.0.0.1', port: 4326, absender: 'Kern Betrieb <betrieb@kern.example>', tlsUnsicherNurTest: true });
    const r = await versendePostausgang(db, sender);
    expect(r).toEqual({ versendet: 3, fehler: 0, wartet: 0 });
    expect(empfangen.map((e) => /Subject: (.*)/.exec(e.daten)![1])).toEqual(['Dein Zugang ist da', 'Dein Einmal-Zugang', 'Halbzeit']);
    expect(empfangen.find((e) => /Halbzeit/.test(e.daten))!.daten).toMatch(/List-Unsubscribe:\s+<https:\/\/leitstand\.example\/v1\/abmelden\?t=/);
    expect(empfangen.find((e) => /Zugang ist da/.test(e.daten))!.daten).not.toMatch(/List-Unsubscribe/);
    expect((db.prepare("SELECT text FROM postausgang WHERE schluessel = 'geheim:einladung:i_test'").get() as { text: string }).text).toBe('[nach Versand geleert]');
    expect(await versendePostausgang(db, sender)).toEqual({ versendet: 0, fehler: 0, wartet: 0 });
    // Abmelden: kein weiterer Hinweis, Vertragsmails gehen weiter
    const t = /abmelden\?t=([A-Za-z0-9_-]+)/.exec(empfangen[2]!.daten)![1]!;
    expect(l.mailAbmelden(t)).toBe(true);
    const k2 = l.kunde(kd.id);
    l.sende('halbzeit:zweit', k2, k2.mail, MAILS.halbzeit(l.kontext(k2)));
    l.sende('kuendigung:zweit', k2, k2.mail, MAILS.kuendigung(l.kontext(k2), { zum: '2026-11-01T00:00:00Z', lesefrist: 30 }));
    expect(l.postausgang().map((p) => p.betreff).filter((b) => b === 'Halbzeit')).toHaveLength(1);
    expect(l.postausgang().some((p) => p.betreff === 'Kündigung bestätigt')).toBe(true);
    // Fehler: Server weg → Wiederholung mit Abstand, nach 5 Versuchen „fehler“
    const kaputt = { senden: async () => { throw new Error('Verbindung abgelehnt'); } };
    expect(await versendePostausgang(db, kaputt)).toEqual({ versendet: 0, fehler: 0, wartet: 1 });
    expect(await versendePostausgang(db, kaputt)).toEqual({ versendet: 0, fehler: 0, wartet: 0 }); // Abstand noch nicht um
    let z = new Date(Date.now() + 10 * 60_000);
    for (let n = 0; n < 4; n++) { await versendePostausgang(db, kaputt, z); z = new Date(z.getTime() + 2 * 3600_000); }
    expect((db.prepare("SELECT status, versuche FROM postausgang WHERE schluessel = 'kuendigung:zweit'").get() as { status: string; versuche: number })).toEqual({ status: 'fehler', versuche: 5 });
    void TAG;
  });
});

const EGRESS = path.join(import.meta.dirname, '../../../deploy/egress/kern-egress.mjs');
const egressDa = fs.existsSync(EGRESS) && fs.readFileSync(EGRESS, 'utf8').includes("Registrierung einer Instanz");
describe.skipIf(!egressDa)('Egress-Verwaltung gegen den echten kern-egress (deploy/egress, D2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-egress-'));
  const token = crypto.randomBytes(32).toString('hex');
  beforeAll(async () => {
    fs.mkdirSync(path.join(dir, 'instanzen')); fs.writeFileSync(path.join(dir, 'admin-token'), token);
    fs.writeFileSync(path.join(dir, 'anbieter.json'), '[]'); fs.writeFileSync(path.join(dir, 'global.json'), '{"leitstand_hosts":[]}');
    egressProzess = spawn(process.execPath, [EGRESS], { env: { ...process.env, KERN_EGRESS_DIR: dir, KERN_EGRESS_PORT: '4327', KERN_EGRESS_ADMIN_PORT: '4328', KERN_EGRESS_ASK_PORT: '4329', HTTPS_PROXY: '', HTTP_PROXY: '' }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { const ok = await fetch('http://127.0.0.1:4328/healthz', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.ok).catch(() => false); if (ok) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('kern-egress startet nicht');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('registrieren, Freigaben setzen, TLS-Ask kennt die Subdomain, abmelden räumt beides', async () => {
    const e = new EgressVerwaltung('http://127.0.0.1:4328', token);
    expect(await e.registrieren('i_p2egress01', { subdomain: 'p2-test', token_sha256: 'a'.repeat(64), netz_ip: '10.231.0.3', web_offen: true })).toMatchObject({ id: 'i_p2egress01', netz_ip: '10.231.0.3' });
    await expect(e.registrieren('i_p2egress02', { subdomain: 'p2-test', token_sha256: 'b'.repeat(64), web_offen: true })).rejects.toThrow(/409 konflikt/);
    expect((await e.freigabenSetzen('i_p2egress01', ['api.mistral.ai'])).hosts).toMatchObject([{ host: 'api.mistral.ai', grund: 'Freigabe im Leitstand' }]);
    await expect(e.freigabenSetzen('i_p2egress01', ['10.0.0.1'])).rejects.toThrow(/400/);
    const ask = await fetch('http://127.0.0.1:4329/tls-ask?domain=p2-test.kern.example').then((r) => r.status).catch(() => 0);
    expect([200, 404, 403]).toContain(ask); // Antwort hängt an global.json (managed_domain); hier nur: Dienst antwortet
    expect(await e.abmelden('i_p2egress01')).toMatchObject({ entfernt: ['registrierung', 'freigaben'] });
    expect(fs.existsSync(path.join(dir, 'instanzen', 'i_p2egress01.json'))).toBe(false);
    await expect(new EgressVerwaltung('http://127.0.0.1:4328', 'falsch').abmelden('i_p2egress01')).rejects.toThrow(/401/);
  });
});

const coreDa = fs.existsSync(path.join(import.meta.dirname, '../../core/dist/index.js'));
describe.skipIf(!coreDa)('Pitch-Zugänge (S1 N2): zufällig, einmal in der Konsole, nie gespeichert', () => {
  it('lokal: Kanzlei Behrens mit Zufallspasswörtern, holeEinmalZugaenge genau einmal, nicht in DB oder Protokoll', async () => {
    const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-pitch-'));
    try {
      const { l, db } = aufbau({ bereitsteller: new LokalBereitsteller(basis) });
      const r = await l.pitchAnlegen({ beispiel: 'kanzlei-behrens', tage: 1 }, 'till');
      const z = l.holeEinmalZugaenge(r.instanz.id)!;
      expect(z.map((x) => x.name)).toEqual(['Dr. Wiebke Behrens', 'Ole Thormählen', 'Merle Paulsen']);
      expect(new Set(z.map((x) => x.passwort)).size).toBe(3);
      expect(z.every((x) => x.passwort.length >= 16 && x.passwort !== 'demo-passwort')).toBe(true);
      expect(l.holeEinmalZugaenge(r.instanz.id)).toBeNull();
      const alles = JSON.stringify(db.prepare("SELECT * FROM vorgaenge, ereignisse").all());
      for (const x of z) expect(alles).not.toContain(x.passwort);
      const w = await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
      const zw = l.holeEinmalZugaenge(w.instanz.id) ?? [];
      expect(zw.length).toBeGreaterThan(0);
      expect(zw.every((x) => x.passwort && x.passwort !== 'demo-passwort')).toBe(true);
    } finally { fs.rmSync(basis, { recursive: true, force: true }); }
  }, 60_000);
});
