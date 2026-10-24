// Rauchtest gegen eine laufende Instanz über die REST-API (ohne Browser).
// Prüft: healthz, Anmeldung, Hinzufügen (Text, PDF, DOCX), belegte Antwort je Datei mit Zitat, das wörtlich in der
// Quelle steht, interne Pfade nicht an die SPA (O-1). Gibt eine JSON-Zeile mit dem Ergebnis aus; Exitcode 1 bei Fehler.
//
//   node e2e/rauchtest/rauchtest.mjs --url http://127.0.0.1:4312 --name admin --passwort-datei /pfad
//
// Keine Inhalte im Ergebnis außer Status und Zählwerten (Ergebnis darf veröffentlicht werden).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const basis = arg('url', 'http://127.0.0.1:4312').replace(/\/$/, '');
const name = arg('name', 'admin');
const passwort = arg('passwort') ?? fs.readFileSync(arg('passwort-datei'), 'utf8').trim();

let cookie = '';
async function api(methode, pfad, body, extra = {}) {
  const h = { 'x-kern': '1', ...(cookie ? { cookie } : {}), ...(extra.headers ?? {}) };
  let b = body;
  if (body && !(body instanceof FormData)) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(basis + pfad, { method: methode, headers: h, body: b, redirect: 'manual' });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

const ergebnis = { url: basis, schritte: [], bestanden: false };
const schritt = (n, ok, info = {}) => { ergebnis.schritte.push({ n, ok, ...info }); if (!ok) throw new Error(n); };
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

async function frageUndPruefe(frage, schluessel) {
  const t0 = performance.now();
  const r = await api('POST', '/api/frage', { frage });
  const ms = Math.round(performance.now() - t0);
  const a = r.json ?? {};
  const belege = Array.isArray(a.belege) ? a.belege : [];
  let zitatGeprueft = false;
  for (const b of belege) {
    const q = await api('GET', '/api/quellen/' + b.quelle.split('/').map(encodeURIComponent).join('/'));
    const roh = norm(q.text);
    if (b.zitat && roh.includes(norm(b.zitat).slice(0, 60))) { zitatGeprueft = true; break; }
    // Zitat liegt eventuell als JSON-escaped String vor
    if (b.zitat && norm(JSON.stringify(q.json ?? '')).includes(norm(JSON.stringify(b.zitat)).slice(1, 50))) { zitatGeprueft = true; break; }
  }
  const trefferSchluessel = belege.some((b) => norm(b.zitat).toLowerCase().includes(schluessel.toLowerCase()));
  schritt(`frage:${schluessel}`, r.status === 200 && a.status === 'beantwortet' && belege.length > 0 && zitatGeprueft && trefferSchluessel,
    { http: r.status, status: a.status, belege: belege.length, zitat_geprueft: zitatGeprueft, ms, ki_erzeugt: a.ki_erzeugt ?? null });
}

try {
  const h = await api('GET', '/healthz');
  schritt('healthz', h.status === 200 && h.json?.ok === true, { version: h.json?.version ?? null });
  const l = await api('POST', '/api/login', { name, passwort });
  schritt('anmelden', l.status === 200, { http: l.status });

  const t = await api('POST', '/api/hinzufuegen', { art: 'text', titel: 'Werkstattregeln', inhalt: '# Werkstattregeln\n\n## Absaugung\n\nDie Absaugung wird jeden Freitag um 15 Uhr gereinigt.\n', sammlung: 'rauchtest' });
  schritt('hinzufuegen:text', t.status === 201, { http: t.status });
  for (const [datei, typ] of [['lieferzeiten.pdf', 'application/pdf'], ['urlaub.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
    const fd = new FormData();
    fd.set('datei', new Blob([fs.readFileSync(path.join(hier, '..', 'fixtures', datei))], { type: typ }), datei);
    fd.set('sammlung', 'rauchtest');
    const r = await api('POST', '/api/hinzufuegen', fd);
    schritt(`hinzufuegen:${datei}`, r.status === 201, { http: r.status, ...(r.status !== 201 ? { fehler: r.json?.fehler?.slice(0, 120) ?? null } : {}) });
  }
  await frageUndPruefe('Wann wird die Absaugung gereinigt?', 'Absaugung');
  await frageUndPruefe('Welche Lieferzeit haben Beschlaege von Hettich?', 'Hettich');
  await frageUndPruefe('Wann muss ich einen Urlaubsantrag einreichen?', 'Urlaubsantr');

  const wk = await api('GET', '/.well-known/rauchtest-x');
  schritt('well-known-nicht-spa', wk.status === 404 && wk.json !== null, { http: wk.status });
  const bt = await api('GET', '/_betrieb/status');
  schritt('betrieb-ohne-token', bt.status === 401 || bt.status === 404, { http: bt.status });
  ergebnis.bestanden = true;
} catch (e) {
  ergebnis.fehler = String(e.message ?? e);
}
console.log(JSON.stringify(ergebnis));
process.exit(ergebnis.bestanden ? 0 : 1);
