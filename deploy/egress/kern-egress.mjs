#!/usr/bin/env node
// kern-egress: Ausgangs-Proxy des geteilten Hosts (O1 1.8.2, CONTRACT v1.4 3.7, S1 H1/H2), ohne Abhängigkeiten.
//
// Drei Dienste in einem Prozess:
//   :3128  HTTP-Proxy für die Instanzen (CONNECT für HTTPS, absolute URI für HTTP). Anmeldung je Instanz per
//          Proxy-Authorization Basic  <instanz_id>[.ki]:<egress-token>. Kanal ".ki" = nur Erlaubnisliste.
//   :3129  Verwaltung für den Leitstand (Bearer-Token); Anfragen aus Instanznetzen werden abgewiesen.
//   :3130  TLS-Ask für Caddy On-Demand-TLS: 200 nur für Subdomains registrierter Instanzen.
//
// Regeln für jede Verbindung (Reihenfolge):
//   1. Instanz bekannt, Token stimmt (SHA-256, zeitkonstant), Verbindung kommt aus dem Netz dieser Instanz.
//   2. Nur Port 443 (CONNECT) oder 80 (HTTP).
//   3. Ziel erlaubt: Hosts der Anbieterliste, Freigaben dieser Instanz, Leitstand. Sonst nur, wenn die Instanz
//      web_offen hat und der Kanal nicht ".ki" ist (Webquellen, O1 1.8.2).
//   4. Name auflösen; ist IRGENDEINE Adresse gesperrt (privat, Loopback, Link-Local, Metadaten, ULA, CGNAT,
//      Multicast, Dokumentation, eingebettetes IPv4 in ::ffff:, 64:ff9b::, 2002::), wird abgelehnt.
//   5. Verbunden wird mit genau der geprüften Adresse (kein zweites Auflösen, kein DNS-Rebinding).
// Protokoll: eine JSON-Zeile je Verbindung mit Zeit, Instanz, Kanal, Zielhost, Port, Bytes, Ergebnis. Keine Pfade.
//
// Dateien (Verzeichnis KERN_EGRESS_DIR, Standard /var/lib/kern-egress):
//   anbieter.json            dieselbe Liste wie KERN_ANBIETER_DATEI der Instanzen (Einträge mit url)
//   global.json              { leitstand_hosts: [], gesperrt_zusatz: ["203.0.113.7/32", ...], managed_domain: "kern.example" }
//   instanzen/<id>.json      { id, subdomain, token_sha256, web_offen, netz_ip }   (schreibt kern-host)
//   freigaben/<id>.json      { hosts: [{ host, grund, am }] }                       (schreibt die Verwaltung)
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.KERN_EGRESS_DIR ?? '/var/lib/kern-egress';
const PROXY_PORT = Number(process.env.KERN_EGRESS_PORT ?? 3128);
const ADMIN_PORT = Number(process.env.KERN_EGRESS_ADMIN_PORT ?? 3129);
const ASK_PORT = Number(process.env.KERN_EGRESS_ASK_PORT ?? 3130);
const ADMIN_TOKEN_DATEI = process.env.KERN_EGRESS_ADMIN_TOKEN_DATEI ?? path.join(DIR, 'admin-token');
const VERBINDEN_MS = Number(process.env.KERN_EGRESS_VERBINDEN_MS ?? 10000);
const LEERLAUF_MS = Number(process.env.KERN_EGRESS_LEERLAUF_MS ?? 120000);
const MAX_JE_INSTANZ = Number(process.env.KERN_EGRESS_MAX_JE_INSTANZ ?? 32);
const ID_MUSTER = /^i_[a-z0-9]{10}$/;

