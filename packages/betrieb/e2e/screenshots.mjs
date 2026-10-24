// Screenshots der Konsole bei 390 und 1440 px, plus Prüfung: kein waagerechtes Scrollen, axe WCAG 2.2 AA ohne schwere Befunde.
// Aufruf: BETRIEB_URL=http://127.0.0.1:4307 TOTP_DATEI=… AUSGABE=… node e2e/screenshots.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp, totpZaehler } from '../dist/auth.js';

const url = process.env.BETRIEB_URL ?? 'http://localhost:4307';
const aus = process.env.AUSGABE ?? 'e2e/bilder';
const secret = fs.readFileSync(process.env.TOTP_DATEI, 'utf8').trim();
fs.mkdirSync(aus, { recursive: true });

const browser = await chromium.launch();
const ergebnis = [];
let letzterZaehler = -1;
for (const breite of [390, 1440]) {
  const ctx = await browser.newContext({ viewport: { width: breite, height: breite === 390 ? 844 : 960 }, deviceScaleFactor: breite === 390 ? 2 : 1 });
  const page = await ctx.newPage();
  await page.goto(`${url}/anmelden`);
  if (breite === 390) await page.screenshot({ path: path.join(aus, `anmelden-${breite}.png`) });
  // jeder TOTP-Code gilt nur einmal: auf den nächsten Zeitschritt warten
  while (totpZaehler(Date.now()) === letzterZaehler) await new Promise((r) => setTimeout(r, 500));
  letzterZaehler = totpZaehler(Date.now());
  if (!(await page.locator('#name').isVisible())) await page.click('details.rueckfall summary');
  await page.fill('#name', 'till');
  await page.fill('#passwort', 'vorfuehrung-nur-lokal');
  await page.fill('#code', totp(secret, letzterZaehler));
  await Promise.all([page.waitForURL('**/heute'), page.click('button[type=submit]')]);

  const zimmerei = await page.evaluate(async () => {
    const html = await (await fetch('/instanzen')).text();
    return /href="(\/instanzen\/i_[a-z0-9]+)"[^>]*>Zimmerei/.exec(html)?.[1];
  });
  const seiten = [['heute', '/heute'], ['instanzen', '/instanzen'], ['instanz-eigene-maschine', zimmerei], ['neue-instanz', '/instanzen/neu'], ['pitch', '/instanzen/neu?art=pitch'], ['hosts', '/hosts'], ['partner', '/partner'], ['konten', '/kunden'], ['protokoll', '/protokoll'], ['schalter', '/schalter']];
  for (const [name, p] of seiten) {
    await page.goto(url + p);
    await page.waitForLoadState('networkidle');
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    const schwer = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    ergebnis.push({ breite, name, waagerecht: scroll, axe: schwer.map((v) => `${v.id} (${v.nodes.length})`) });
    await page.screenshot({ path: path.join(aus, `${name}-${breite}.png`), fullPage: true });
  }
  if (breite === 1440) {
    // Passkey-Ablauf mit virtuellem Authenticator (CDP): hinzufügen, abmelden, mit Passkey wieder anmelden
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    await page.goto(`${url}/sicherheit`);
    await page.fill('#passkey-name', 'Vorführgerät');
    await Promise.all([page.waitForURL('**/sicherheit?meldung=*'), page.click('#passkey-neu')]);
    await page.screenshot({ path: path.join(aus, `sicherheit-${breite}.png`), fullPage: true });
    await page.click('form.abmelden button');
    await page.waitForURL('**/anmelden');
    await page.screenshot({ path: path.join(aus, `anmelden-passkey-${breite}.png`) });
    await Promise.all([page.waitForURL('**/heute'), page.click('#passkey-anmelden')]);
    ergebnis.push({ breite, name: 'passkey-anmeldung', waagerecht: 0, axe: [], ok: page.url().endsWith('/heute') });
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify(ergebnis, null, 1));
const fehler = ergebnis.filter((e) => e.waagerecht > 0 || e.axe.length);
if (fehler.length) { console.error('Befunde:', JSON.stringify(fehler)); process.exitCode = 1; }
