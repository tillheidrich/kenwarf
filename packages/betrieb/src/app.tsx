/**
 * HTTP-Schicht: Konsole (HTML-Formulare, Sitzung + CSRF), /v1-API (JSON, Bearer-Token oder Sitzung, Idempotency-Key)
 * und der Mollie-Webhook (ohne Login, Antwort immer 200). Alles ruft den Leitstand, nichts greift an ihm vorbei.
 */
import fs from 'node:fs';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { Leitstand, InstanzEingabe } from './leitstand.js';
import { Admins, Ratenlimit, Sitzungen } from './auth.js';
import type { Passkeys } from './passkey.js';
import { LeitstandFehler, type KontoTyp, type Paket, type Region, type KiVorlage, type Beispiel, type InstanzStatus, INSTANZ_STATUS, KONTO_TYPEN } from './typen.js';
import { AbrechnungSeite, AnmeldeSeite, SicherheitSeite, SchalterSeite, HostsSeite, type HostMitLast, HeuteSeite, InstanzenSeite, InstanzSeite, KontoNeuSeite, KontoSeite, KundenSeite, NeueInstanzSeite, PartnerSeite, ProtokollSeite } from './konsole/seiten.js';
import type { SeitenKontext } from './konsole/ui.js';

type Env = { Variables: { admin: string; csrf: string } };