// ---------- Adressprüfung ----------
function v4zuZahl(ip) { return ip.split('.').reduce((a, o) => (a << 8n) | BigInt(Number(o)), 0n); }
function v6zuZahl(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  if (s.includes('.')) { // eingebettetes IPv4 am Ende
    const i = s.lastIndexOf(':'); const v4 = v4zuZahl(s.slice(i + 1));
    s = s.slice(0, i + 1) + ((v4 >> 16n) & 0xffffn).toString(16) + ':' + (v4 & 0xffffn).toString(16);
  }
  const [kopf, rumpf] = s.split('::');
  const k = kopf ? kopf.split(':') : []; const r = rumpf !== undefined ? (rumpf ? rumpf.split(':') : []) : [];
  const teile = rumpf !== undefined ? [...k, ...Array(8 - k.length - r.length).fill('0'), ...r] : k;
  if (teile.length !== 8) throw new Error('ungültige IPv6');
  return teile.reduce((a, h) => (a << 16n) | BigInt(parseInt(h || '0', 16)), 0n);
}
function netz(cidr) {
  const [a, l] = cidr.split('/'); const v6 = a.includes(':');
  const bits = v6 ? 128 : 32; const len = l === undefined ? bits : Number(l);
  const z = v6 ? v6zuZahl(a) : v4zuZahl(a);
  const maske = len === 0 ? 0n : ((1n << BigInt(len)) - 1n) << BigInt(bits - len);
  return { v6, basis: z & maske, maske };
}
const GESPERRT_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24',
  '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(netz);
const GESPERRT_V6 = ['::/128', '::1/128', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8', '2001::/32'].map(netz);
let gesperrtZusatz = [];

/** Liefert einen Grund, wenn die Adresse gesperrt ist, sonst null. */
export function adresseGesperrt(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const z = v4zuZahl(ip);
    if ([...GESPERRT_V4, ...gesperrtZusatz.filter((n) => !n.v6)].some((n) => (z & n.maske) === n.basis)) return 'privat_v4';
    return null;
  }
  if (fam === 6) {
    const z = v6zuZahl(ip);
    // eingebettete IPv4-Adressen: ::ffff:a.b.c.d, ::a.b.c.d (veraltet), 64:ff9b::/96 (NAT64), 2002::/16 (6to4)
    const einbett = (n) => [((z >> 24n) & 255n), ((z >> 16n) & 255n), ((z >> 8n) & 255n), (z & 255n)].join('.');
    if ((z >> 32n) === 0xffffn || (z >> 32n) === 0n) return adresseGesperrt(einbett()) ?? null;
    if ((z >> 32n) === (0x0064ff9bn << 64n)) return adresseGesperrt(einbett()) ?? null;
    if ((z >> 112n) === 0x2002n) { const v4 = (z >> 80n) & 0xffffffffn; return adresseGesperrt([v4 >> 24n, (v4 >> 16n) & 255n, (v4 >> 8n) & 255n, v4 & 255n].join('.')); }
    if ([...GESPERRT_V6, ...gesperrtZusatz.filter((n) => n.v6)].some((n) => (z & n.maske) === n.basis)) return 'privat_v6';
    return null;
  }
  return 'keine_ip';
}

// ---------- Konfiguration (Dateien, bei jeder Anfrage mit kurzem Cache) ----------
const cache = new Map();
function leseJson(datei, std) {
  try {
    const st = fs.statSync(datei);
    const c = cache.get(datei);
    if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.wert;
    const wert = JSON.parse(fs.readFileSync(datei, 'utf8'));
    cache.set(datei, { mtime: st.mtimeMs, size: st.size, wert });
    return wert;
  } catch { return std; }
}
const hostAusUrl = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; } };
function global() {
  const g = leseJson(path.join(DIR, 'global.json'), {});
  try { gesperrtZusatz = (g.gesperrt_zusatz ?? []).map(netz); } catch { gesperrtZusatz = []; }
  return g;
}
function anbieterHosts() {
  const roh = leseJson(path.join(DIR, 'anbieter.json'), []);
  const liste = Array.isArray(roh) ? roh : Array.isArray(roh?.anbieter) ? roh.anbieter : [];
  return liste.map((e) => hostAusUrl(e?.url ?? '')).filter(Boolean);
}
function instanz(id) { return ID_MUSTER.test(id) ? leseJson(path.join(DIR, 'instanzen', `${id}.json`), null) : null; }
function freigaben(id) { const f = leseJson(path.join(DIR, 'freigaben', `${id}.json`), { hosts: [] }); return Array.isArray(f.hosts) ? f.hosts : []; }
function passt(host, muster) {
  const m = String(muster).toLowerCase().replace(/\.$/, '');
  if (m.startsWith('*.')) return host.endsWith(m.slice(1)) && host.length > m.length - 1;
  return host === m;
}
function erlaubtListe(id) {
  return [...anbieterHosts(), ...freigaben(id).map((f) => f.host), ...(global().leitstand_hosts ?? [])];
}

