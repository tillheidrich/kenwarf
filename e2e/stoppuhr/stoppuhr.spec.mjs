// Stoppuhr-Test (CONTRACT v1.4 4.5), Weg `docker_run`: frischer Container aus dem Image -> Einrichtung im Browser ->
// erster Zugang -> Unterlagen hochladen -> erste Frage -> Antwort mit Status "beantwortet" und Beleg, dessen Zitat
// wörtlich in der Quelle steht. Gemessen ab "docker run" bis die belegte Antwort sichtbar ist.
// Sollwert (4.5): Maschinenzeit <= 120 s und <= 15 Klicks; harte Grenze dieses Auftrags: 5 Minuten.
// Ergebnis: e2e/stoppuhr/ergebnis.json { weg, maschinenzeit_sek, klicks, bestanden, version, ... } (veröffentlichbar,
// keine Inhalte). KI: mock (Standard des Images ohne Konfiguration).
//
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers KERN_IMAGE=kern:dev npx playwright test -c e2e/playwright.config.mjs
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = process.env.KERN_IMAGE ?? 'kern:latest';
const PORT = Number(process.env.STOPPUHR_PORT ?? 4312);
const SOLL_SEK = 120, SOLL_KLICKS = 15, GRENZE_SEK = 300;
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('Stoppuhr docker run: erste belegte Antwort', async ({ page }) => {
  test.setTimeout(GRENZE_SEK * 1000 + 30000);
  const name = `kern-stoppuhr-${process.pid}`;
  const ergebnis = { weg: 'docker_run', image: IMAGE, version: null, am: new Date().toISOString(), maschinenzeit_sek: null, klicks: 0,
    soll: { maschinenzeit_sek: SOLL_SEK, klicks: SOLL_KLICKS, grenze_sek: GRENZE_SEK }, schritte: [], bestanden: false, fehlgeschlagen_bei: null, luecken: [] };
  let klicks = 0;
  const klick = async (loc) => { await loc.click(); klicks++; };
  const t0 = Date.now();
  const marke = (schritt, info = {}) => ergebnis.schritte.push({ schritt, sek: Math.round((Date.now() - t0) / 100) / 10, klicks, ...info });
  let aktuell = 'container_starten';
  try {
    docker('run', '-d', '--name', name, '-p', `127.0.0.1:${PORT}:7480`, '--read-only', '--tmpfs', '/tmp:size=64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--memory-swap', '768m', '--cpus', '1', IMAGE);
    aktuell = 'healthz';
    let h = null;
    for (let i = 0; i < 240 && !h; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) h = await r.json(); } catch { /* startet noch */ }
      if (!h) await new Promise((ok) => setTimeout(ok, 250));
    }
    expect(h?.ok, 'healthz').toBe(true);
    ergebnis.version = h.version ?? null;
    marke('healthz');

    aktuell = 'erstzugang';
    const log = docker('logs', name);
    const m = /ERSTZUGANG[^\n]*Benutzer "([^"]+)", Passwort (\S+)/.exec(log);
    expect(m, 'Erstzugang im Log').not.toBeNull();
    const [, benutzer, einmal] = m;

    aktuell = 'anmelden';
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByLabel(/^Name/i).fill(benutzer);
    await page.getByLabel(/^Passwort/i).first().fill(einmal);
    await klick(page.getByRole('button', { name: /^Anmelden$/i }));
    const fehlerSeite = [];
    page.on('pageerror', (e) => fehlerSeite.push(e.message.slice(0, 200)));

    // Erster Zugang: eigenes Passwort setzen, falls die Instanz es verlangt (Managed: Einmalpasswort aus der Einladung)
    aktuell = 'erster_zugang';
    const neuesPw = page.getByRole('heading', { name: /neues Passwort|Passwort (ändern|festlegen|setzen)/i });
    const start = page.getByRole('heading', { name: /Bis zur ersten belegten Antwort/i });
    const navi = page.getByRole('navigation').first();
    await expect(neuesPw.or(start).or(navi)).toBeVisible({ timeout: 15000 }).catch(() => {
      throw new Error(`nach der Anmeldung keine Seite sichtbar${fehlerSeite.length ? `; Seitenfehler: ${fehlerSeite[0]}` : ''}`);
    });
    if (await neuesPw.isVisible()) {
      const pw = `Stoppuhr-${Date.now()}-x`;
      // Fragt die Seite das Einmal-Passwort noch einmal ab (Feld autocomplete=current-password), kommt es aus dem Log
      for (const f of await page.locator('input[type=password]').all()) {
        await f.fill((await f.getAttribute('autocomplete')) === 'current-password' ? einmal : pw);
      }
      await klick(page.getByRole('button', { name: /speichern|weiter|ändern|festlegen/i }).first());
      // erst weiter, wenn der Server das Passwort genommen hat (scrypt braucht bei --cpus 1 spürbar Zeit)
      await expect(neuesPw).toBeHidden({ timeout: 30000 });
      marke('eigenes_passwort');
    } else ergebnis.luecken.push('Kein Schritt „eigenes Passwort“ beim Weg docker run (Erstzugang aus dem Log gilt weiter).');
    marke('angemeldet');

    // Einrichtung (4.1) oder, falls die Instanz sie nicht anbietet, der Weg über Hinzufügen und Fragen
    aktuell = 'einrichtung';
    // Die App fragt GET /api/einrichtung und springt dann zu #/start; darauf bis zu 10 s warten
    await start.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (await start.isVisible().catch(() => false)) {
      marke('einrichtung_offen');
      const spaeter = page.getByRole('button', { name: /Diesen Schritt später machen/i });
      // Warten, bis der Assistent seinen ersten offenen Schritt zeigt (KI-Schritt für Admins, sonst Unterlagen)
      const kiFrage = page.getByText('Wer soll die Fragen beantworten?');
      const hinzu = page.getByRole('button', { name: /^Hinzufügen$/ });
      await expect(kiFrage.or(hinzu).first()).toBeVisible({ timeout: 15000 });
      if (await kiFrage.isVisible().catch(() => false)) {
        // KI bleibt mock (Image-Standard); den Schritt nicht als "ohne KI" umstellen
        await klick(spaeter.first());
        marke('ki_schritt_spaeter');
      }
      aktuell = 'unterlagen';
      await expect(hinzu).toBeVisible({ timeout: 15000 });
      await page.locator('input[type=file]').first().setInputFiles([path.join(hier, '..', 'fixtures', 'urlaub.docx'), path.join(hier, '..', 'fixtures', 'lieferzeiten.pdf')], { timeout: 15000 });
      klicks++; // Dateiauswahl zählt als ein Klick
      await klick(hinzu);
      await expect(page.getByLabel(/Deine erste Frage/i)).toBeVisible({ timeout: 60000 });
      marke('unterlagen_hochgeladen');
      aktuell = 'erste_frage';
      const feld = page.getByLabel(/Deine erste Frage/i);
      if (!(await feld.inputValue())) await feld.fill('Wann muss ich einen Urlaubsantrag einreichen?');
      await klick(page.getByRole('button', { name: /^Fragen$/ }));
      await expect(page.getByRole('heading', { name: 'Antwort mit Beleg' })).toBeVisible({ timeout: 60000 });
      await expect(page.locator('a.quelle-oeffnen').first()).toBeVisible();
    } else {
      ergebnis.luecken.push('Einrichtungsassistent (4.1) erscheint nicht; gemessen über Hinzufügen und Fragen.');
      aktuell = 'unterlagen_klassisch';
      await page.goto(`http://127.0.0.1:${PORT}/#/hinzufuegen`);
      await page.locator('input[type=file]').first().setInputFiles([path.join(hier, '..', 'fixtures', 'urlaub.docx')]);
      klicks++;
      const sammlung = page.getByLabel(/^Sammlung/);
      if ((await sammlung.count()) && !(await sammlung.inputValue())) {
        ergebnis.luecken.push('Frische Instanz: Feld „Sammlung“ leer (einstellungen.sammlungen fehlt), Nutzer muss eine Sammlung anlegen.');
        await sammlung.selectOption('__neu'); klicks++;
        await page.getByLabel(/Name der neuen Sammlung/).fill('Allgemein');
      }
      await klick(page.getByRole('button', { name: /Datei aufnehmen|^Hinzufügen$|hochladen/i }).first());
      // warten, bis die Quelle wirklich erfasst ist (sonst kommt die Frage vor dem Index)
      await expect.poll(async () => page.evaluate(async () => {
        const r = await fetch('/api/quellen', { headers: { 'x-kern': '1' } });
        return (await r.text()).toLowerCase().includes('urlaub');
      }), { timeout: 60000 }).toBe(true);
      marke('unterlagen_hochgeladen');
      aktuell = 'erste_frage_klassisch';
      await page.goto(`http://127.0.0.1:${PORT}/#/fragen`);
      await page.locator('textarea').first().fill('Wann muss ich einen Urlaubsantrag einreichen?');
      await klick(page.locator('button.frage-senden'));
      await expect(page.getByLabel('Antwort')).toBeVisible({ timeout: 60000 });
      await expect(page.locator('.beleg-marke, a.fussnote').first()).toBeVisible();
    }
    marke('belegte_antwort_sichtbar');

    // Zitat wörtlich in der Quelle (über dieselbe Sitzung)
    aktuell = 'zitat_pruefen';
    const geprueft = await page.evaluate(async () => {
      const r = await fetch('/api/frage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kern': '1' }, body: JSON.stringify({ frage: 'Wann muss ich einen Urlaubsantrag einreichen?' }) });
      const a = await r.json();
      if (a.status !== 'beantwortet' || !a.belege?.length) return { ok: false, status: a.status };
      const b = a.belege[0];
      const q = await (await fetch('/api/quellen/' + b.quelle.split('/').map(encodeURIComponent).join('/'), { headers: { 'x-kern': '1' } })).text();
      const n = (s) => String(s).replace(/\\n/g, ' ').replace(/\s+/g, ' ');
      return { ok: n(q).includes(n(b.zitat).slice(0, 40)), status: a.status, ki_erzeugt: a.ki_erzeugt ?? null };
    });
    expect(geprueft.ok, 'Zitat steht wörtlich in der Quelle').toBe(true);
    ergebnis.zitat_geprueft = true;
    ergebnis.ki_erzeugt = geprueft.ki_erzeugt;
  } catch (e) {
    ergebnis.fehlgeschlagen_bei = aktuell;
    ergebnis.fehler = String(e.message ?? e).split('\n')[0].slice(0, 300);
    await page.screenshot({ path: path.join(hier, 'letzter-fehler.png'), fullPage: true }).catch(() => {});
    throw e;
  } finally {
    ergebnis.maschinenzeit_sek = Math.round((Date.now() - t0) / 100) / 10;
    ergebnis.klicks = klicks;
    ergebnis.bestanden = !ergebnis.fehlgeschlagen_bei && ergebnis.maschinenzeit_sek <= SOLL_SEK && klicks <= SOLL_KLICKS;
    fs.writeFileSync(path.join(hier, 'ergebnis.json'), JSON.stringify(ergebnis, null, 2) + '\n');
    try { docker('rm', '-f', '-v', name); } catch { /* schon weg */ }
  }
  expect(ergebnis.maschinenzeit_sek, 'harte Grenze 5 Minuten').toBeLessThanOrEqual(GRENZE_SEK);
  expect(ergebnis.maschinenzeit_sek, 'Sollwert 4.5').toBeLessThanOrEqual(SOLL_SEK);
  expect(klicks, 'Klicks 4.5').toBeLessThanOrEqual(SOLL_KLICKS);
});