export interface AppOptionen {
  leitstand: Leitstand;
  admins: Admins;
  /** Passkeys (WebAuthn); ohne bleibt nur Passwort plus TOTP. */
  passkeys?: Passkeys;
  /** Passwort plus TOTP abschalten, sobald ein Passkey existiert. */
  nurPasskey?: boolean;
  secret: string;
  secureCookie?: boolean;
  /** Öffentliche Adresse der Website für Empfehlungslinks. */
  websiteUrl?: string;
  trustProxy?: boolean;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const statisch = (datei: string) => {
  const url = new URL(`./konsole/${datei}`, import.meta.url);
  return () => fs.readFileSync(url);
};

export function erstelleApp(o: AppOptionen) {
  const { leitstand: l, admins } = o;
  const app = new Hono<Env>();
  const sitzungen = new Sitzungen(o.secret);
  const limitName = new Ratenlimit(5, 15 * 60_000);
  const limitIp = new Ratenlimit(20, 15 * 60_000);
  const cookie = o.secureCookie ? '__Host-leitstand' : 'leitstand';
  const css = statisch('stil.css');
  const js = statisch('konsole.js');
  const pkjs = statisch('passkey.js');
  const nurPasskey = () => !!o.nurPasskey && !!o.passkeys && o.passkeys.anzahl() > 0;

  const ip = (c: Context) => (o.trustProxy ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined) ?? (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'lokal';

  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', c.req.path.startsWith('/_k/') ? 'public, max-age=3600' : 'no-store');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  });
  app.use('*', bodyLimit({ maxSize: 256 * 1024 }));

  app.get('/_k/stil.css', (c) => c.body(css(), 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/_k/konsole.js', (c) => c.body(js(), 200, { 'content-type': 'text/javascript; charset=utf-8' }));
  app.get('/_k/passkey.js', (c) => c.body(pkjs(), 200, { 'content-type': 'text/javascript; charset=utf-8' }));
  app.get('/_k/fonts/:datei', (c) => {
    const d = c.req.param('datei');
    if (!/^[a-z0-9-]+\.woff2$/.test(d)) return c.notFound();
    try { return c.body(fs.readFileSync(new URL(`./konsole/fonts/${d}`, import.meta.url)), 200, { 'content-type': 'font/woff2' }); } catch { return c.notFound(); }
  });
  app.get('/healthz', (c) => c.json({ ok: true }));

  // ---------- Mollie-Webhook (öffentlich) ----------
  app.post('/v1/webhooks/mollie', async (c) => {
    let zid = '';
    try { const f = await c.req.parseBody(); zid = String(f.id ?? ''); } catch { /* leer */ }
    try { await l.mollieWebhook(zid); } catch (e) { l.ereignis('mollie', 'webhook_fehler', null, { meldung: (e as Error).message.slice(0, 200) }); }
    return c.text('', 200); // immer 200, Mollie wiederholt sonst; Verarbeitung ist idempotent
  });

  // ---------- Rückruf aus cloud-init einer eigenen Maschine (Einmal-Token, öffentlich) ----------
  app.post('/v1/rueckruf/:id', async (c) => {
    const id = c.req.param('id');
    const b = l.bereitsteller as { rueckruf?: (id: string, t: string, body: { ipv4?: string }) => boolean; eigen?: { rueckruf: (id: string, t: string, body: { ipv4?: string }) => boolean } | null };
    const ziel = b.rueckruf ? b : b.eigen ?? null;
    const h = c.req.header('authorization') ?? '';
    const body = (await c.req.json().catch(() => ({}))) as { ipv4?: string };
    const ok = !!ziel && /^i_[a-z0-9]{10}$/.test(id) && h.startsWith('Bearer ') && ziel.rueckruf!(id, h.slice(7), body);
    l.ereignis('hetzner', ok ? 'rueckruf' : 'rueckruf_abgelehnt', ok ? id : null);
    return ok ? c.json({ ok: true }) : c.json({ fehler: 'nicht erlaubt', code: 'nicht_erlaubt' }, 401);
  });

  // ---------- Hinweis-Mails abbestellen (nur Hinweise; Vertragsmails gehen weiter) ----------
  const abmelden = (c: Context) => {
    const ok = l.mailAbmelden(c.req.query('t') ?? '');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Abbestellt</title><p>${ok ? 'Erledigt. Du bekommst keine Hinweise mehr. Mails zu Vertrag, Fristen und Löschung kommen weiter, weil sie nötig sind.' : 'Dieser Link ist ungültig.'}</p>`, ok ? 200 : 404);
  };
  app.get('/v1/abmelden', abmelden);
  app.post('/v1/abmelden', abmelden);

  // ---------- Konto-Brücke aus der Instanz (v1.4 3.5): Bearer KERN_KONTO_TOKEN, gilt nur für die eigene Instanz ----------
  const kontoFehler = (c: Context, e: unknown) => {
    if (e instanceof LeitstandFehler) return c.json({ fehler: e.message, code: e.code }, e.code === 'nicht_gefunden' ? 404 : e.code === 'konflikt' ? 409 : e.code === 'nicht_erlaubt' ? 403 : e.code === 'ungueltig' ? 400 : 500);
    return c.json({ fehler: 'intern', code: 'intern' }, 500);
  };
  const konto = (f: (iid: string, b: Record<string, unknown>) => unknown) => async (c: Context) => {
    const h = c.req.header('authorization');
    const iid = l.instanzZuKontoToken(h?.startsWith('Bearer ') ? h.slice(7) : undefined);
    if (!iid) return c.json({ fehler: 'Konto-Token fehlt oder ungültig', code: 'nicht_erlaubt' }, 401);
    try {
      const schreibend = c.req.method !== 'GET';
      if (schreibend && !/^[A-Za-z0-9-]{8,80}$/.test(c.req.header('idempotency-key') ?? '')) return c.json({ fehler: 'Idempotency-Key fehlt', code: 'ungueltig' }, 400);
      const body = schreibend ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      const r = await f(iid, body);
      return c.json(r as object, c.req.path.endsWith('/stufe') || c.req.path.endsWith('/umzug') ? 202 : 200);
    } catch (e) { return kontoFehler(c, e); }
  };
  app.get('/v1/konto', konto((iid) => l.konto(iid)));
  app.post('/v1/konto/kaufen', konto((iid, b) => l.kontoKaufen(iid, { paket: String(b.paket) as Paket, stufe: b.stufe === 'eigene_maschine' ? 'eigene_maschine' : 'geteilt', intervall: b.intervall === 'jahr' ? 'jahr' : 'monat' })));
  app.post('/v1/konto/stufe', konto((iid, b) => l.kontoStufe(iid, b.ziel === 'eigene_maschine' ? 'eigene_maschine' : 'geteilt')));
  app.post('/v1/konto/kuendigen', konto((iid) => l.kontoKuendigen(iid)));
  app.post('/v1/konto/kuendigung-zuruecknehmen', konto((iid) => l.kontoKuendigungZuruecknehmen(iid)));
  app.post('/v1/konto/test-verlaengern', konto((iid) => l.kontoTestVerlaengern(iid)));
  app.post('/v1/konto/loeschen', konto((iid, b) => l.kontoLoeschen(iid, String(b.bestaetigung ?? ''))));
  app.post('/v1/konto/umzug', konto(async (iid, b) => { const r = await l.umzugStarten(iid, b.ziel === 'lokal' ? 'lokal' : 'eigene_cloud', undefined, 'konto'); return { vorgang: r.vorgang.id }; }));
  app.post('/v1/konto/egress-anfrage', konto((iid, b) => l.kontoEgressAnfrage(iid, String(b.host ?? ''), String(b.zweck ?? ''))));
  // Bestätigungslink aus der Mail: GET zeigt nur eine Rückfrage (Mail-Scanner klicken Links), erst POST löscht.
  app.get('/v1/konto/loeschen/bestaetigen', (c) => {
    const t = c.req.query('t') ?? '';
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return c.text('Link ungültig', 400);
    return c.html(<html lang="de"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Löschung bestätigen</title><link rel="stylesheet" href="/_k/stil.css" /></head>
      <body class="anmelde-body"><main class="anmeldung"><h1>Instanz endgültig löschen?</h1><p class="still">Alle Daten werden gelöscht. Das lässt sich nicht rückgängig machen. Lade vorher deinen Export herunter, wenn du ihn noch brauchst.</p>
        <form method="post" action="/v1/konto/loeschen/bestaetigen" class="formular"><input type="hidden" name="t" value={t} /><button class="knopf knopf--gefahr knopf--voll" type="submit">Ja, jetzt löschen</button></form></main></body></html>);
  });
  app.post('/v1/konto/loeschen/bestaetigen', async (c) => {
    const f = await c.req.parseBody();
    try { await l.kontoLoeschenBestaetigen(String(f.t ?? '')); return c.html(<html lang="de"><head><meta charset="utf-8" /><title>Gelöscht</title><link rel="stylesheet" href="/_k/stil.css" /></head><body class="anmelde-body"><main class="anmeldung"><h1>Gelöscht</h1><p class="still">Das Löschprotokoll kommt per Mail.</p></main></body></html>); }
    catch (e) { return c.text(e instanceof LeitstandFehler ? e.message : 'Fehler', 400); }
  });

  // ---------- Anmeldung ----------
  app.get('/anmelden', (c) => c.html(<AnmeldeSeite ersteinrichtung={admins.anzahl() === 0} nurPasskey={nurPasskey()} fehler={c.req.query('fehler') ? 'Anmeldung fehlgeschlagen.' : null} />));
  app.post('/anmelden/passkey/optionen', async (c) => {
    if (!o.passkeys) return c.json({ fehler: 'Passkeys nicht eingerichtet' }, 404);
    if (limitIp.gesperrt(`ip:${ip(c)}`)) return c.json({ fehler: 'Zu viele Versuche' }, 429);
    return c.json(await o.passkeys.anmeldeOptionen());
  });
  app.post('/anmelden/passkey', async (c) => {
    if (!o.passkeys) return c.json({ fehler: 'Passkeys nicht eingerichtet' }, 404);
    const ipk = `ip:${ip(c)}`;
    if (limitIp.gesperrt(ipk)) return c.json({ fehler: 'Zu viele Versuche' }, 429);
    try {
      const b = (await c.req.json()) as { schluessel: string; antwort: never };
      const name = await o.passkeys.anmelden(String(b.schluessel), b.antwort);
      const s = sitzungen.erstelle(name);
      setCookie(c, cookie, s.cookie, { httpOnly: true, sameSite: 'Strict', secure: !!o.secureCookie, path: '/', maxAge: 8 * 3600 });
      l.ereignis(name, 'angemeldet', null, { weg: 'passkey' });
      return c.json({ ok: true, weiter: '/heute' });
    } catch (e) {
      limitIp.fehlschlag(ipk);
      l.ereignis('unbekannt', 'anmeldung_fehlgeschlagen', null, { weg: 'passkey' });
      return c.json({ fehler: 'Passkey nicht akzeptiert' }, 401);
    }
  });
  app.post('/anmelden', async (c) => {
    if (nurPasskey()) return c.redirect('/anmelden?fehler=1', 303);
    const f = await c.req.parseBody();
    const name = String(f.name ?? '').trim().toLowerCase();
    const schl = `n:${name}`, ipk = `ip:${ip(c)}`;
    if (limitName.gesperrt(schl) || limitIp.gesperrt(ipk)) { l.ereignis(name || 'unbekannt', 'anmeldung_gesperrt', null, { ip: ipk }); return c.redirect('/anmelden?fehler=1', 303); }
    if (!admins.pruefe(name, String(f.passwort ?? ''), String(f.code ?? '').trim())) {
      limitName.fehlschlag(schl); limitIp.fehlschlag(ipk);
      l.ereignis(name || 'unbekannt', 'anmeldung_fehlgeschlagen', null);
      return c.redirect('/anmelden?fehler=1', 303);
    }
    limitName.zuruecksetzen(schl);
    const s = sitzungen.erstelle(name);
    setCookie(c, cookie, s.cookie, { httpOnly: true, sameSite: 'Strict', secure: !!o.secureCookie, path: '/', maxAge: 8 * 3600 });
    l.ereignis(name, 'angemeldet', null, { weg: 'passwort+totp' });
    return c.redirect('/heute', 303);
  });

  // ---------- Schutz für alles Weitere ----------
  const bearer = (c: Context) => { const h = c.req.header('authorization'); return h?.startsWith('Bearer ') ? h.slice(7) : undefined; };
  app.use('*', async (c, next) => {
    const t = admins.tokenPruefe(bearer(c));
    if (t && c.req.path.startsWith('/v1/')) { c.set('admin', t); c.set('csrf', ''); return next(); }
    const s = sitzungen.pruefe(getCookie(c, cookie));
    if (!s) return c.req.path.startsWith('/v1/') ? c.json({ fehler: 'Anmeldung nötig', code: 'nicht_erlaubt' }, 401) : c.redirect('/anmelden', 303);
    c.set('admin', s.name);
    c.set('csrf', s.csrf);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      let token = c.req.header('x-leitstand-csrf');
      if (!token && !c.req.path.startsWith('/v1/')) { const f = await c.req.parseBody(); token = String(f._csrf ?? ''); }
      if (token !== s.csrf) return c.req.path.startsWith('/v1/') ? c.json({ fehler: 'CSRF', code: 'nicht_erlaubt' }, 403) : c.text('Sitzung abgelaufen oder Formular veraltet. Seite neu laden.', 403);
    }
    return next();
  });

  const kx = (c: Context<Env>): SeitenKontext => ({ pfad: c.req.path, admin: c.get('admin'), csrf: c.get('csrf'), meldung: c.req.query('meldung') ?? null, fehler: c.req.query('fehler') ?? null });
  const zurueck = (pfad: string, art: 'meldung' | 'fehler', text: string) => `${pfad}${pfad.includes('?') ? '&' : '?'}${art}=${encodeURIComponent(text)}`;
  const form = async (c: Context) => { const f = await c.req.parseBody(); const g = (n: string) => (typeof f[n] === 'string' ? (f[n] as string).trim() : ''); return g; };
  const aktion = (pfad: (c: Context<Env>) => string, f: (c: Context<Env>, g: (n: string) => string) => Promise<string | void> | string | void) =>
    async (c: Context<Env>) => {
      const ziel = pfad(c);
      try {
        const g = await form(c);
        const r = await f(c, g);
        return c.redirect(typeof r === 'string' && r.startsWith('/') ? r : zurueck(ziel, 'meldung', r || 'Erledigt.'), 303);
      } catch (e) {
        const msg = e instanceof LeitstandFehler ? e.message : 'Interner Fehler, Details im Protokoll.';
        if (!(e instanceof LeitstandFehler)) l.ereignis(c.get('admin'), 'fehler', null, { pfad: c.req.path, meldung: (e as Error).message.slice(0, 200) });
        return c.redirect(zurueck(ziel, 'fehler', msg), 303);
      }
    };

  app.get('/', (c) => c.redirect('/heute', 303));
  app.post('/abmelden', (c) => { sitzungen.beende(getCookie(c, cookie)); deleteCookie(c, cookie, { path: '/' }); l.ereignis(c.get('admin'), 'abgemeldet', null); return c.redirect('/anmelden', 303); });

  const hostsMitLast = async (stufe?: 'geteilt'): Promise<HostMitLast[]> => Promise.all(l.hosts(stufe).map(async (h) => ({ h, last: await l.hostLast(h.id) })));
  app.get('/heute', async (c) => c.html(<HeuteSeite l={l} k={kx(c)} hosts={await hostsMitLast('geteilt')} />));
  app.get('/hosts', async (c) => c.html(<HostsSeite l={l} k={kx(c)} hosts={await hostsMitLast()} />));
  app.post('/hosts', aktion(() => '/hosts', (c, g) => { const h = l.hostAnlegen({ id: g('id'), name: g('name'), region: (g('region') || 'de-nbg') as Region, aktiv: true, kapazitaet: { container_max: Number(g('container_max')), ram_mb: Number(g('ram_mb')), speicher_bytes: Number(g('speicher_gb')) * 1024 ** 3 } }, c.get('admin')); return `Host ${h.id} angelegt.`; }));
  app.post('/hosts/:id/aktiv', aktion(() => '/hosts', (c, g) => { l.hostAendern(c.req.param('id')!, { aktiv: g('aktiv') === '1' }, c.get('admin')); return 'Gespeichert.'; }));
  app.post('/planer', aktion(() => '/heute', async () => { const r = await l.planer(); return `Planer: ${r.automatisch.length} automatisch erledigt, ${r.klick.length} brauchen deinen Klick.`; }));

  // Instanzen
  app.get('/instanzen', (c) => { const s = c.req.query('status'); return c.html(<InstanzenSeite l={l} k={kx(c)} filter={s && (INSTANZ_STATUS as readonly string[]).includes(s) ? s : null} />); });
  app.get('/instanzen/neu', (c) => c.html(<NeueInstanzSeite l={l} k={kx(c)} art={c.req.query('art') === 'pitch' ? 'pitch' : 'kunde'} kundeId={c.req.query('kunde') ?? null} />));
  app.post('/instanzen', aktion(() => '/instanzen/neu', async (c, g) => {
    const neuKonto = !g('kunde_id');
    const e: InstanzEingabe = {
      ...(neuKonto
        ? { kunde: { firma: g('firma'), ansprechpartner: g('ansprechpartner'), mail: g('mail'), typ: (g('typ') || 'direkt') as KontoTyp, rechnungsweg: g('zahlung') === 'rechnung' ? 'rechnung' : g('zahlung') === 'frei' ? 'keiner' : 'mollie', ...(g('quelle') ? { quelle: g('quelle') } : {}), ...(g('empfehlungscode') ? { empfehlungscode: g('empfehlungscode'), zuordnung_weg: 'manuell', zuordnung_zustimmung: g('zuordnung_zustimmung') === '1' } : {}) } as never }
        : { kunde_id: g('kunde_id') }),
      herkunft: { art: 'manuell', ...(g('empfehlungscode') && g('zuordnung_zustimmung') === '1' ? { empfehlungscode: g('empfehlungscode') } : {}) },
      paket: (g('paket') || 'betrieb') as Paket,
      region: (g('region') || 'de-nbg') as Region,
      ki_vorlage: (g('ki_vorlage') || 'mock') as KiVorlage,
      stufe: g('stufe') === 'eigen' ? 'eigen' : 'geteilt',
      zahlung: (['test', 'rechnung', 'frei'].includes(g('zahlung')) ? g('zahlung') : 'test') as 'test',
      beispiel: (g('beispiel') || null) as Beispiel | null,
      ...(g('subdomain') ? { subdomain: g('subdomain') } : {}),
      ...(g('admin_mail') ? { admin_mail: g('admin_mail') } : {}),
    };
    if (neuKonto && !g('firma')) throw new LeitstandFehler('ungueltig', 'Konto wählen oder Firma eintragen');
    const r = await l.instanzAnlegen(e, c.get('admin'), g('_idem') || undefined);
    return zurueck(`/instanzen/${r.instanz.id}`, r.vorgang.status === 'fertig' ? 'meldung' : 'fehler', r.vorgang.status === 'fertig' ? 'Instanz angelegt.' : 'Anlage gescheitert, siehe Vorgang.');
  }));
  app.post('/instanzen/pitch', aktion(() => '/instanzen/neu?art=pitch', async (c, g) => {
    const r = await l.pitchAnlegen({ beispiel: g('beispiel') as Beispiel, tage: Number(g('tage') || 7), ...(g('fuer') ? { fuer: g('fuer') } : {}) }, c.get('admin'), g('_idem') || undefined);
    return zurueck(`/instanzen/${r.instanz.id}`, 'meldung', 'Pitch läuft. Die Demo-Zugänge stehen einmalig auf dieser Seite.');
  }));
  app.get('/instanzen/:id', (c) => {
    let i;
    try { i = l.instanz(c.req.param('id')); } catch { return c.notFound(); }
    const zugaenge = l.holeEinmalZugaenge(i.id); // genau einmal sichtbar
    if (zugaenge) c.header('Cache-Control', 'no-store');
    return c.html(<InstanzSeite l={l} k={kx(c)} i={i} zugaenge={zugaenge} />);
  });
  const ip_ = (c: Context<Env>) => `/instanzen/${c.req.param('id')}`;
  app.post('/instanzen/:id/verlaengern', aktion(ip_, (c, g) => { const i = l.testVerlaengern(c.req.param('id')!, Number(g('tage')), g('grund'), c.get('admin')); return `Verlängert bis ${new Date(i.test_ende!).toLocaleDateString('de-DE')}.`; }));
  app.post('/instanzen/:id/pausieren', aktion(ip_, async (c, g) => { await l.pausieren(c.req.param('id')!, g('grund'), c.get('admin')); return 'Pausiert.'; }));
  app.post('/instanzen/:id/fortsetzen', aktion(ip_, async (c) => { await l.fortsetzen(c.req.param('id')!, c.get('admin')); return 'Fortgesetzt.'; }));
  app.post('/instanzen/:id/aktivieren', aktion(ip_, async (c, g) => { await l.aktivieren(c.req.param('id')!, g('zahlung') === 'frei' ? 'frei' : 'rechnung', g('referenz') || undefined, c.get('admin')); return 'Aktiv.'; }));
  app.post('/instanzen/:id/uebernehmen', aktion(ip_, async (c, g) => { await l.demoUebernehmen(c.req.param('id')!, g('kunde_id'), c.get('admin')); return 'Übernommen, Testphase läuft.'; }));
  app.post('/instanzen/:id/export', aktion(ip_, async (c, g) => { const v = await l.exportieren(c.req.param('id')!, g('art') === 'umzugspaket' ? 'umzugspaket' : 'okf', c.get('admin')); if (v.status !== 'fertig') throw new LeitstandFehler('intern', 'Export gescheitert, siehe Vorgang'); return 'Export liegt in der Instanz, Link ging an deren Admin.'; }));
  app.post('/instanzen/:id/stufe', aktion(ip_, async (c, g) => { if (g('zeitpunkt') === 'nacht') { const r = l.stufeWechselnNachts(c.req.param('id')!, g('nach') === 'eigen' ? 'eigen' : 'geteilt', c.get('admin')); return `Vorgemerkt für ${new Date(r.ab).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}.`; } const r = await l.stufeWechseln(c.req.param('id')!, g('nach') === 'eigen' ? 'eigen' : 'geteilt', c.get('admin'), g('_idem') || undefined); if (r.vorgang.status !== 'fertig') throw new LeitstandFehler('konflikt', `Stufenwechsel gescheitert und zurückgebaut: ${r.vorgang.schritte.find((s) => s.status === 'fehler')?.meldung ?? ''}`); return `Läuft jetzt auf ${r.instanz.stufe === 'eigen' ? 'eigener Maschine' : 'geteiltem Host'} (${r.instanz.host}).`; }));
  app.post('/instanzen/:id/stufe-absagen', aktion(ip_, (c) => { l.wechselAbsagen(c.req.param('id')!, c.get('admin')); return 'Geplanter Wechsel abgesagt.'; }));
  app.post('/instanzen/:id/egress', aktion(ip_, async (c, g) => { await l.egressFreigeben(c.req.param('id')!, g('host'), g('grund'), c.get('admin')); return 'Freigegeben.'; }));
  app.post('/instanzen/:id/egress-entziehen', aktion(ip_, async (c, g) => { await l.egressEntziehen(c.req.param('id')!, g('host'), g('grund') || 'entzogen', c.get('admin')); return 'Entzogen.'; }));
  app.post('/egress-anfragen/:id/ablehnen', aktion(() => '/heute', (c) => { l.egressAblehnen(Number(c.req.param('id')), c.get('admin')); return 'Abgelehnt.'; }));
  app.post('/instanzen/:id/kuendigen', aktion(ip_, (c) => { const r = l.kontoKuendigen(c.req.param('id')!, c.get('admin')); return `Gekündigt zum ${new Date(r.kuendigung_zum).toLocaleDateString('de-DE')}.`; }));
  app.post('/instanzen/:id/kuendigung-zuruecknehmen', aktion(ip_, (c) => { l.kontoKuendigungZuruecknehmen(c.req.param('id')!, c.get('admin')); return 'Kündigung zurückgenommen.'; }));
  app.post('/instanzen/:id/umzug', aktion(ip_, async (c, g) => { await l.umzugStarten(c.req.param('id')!, g('ziel') === 'lokal' ? 'lokal' : 'eigene_cloud', g('ziel_url') || undefined, c.get('admin')); return 'Umzug läuft, alte Instanz nur lesend.'; }));
  app.post('/instanzen/:id/umzug/bestaetigen', aktion(ip_, async (c, g) => { await l.umzugBestaetigen(c.req.param('id')!, g('pruefbericht_sha256'), c.get('admin')); return 'Umzug bestätigt.'; }));
  app.post('/instanzen/:id/loeschen', aktion(ip_, async (c, g) => { const i = await l.loeschungPlanen(c.req.param('id')!, { bestaetigung: g('bestaetigung'), grund: g('grund'), sofort: g('sofort') === '1', beleg: g('beleg') }, c.get('admin')); return i.status === 'geloescht' ? 'Gelöscht, Beleg im Protokoll.' : `Löschung geplant zum ${new Date(i.loeschen_am!).toLocaleDateString('de-DE')}.`; }));
  app.post('/instanzen/:id/loeschung-abbrechen', aktion(ip_, (c) => { l.loeschungAbbrechen(c.req.param('id')!, c.get('admin')); return 'Löschung abgebrochen.'; }));
  app.post('/vorgaenge/:id/wiederholen', aktion((c) => { try { return `/instanzen/${l.vorgang(c.req.param('id')!).instanz_id}`; } catch { return '/instanzen'; } }, async (c) => { const r = await l.vorgangWiederholen(c.req.param('id')!, c.get('admin')); if (r.vorgang.status !== 'fertig') throw new LeitstandFehler('intern', 'Erneut gescheitert'); return 'Vorgang fertig.'; }));

  // Konten
  app.get('/kunden', (c) => { const t = c.req.query('typ'); return c.html(<KundenSeite l={l} k={kx(c)} suche={c.req.query('q') ?? ''} typ={t && t in KONTO_TYPEN ? (t as KontoTyp) : null} />); });
  app.get('/kunden/neu', (c) => c.html(<KontoNeuSeite l={l} k={kx(c)} />));
  const kontoAusForm = (g: (n: string) => string) => ({
    firma: g('firma'), ansprechpartner: g('ansprechpartner'), mail: g('mail'), typ: (g('typ') || 'direkt') as KontoTyp, status: (g('status') || 'interessent') as never,
    rechnungsweg: (['mollie', 'rechnung', 'keiner'].includes(g('rechnungsweg')) ? g('rechnungsweg') : 'rechnung') as 'rechnung',
    ...(g('telefon') ? { telefon: g('telefon') } : {}), berufsgeheimnis: g('berufsgeheimnis') === '1', quelle: g('quelle') || undefined, notizen: g('notizen') || undefined, rechnung_ref: g('rechnung_ref') || undefined,
  });
  app.post('/kunden', aktion(() => '/kunden/neu', (c, g) => { const x = l.kundeAnlegen({ ...kontoAusForm(g), ...(g('empfehlungscode') ? { empfehlungscode: g('empfehlungscode'), zuordnung_weg: 'manuell' as const, zuordnung_zustimmung: g('zuordnung_zustimmung') === '1' } : {}) }, c.get('admin')); return zurueck(`/kunden/${x.id}`, 'meldung', 'Konto angelegt.'); }));
  app.get('/kunden/:id', (c) => { try { return c.html(<KontoSeite l={l} k={kx(c)} x={l.kunde(c.req.param('id'))} />); } catch { return c.notFound(); } });
  app.post('/kunden/:id', aktion((c) => `/kunden/${c.req.param('id')}`, (c, g) => { l.kundeAendern(c.req.param('id')!, { ...kontoAusForm(g), empfehlungscode: g('empfehlungscode'), zuordnung_zustimmung: g('zuordnung_zustimmung') === '1' }, c.get('admin')); return 'Gespeichert.'; }));

  // Partner
  app.get('/partner', (c) => c.html(<PartnerSeite l={l} k={kx(c)} basisUrl={o.websiteUrl ?? 'https://kern.example.org'} />));
  app.post('/partner', aktion(() => '/partner', (c, g) => { const p = l.partnerAnlegen({ code: g('code'), name: g('name'), art: (g('art') || 'empfehler') as never, provision_prozent: Number(g('provision_prozent') || 0), laufzeit_monate: Number(g('laufzeit_monate') || 0), aktiv: true, ...(g('mail') ? { mail: g('mail') } : {}), ...(g('vereinbarung') ? { vereinbarung: g('vereinbarung') } : {}) }, c.get('admin')); return `Partner ${p.code} angelegt.`; }));
  app.post('/partner/auszahlung', aktion(() => '/partner', (c, g) => { const s = l.auszahlungVermerken(g('code'), g('monat'), g('vermerk'), c.get('admin')); return `Auszahlung über ${(s / 100).toFixed(2).replace('.', ',')} € vermerkt.`; }));

  app.get('/sicherheit', (c) => c.html(<SicherheitSeite k={kx(c)} passkeys={o.passkeys?.liste(c.get('admin')) ?? []} nurPasskey={nurPasskey()} />));
  app.post('/sicherheit/passkey/optionen', async (c) => { if (!o.passkeys) return c.json({ fehler: 'Passkeys nicht eingerichtet' }, 404); return c.json(await o.passkeys.registrierOptionen(c.get('admin'))); });
  app.post('/sicherheit/passkey', async (c) => {
    if (!o.passkeys) return c.json({ fehler: 'Passkeys nicht eingerichtet' }, 404);
    try {
      const b = (await c.req.json()) as { schluessel: string; antwort: never; name?: string };
      const r = await o.passkeys.registrieren(c.get('admin'), String(b.schluessel), b.antwort, String(b.name ?? 'Passkey'));
      l.ereignis(c.get('admin'), 'passkey_hinzugefuegt', null, { name: String(b.name ?? 'Passkey').slice(0, 60) });
      return c.json(r);
    } catch (e) { return c.json({ fehler: (e as Error).message.slice(0, 120) }, 400); }
  });
  app.post('/sicherheit/passkey/:id/entfernen', aktion(() => '/sicherheit', (c) => { o.passkeys?.entfernen(c.get('admin'), c.req.param('id')!); l.ereignis(c.get('admin'), 'passkey_entfernt', null); return 'Passkey entfernt.'; }));
  app.get('/schalter', (c) => c.html(<SchalterSeite l={l} k={kx(c)} />));
  app.post('/schalter', aktion(() => '/schalter', (c, g) => {
    const an = (n: string) => g(n) === '1';
    l.setzeSchalter({
      test_ki: an('test_ki'), managed_domain: g('managed_domain') || null, produkt_name: g('produkt_name') || 'Kern', preise_oeffentlich: an('preise_oeffentlich'),
      kauf_offen: an('kauf_offen'), tests_offen: an('tests_offen'), abgrenzung_vermerk: g('abgrenzung_vermerk') || null, neue_tests_pausiert: an('neue_tests_pausiert'),
      zeitrahmen_stunden_monat: Number(g('zeitrahmen_stunden_monat') || 5), rechnung_stehende_freigabe: an('rechnung_stehende_freigabe'), leitstand_oeffentlich: an('leitstand_oeffentlich'),
      lesefrist_tage: Number(g('lesefrist_tage') || 30), berufsgeheimnis_offen: an('berufsgeheimnis_offen'), partner_provisionen: an('partner_provisionen'),
    }, c.get('admin'));
    return 'Schalter gespeichert, Änderung im Protokoll.';
  }));
  app.get('/abrechnung', (c) => c.html(<AbrechnungSeite l={l} k={kx(c)} />));
  app.get('/protokoll', (c) => { const a = c.req.query('ansicht'); return c.html(<ProtokollSeite l={l} k={kx(c)} ansicht={a === 'loeschungen' ? 'loeschungen' : a === 'post' ? 'post' : 'ereignisse'} />); });

  // ---------- /v1 JSON (O1 1.5) ----------
  const fehlerJson = (c: Context, e: unknown) => {
    if (e instanceof LeitstandFehler) return c.json({ fehler: e.message, code: e.code }, e.code === 'nicht_gefunden' ? 404 : e.code === 'konflikt' ? 409 : e.code === 'nicht_erlaubt' ? 403 : e.code === 'ungueltig' ? 400 : 500);
    return c.json({ fehler: 'intern', code: 'intern' }, 500);
  };
  const v1 = (f: (c: Context<Env>, body: Record<string, unknown>) => Promise<unknown> | unknown, opt: { idem?: boolean; status?: 200 | 201 | 202 } = {}) => async (c: Context<Env>) => {
    try {
      const schreibend = c.req.method !== 'GET';
      const idem = c.req.header('idempotency-key');
      if (schreibend && opt.idem !== false && !(idem && /^[A-Za-z0-9-]{8,80}$/.test(idem))) return c.json({ fehler: 'Idempotency-Key fehlt', code: 'ungueltig' }, 400);
      const body = schreibend ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      const r = await f(c, body);
      return c.json(r as object, opt.status ?? 200);
    } catch (e) { return fehlerJson(c, e); }
  };
  app.get('/v1/uebersicht', v1(() => l.uebersicht()));
  app.get('/v1/kunden', v1((c) => l.kunden({ suche: c.req.query('suche') ?? '' })));
  app.get('/v1/kunden/:id', v1((c) => l.kunde(c.req.param('id')!)));
  app.post('/v1/kunden', v1((c, b) => l.kundeAnlegen(b as never, c.get('admin')), { status: 201 }));
  app.patch('/v1/kunden/:id', v1((c, b) => l.kundeAendern(c.req.param('id')!, b as never, c.get('admin'))));
  app.get('/v1/instanzen', v1((c) => { const s = c.req.query('status'); return l.instanzen({ ...(s ? { status: s as InstanzStatus } : {}), ...(c.req.query('herkunft') ? { herkunft: c.req.query('herkunft') as never } : {}), ...(c.req.query('partner') ? { partner: c.req.query('partner')! } : {}) }); }));
  app.get('/v1/instanzen/:id', v1((c) => l.aktualisiereBetrieb(c.req.param('id')!)));
  app.post('/v1/instanzen', v1((c, b) => l.instanzAnlegen(b as unknown as InstanzEingabe, c.get('admin'), c.req.header('idempotency-key')), { status: 202 }));
  app.post('/v1/instanzen/:id/pausieren', v1((c, b) => l.pausieren(c.req.param('id')!, String(b.grund ?? ''), c.get('admin'))));
  app.post('/v1/instanzen/:id/fortsetzen', v1((c) => l.fortsetzen(c.req.param('id')!, c.get('admin'))));
  app.post('/v1/instanzen/:id/test-verlaengern', v1((c, b) => l.testVerlaengern(c.req.param('id')!, Number(b.tage), String(b.grund ?? ''), c.get('admin'))));
  app.post('/v1/instanzen/:id/aktivieren', v1((c, b) => l.aktivieren(c.req.param('id')!, b.zahlung === 'mollie' ? 'mollie' : 'rechnung', typeof b.referenz === 'string' ? b.referenz : undefined, c.get('admin'))));
  app.post('/v1/instanzen/:id/export', v1((c, b) => l.exportieren(c.req.param('id')!, b.art === 'umzugspaket' ? 'umzugspaket' : 'okf', c.get('admin')), { status: 202 }));
  app.post('/v1/instanzen/:id/umzug', v1((c, b) => l.umzugStarten(c.req.param('id')!, b.ziel === 'lokal' ? 'lokal' : b.ziel === 'hd' ? 'hd' : 'eigene_cloud', typeof b.ziel_url === 'string' ? b.ziel_url : undefined, c.get('admin')), { status: 202 }));
  app.post('/v1/instanzen/:id/umzug/bestaetigen', v1((c, b) => l.umzugBestaetigen(c.req.param('id')!, String(b.pruefbericht_sha256 ?? ''), c.get('admin'))));
  app.delete('/v1/instanzen/:id', v1((c, b) => l.loeschungPlanen(c.req.param('id')!, { bestaetigung: String(b.bestaetigung ?? ''), grund: String(b.grund ?? ''), sofort: b.sofort === true, ...(typeof b.beleg === 'string' ? { beleg: b.beleg } : {}) }, c.get('admin'))));
  app.post('/v1/instanzen/:id/loeschung-abbrechen', v1((c) => l.loeschungAbbrechen(c.req.param('id')!, c.get('admin'))));
  app.post('/v1/instanzen/:id/stufe', v1((c, b) => l.stufeWechseln(c.req.param('id')!, b.nach === 'eigen' ? 'eigen' : 'geteilt', c.get('admin'), c.req.header('idempotency-key')), { status: 202 }));
  app.get('/v1/hosts', v1(async () => Promise.all(l.hosts().map(async (h) => ({ ...h, last: await l.hostLast(h.id) })))));
  app.get('/v1/instanzen/:id/egress', v1((c) => ({ freigaben: l.egressListe(c.req.param('id')!) })));
  app.post('/v1/instanzen/:id/egress', v1(async (c, b) => ({ freigaben: await l.egressFreigeben(c.req.param('id')!, String(b.host ?? ''), String(b.grund ?? ''), c.get('admin')) })));
  app.delete('/v1/instanzen/:id/egress', v1(async (c, b) => ({ freigaben: await l.egressEntziehen(c.req.param('id')!, String(b.host ?? ''), String(b.grund ?? ''), c.get('admin')) })));
  app.get('/v1/schalter', v1(() => l.schalter()));
  app.post('/v1/hosts', v1((c, b) => l.hostAnlegen(b as never, c.get('admin')), { status: 201 }));
  app.get('/v1/vorgaenge/:id', v1((c) => l.vorgang(c.req.param('id')!)));
  app.get('/v1/vorgaenge', v1((c) => l.vorgaenge({ ...(c.req.query('instanz_id') ? { instanz_id: c.req.query('instanz_id')! } : {}) })));
  app.get('/v1/ereignisse', v1((c) => l.ereignisse({ ...(c.req.query('instanz_id') ? { instanz_id: c.req.query('instanz_id')! } : {}), ...(c.req.query('seit') ? { seit: c.req.query('seit')! } : {}) })));
  app.get('/v1/partner', v1(() => l.partnerListe()));
  app.post('/v1/partner', v1((c, b) => l.partnerAnlegen(b as never, c.get('admin')), { status: 201 }));
  app.patch('/v1/partner/:code', v1((c, b) => l.partnerAendern(c.req.param('code')!, b as never, c.get('admin'))));
  app.get('/v1/partner/:code/zahlen', v1((c) => l.partnerZahlen(c.req.param('code')!)));
  app.get('/v1/auszahlungen', v1(() => l.auszahlungsliste()));
  app.get('/v1/loeschbelege', v1(() => l.loeschbelege()));

  return { app, sitzungen };
}