// ---------- Protokoll und Zähler ----------
const zaehler = new Map(); // id -> { erlaubt, gesperrt, bytes }
const offen = new Map();
function protokoll(e) {
  const z = zaehler.get(e.instanz ?? '-') ?? { erlaubt: 0, gesperrt: 0, bytes: 0 };
  if (e.ergebnis === 'erlaubt') z.erlaubt++; else z.gesperrt++;
  z.bytes += (e.bytes_aus ?? 0) + (e.bytes_ein ?? 0);
  zaehler.set(e.instanz ?? '-', z);
  process.stdout.write(JSON.stringify({ am: new Date().toISOString(), ...e }) + '\n');
}

// ---------- Prüfung einer Anfrage ----------
function anmeldung(req, sock) {
  const h = req.headers['proxy-authorization'] ?? '';
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (!m) return { fehler: 407, grund: 'ohne_anmeldung' };
  const roh = Buffer.from(m[1], 'base64').toString('utf8');
  const i = roh.indexOf(':'); if (i < 0) return { fehler: 407, grund: 'anmeldung_form' };
  const nutzer = roh.slice(0, i); const pass = roh.slice(i + 1);
  const kanal = nutzer.endsWith('.ki') ? 'ki' : 'web';
  const id = kanal === 'ki' ? nutzer.slice(0, -3) : nutzer;
  const inst = instanz(id);
  if (!inst || typeof inst.token_sha256 !== 'string') return { fehler: 407, grund: 'unbekannt', id: ID_MUSTER.test(id) ? id : null };
  const a = Buffer.from(crypto.createHash('sha256').update(pass).digest('hex'));
  const b = Buffer.from(inst.token_sha256.toLowerCase());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { fehler: 407, grund: 'token', id };
  const lokal = (sock.localAddress ?? '').replace(/^::ffff:/, '');
  if (inst.netz_ip && lokal !== inst.netz_ip) return { fehler: 403, grund: 'falsches_netz', id };
  return { id, kanal, inst };
}

async function pruefeZiel(a, host, port, art) {
  if (!((art === 'connect' && port === 443) || (art === 'http' && port === 80))) return { grund: 'port' };
  host = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const aufListe = erlaubtListe(a.id).some((m) => passt(host, m));
  if (!aufListe && (a.kanal === 'ki' || a.inst.web_offen !== true)) return { grund: 'nicht_freigegeben' };
  let adressen;
  if (net.isIP(host)) adressen = [host];
  else {
    try { adressen = (await dns.lookup(host, { all: true, verbatim: true })).map((x) => x.address); } catch { return { grund: 'dns' }; }
  }
  if (!adressen.length) return { grund: 'dns' };
  for (const ip of adressen) { const g = adresseGesperrt(ip); if (g) return { grund: `adresse_${g}` }; }
  return { ip: adressen[0], host };
}

function belegen(id) {
  const n = offen.get(id) ?? 0;
  if (n >= MAX_JE_INSTANZ) return false;
  offen.set(id, n + 1); return true;
}
function freigeben(id) { offen.set(id, Math.max(0, (offen.get(id) ?? 1) - 1)); }

// ---------- Proxy ----------
const proxy = http.createServer(async (req, res) => {
  // einfaches HTTP über den Proxy (absolute URI)
  const t0 = Date.now();
  const a = anmeldung(req, req.socket);
  if (a.fehler) {
    protokoll({ instanz: a.id ?? null, art: 'http', ergebnis: 'gesperrt', grund: a.grund });
    res.writeHead(a.fehler, a.fehler === 407 ? { 'proxy-authenticate': 'Basic realm="kern-egress"' } : {}); return res.end();
  }
  let ziel;
  try { ziel = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
  if (ziel.protocol !== 'http:') { res.writeHead(400); return res.end(); }
  const port = Number(ziel.port || 80);
  const p = await pruefeZiel(a, ziel.hostname, port, 'http');
  if (!p.ip) { protokoll({ instanz: a.id, kanal: a.kanal, art: 'http', host: ziel.hostname, port, ergebnis: 'gesperrt', grund: p.grund }); res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('kern-egress: gesperrt\n'); }
  if (!belegen(a.id)) { res.writeHead(429); return res.end(); }
  const kopf = { ...req.headers }; delete kopf['proxy-authorization']; delete kopf['proxy-connection']; kopf.host = ziel.host;
  let ein = 0, aus = 0;
  const vor = http.request({ host: p.ip, port, method: req.method, path: ziel.pathname + ziel.search, headers: kopf, timeout: VERBINDEN_MS }, (antwort) => {
    res.writeHead(antwort.statusCode ?? 502, antwort.headers);
    antwort.on('data', (d) => { ein += d.length; });
    antwort.pipe(res);
  });
  req.on('data', (d) => { aus += d.length; });
  const ende = (ergebnis, grund) => { freigeben(a.id); protokoll({ instanz: a.id, kanal: a.kanal, art: 'http', host: p.host, port, ergebnis, grund, bytes_aus: aus, bytes_ein: ein, ms: Date.now() - t0 }); };
  res.on('close', () => ende('erlaubt'));
  vor.on('timeout', () => vor.destroy(new Error('zeit')));
  vor.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
  req.pipe(vor);
});

proxy.on('connect', async (req, sock, kopfRest) => {
  const t0 = Date.now();
  const nein = (code, e) => { protokoll({ art: 'connect', ergebnis: 'gesperrt', ...e }); sock.end(`HTTP/1.1 ${code} ${code === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\n${code === 407 ? 'Proxy-Authenticate: Basic realm="kern-egress"\r\n' : ''}Content-Length: 0\r\n\r\n`); };
  sock.on('error', () => {});
  const a = anmeldung(req, sock);
  if (a.fehler) return nein(a.fehler, { instanz: a.id ?? null, grund: a.grund });
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
  if (!m) return nein(403, { instanz: a.id, grund: 'ziel_form' });
  const host = m[1]; const port = Number(m[2]);
  const p = await pruefeZiel(a, host, port, 'connect');
  if (!p.ip) return nein(403, { instanz: a.id, kanal: a.kanal, host, port, grund: p.grund });
  if (!belegen(a.id)) return nein(403, { instanz: a.id, kanal: a.kanal, host, port, grund: 'zu_viele' });
  let ein = 0, aus = 0, fertig = false;
  const ab = net.connect({ host: p.ip, port, timeout: VERBINDEN_MS });
  const ende = (ergebnis, grund) => {
    if (fertig) return; fertig = true; freigeben(a.id);
    protokoll({ instanz: a.id, kanal: a.kanal, art: 'connect', host: p.host, port, ergebnis, ...(grund ? { grund } : {}), bytes_aus: aus, bytes_ein: ein, ms: Date.now() - t0 });
    sock.destroy(); ab.destroy();
  };
  ab.once('connect', () => {
    ab.setTimeout(LEERLAUF_MS); sock.setTimeout(LEERLAUF_MS);
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (kopfRest?.length) { aus += kopfRest.length; ab.write(kopfRest); }
    sock.on('data', (d) => { aus += d.length; }); ab.on('data', (d) => { ein += d.length; });
    sock.pipe(ab); ab.pipe(sock);
  });
  ab.on('timeout', () => ende(ein + aus ? 'erlaubt' : 'fehler', 'zeit'));
  sock.on('timeout', () => ende('erlaubt', 'leerlauf'));
  ab.on('error', () => { if (!sock.writableEnded && !ein && !aus) sock.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); ende(ein + aus ? 'erlaubt' : 'fehler', 'verbindung'); });
  ab.on('close', () => ende('erlaubt')); sock.on('close', () => ende('erlaubt'));
});

// ---------- Verwaltung (für den Leitstand, A1: GET/POST/DELETE /v1/instanzen/:id/egress) ----------
function adminToken() { try { return fs.readFileSync(ADMIN_TOKEN_DATEI, 'utf8').trim(); } catch { return ''; } }
function json(res, code, wert) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(wert)); }
function koerper(req, max = 64 * 1024) {
  return new Promise((ok, nein) => {
    let n = 0; const teile = [];
    req.on('data', (d) => { n += d.length; if (n > max) { nein(new Error('zu_gross')); req.destroy(); } else teile.push(d); });
    req.on('end', () => { try { ok(teile.length ? JSON.parse(Buffer.concat(teile).toString('utf8')) : {}); } catch { nein(new Error('json')); } });
  });
}
const HOST_MUSTER = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function schreibeFreigaben(id, hosts) {
  fs.mkdirSync(path.join(DIR, 'freigaben'), { recursive: true });
  const datei = path.join(DIR, 'freigaben', `${id}.json`);
  const tmp = `${datei}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2), { mode: 0o640 });
  fs.renameSync(tmp, datei);
}
// Verwaltung und Ask lauschen auf allen Adressen (Docker veröffentlicht Ports auf irgendeine Netzadresse des
// Containers), nehmen aber nichts an, was über ein Instanznetz hereinkommt: Instanzen sollen weder Freigaben ändern
// noch Subdomains anderer Kunden erfragen können.
function ausInstanznetz(sock) {
  const lokal = (sock.localAddress ?? '').replace(/^::ffff:/, '');
  try {
    return fs.readdirSync(path.join(DIR, 'instanzen')).some((f) => f.endsWith('.json') && instanz(f.slice(0, -5))?.netz_ip === lokal);
  } catch { return false; }
}
const admin = http.createServer(async (req, res) => {
  if (ausInstanznetz(req.socket)) return json(res, 403, { fehler: 'nicht aus Instanznetzen', code: 'nicht_erlaubt' });
  const soll = adminToken();
  const ist = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!soll || soll.length < 32 || ist.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll))) return json(res, 401, { fehler: 'Anmeldung fehlt', code: 'nicht_erlaubt' });
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/v1/zaehler') return json(res, 200, Object.fromEntries(zaehler));
  if (req.method === 'GET' && u.pathname === '/healthz') return json(res, 200, { ok: true });
  // Registrierung einer Instanz (für einen Leitstand auf einer anderen Maschine; kern-host schreibt dieselbe Datei)
  const r = /^\/v1\/instanzen\/(i_[a-z0-9]{10})$/.exec(u.pathname);
  if (r) {
    const datei = path.join(DIR, 'instanzen', `${r[1]}.json`);
    try {
      if (req.method === 'GET') { const i = instanz(r[1]); return i ? json(res, 200, { id: i.id, subdomain: i.subdomain, netz_ip: i.netz_ip ?? null, web_offen: i.web_offen === true }) : json(res, 404, { fehler: 'Instanz unbekannt', code: 'nicht_gefunden' }); }
      if (req.method === 'PUT') {
        const b = await koerper(req);
        if (typeof b.subdomain !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(b.subdomain)) return json(res, 400, { fehler: 'subdomain ungültig', code: 'ungueltig' });
        if (typeof b.token_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.token_sha256)) return json(res, 400, { fehler: 'token_sha256 ungültig', code: 'ungueltig' });
        if (b.netz_ip !== undefined && b.netz_ip !== null && net.isIP(b.netz_ip) !== 4) return json(res, 400, { fehler: 'netz_ip ungültig', code: 'ungueltig' });
        if (typeof b.web_offen !== 'boolean') return json(res, 400, { fehler: 'web_offen fehlt', code: 'ungueltig' });
        const fremd = fs.readdirSync(path.join(DIR, 'instanzen')).some((f) => f.endsWith('.json') && f !== `${r[1]}.json` && instanz(f.slice(0, -5))?.subdomain === b.subdomain);
        if (fremd) return json(res, 409, { fehler: 'Subdomain vergeben', code: 'konflikt' });
        const wert = { id: r[1], subdomain: b.subdomain, token_sha256: b.token_sha256, web_offen: b.web_offen, ...(b.netz_ip ? { netz_ip: b.netz_ip } : {}) };
        fs.mkdirSync(path.dirname(datei), { recursive: true });
        const tmp = `${datei}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(wert), { mode: 0o640 }); fs.renameSync(tmp, datei);
        return json(res, 200, { id: r[1], subdomain: wert.subdomain, netz_ip: wert.netz_ip ?? null, web_offen: wert.web_offen });
      }
      if (req.method === 'DELETE') {
        fs.rmSync(datei, { force: true }); fs.rmSync(path.join(DIR, 'freigaben', `${r[1]}.json`), { force: true });
        return json(res, 200, { id: r[1], entfernt: ['registrierung', 'freigaben'] });
      }
    } catch (e) { return json(res, 400, { fehler: String(e.message), code: 'ungueltig' }); }
    return json(res, 405, { fehler: 'Methode', code: 'ungueltig' });
  }
  const m = /^\/v1\/instanzen\/(i_[a-z0-9]{10})\/egress(?:\/([^/]+))?$/.exec(u.pathname);
  if (!m) return json(res, 404, { fehler: 'Nicht gefunden', code: 'nicht_gefunden' });
  const id = m[1];
  if (!instanz(id)) return json(res, 404, { fehler: 'Instanz unbekannt', code: 'nicht_gefunden' });
  const liste = freigaben(id);
  try {
    if (req.method === 'GET' && !m[2]) return json(res, 200, { hosts: liste });
    if ((req.method === 'POST' && !m[2]) || (req.method === 'PUT' && !m[2])) {
      const b = await koerper(req);
      const neu = req.method === 'PUT' ? (Array.isArray(b.hosts) ? b.hosts : null) : [b];
      if (!neu) return json(res, 400, { fehler: 'hosts fehlt', code: 'ungueltig' });
      const sauber = [];
      for (const e of neu) {
        const host = String(e?.host ?? '').toLowerCase().replace(/\.$/, '');
        const grund = String(e?.grund ?? '').slice(0, 200);
        if (!HOST_MUSTER.test(host) || net.isIP(host)) return json(res, 400, { fehler: `ungültiger Host: ${host.slice(0, 80)}`, code: 'ungueltig' });
        if (!grund) return json(res, 400, { fehler: 'grund fehlt', code: 'ungueltig' });
        sauber.push({ host, grund, am: new Date().toISOString() });
      }
      const ergebnis = req.method === 'PUT' ? sauber : [...liste.filter((f) => !sauber.some((s) => s.host === f.host)), ...sauber];
      schreibeFreigaben(id, ergebnis);
      return json(res, 200, { hosts: ergebnis });
    }
    if (req.method === 'DELETE' && m[2]) {
      const host = decodeURIComponent(m[2]).toLowerCase();
      const rest = liste.filter((f) => f.host !== host);
      if (rest.length === liste.length) return json(res, 404, { fehler: 'Freigabe unbekannt', code: 'nicht_gefunden' });
      schreibeFreigaben(id, rest);
      return json(res, 200, { hosts: rest });
    }
  } catch (e) { return json(res, 400, { fehler: String(e.message), code: 'ungueltig' }); }
  return json(res, 405, { fehler: 'Methode', code: 'ungueltig' });
});

// ---------- TLS-Ask für Caddy ----------
const ask = http.createServer((req, res) => {
  if (ausInstanznetz(req.socket)) { res.writeHead(403); return res.end(); }
  const u = new URL(req.url, 'http://x');
  const domain = (u.searchParams.get('domain') ?? '').toLowerCase().replace(/\.$/, '');
  const basis = String(global().managed_domain ?? '').toLowerCase();
  let ok = false;
  if (basis && domain.endsWith('.' + basis)) {
    const sub = domain.slice(0, -(basis.length + 1));
    if (/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(sub)) {
      try {
        ok = fs.readdirSync(path.join(DIR, 'instanzen')).some((f) => f.endsWith('.json') && instanz(f.slice(0, -5))?.subdomain === sub);
      } catch { ok = false; }
    }
  }
  res.writeHead(ok ? 200 : 404); res.end();
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const s of [proxy, admin, ask]) { s.headersTimeout = 15000; s.requestTimeout = 30000; }
  proxy.listen(PROXY_PORT, '0.0.0.0');
  admin.listen(ADMIN_PORT, '0.0.0.0');
  ask.listen(ASK_PORT, '0.0.0.0');
  process.stdout.write(JSON.stringify({ am: new Date().toISOString(), start: true, proxy: PROXY_PORT, admin: ADMIN_PORT, ask: ASK_PORT }) + '\n');
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { proxy.close(); admin.close(); ask.close(); process.exit(0); });
}
