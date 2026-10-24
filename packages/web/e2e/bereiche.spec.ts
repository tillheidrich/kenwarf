import { test, expect } from '@playwright/test';
import { BREITEN, anmelden, axe, geheZu, keinWaagerechtesScrollen } from './hilfen';

// Alle Bereiche in drei Breiten: sichtbar, axe ohne Befund, kein waagerechtes Scrollen, Bildschirmfoto.
const SEITEN: [string, string, string?][] = [
  ['heute', 'heute', '.zusammenfassung-karte'],
  ['fragen', 'fragen'],
  ['fragen-antwort', 'fragen?q=Ein Kunde ruft an, an seiner neuen Schranktür ist ein Kratzer', '.antwort'],
  ['fragen-steht-nicht-drin', 'fragen?q=Wie lange läuft die Lüftung im Lackraum nach?', '.antwort--steht_nicht_drin'],
  ['fragen-gehoert-nicht-hierher', 'fragen?q=Mit welchem Stundensatz rechnen wir?', '.antwort--gehoert_nicht_hierher'],
  ['fragen-fehler', 'fragen?q=testfehler bitte', '.hinweis--fehler'],
  ['wissen', 'wissen'],
  ['wissen-artikel', 'wissen/ablaeufe/18-reklamation.md'],
  ['wissen-regel', 'wissen/_regeln/was-nie-hineinkommt.md'],
  ['wissen-faellig', 'wissen?filter=faellig'],
  ['fundstelle', 'fundstelle?pfad=wissen%2Fablaeufe%2F18-reklamation.md&von=1&bis=1&zitat=Am+Telefon+nichts+zu+Ursache%2C+Schuld+oder+Kosten+sagen.', '.belegt'],
  ['fakten', 'fakten', '.fakten'],
  ['dokumente', 'dokumente', '.dokument-liste'],
  ['dokument', 'dokumente/2026/werkstattordner-eingescannt.md'],
  ['hinzufuegen', 'hinzufuegen'],
  ['hinzufuegen-import', 'hinzufuegen?art=import'],
  ['hinzufuegen-sprachnotiz', 'hinzufuegen?art=audio'],
  ['eingang', 'eingang/v51', '.diff'],
  ['eingang-konflikt', 'eingang/v55', '.diff'],
  ['briefing', 'briefing', '.briefing-text'],
  ['einstellungen-lesen', 'einstellungen/lesen', '.regel-liste'],
  ['einstellungen-betrieb', 'einstellungen/betrieb'],
  ['einstellungen-ki', 'einstellungen/ki'],
  ['einstellungen-datenweg', 'einstellungen/datenweg', '.datenweg-kette'],
  ['einstellungen-benutzer', 'einstellungen/benutzer', '.benutzer-liste'],
  ['einstellungen-apps', 'einstellungen/apps', '.token-liste'],
  ['einstellungen-anmeldung', 'einstellungen/anmeldung', '.geraete-liste'],
  ['einstellungen-kontext', 'einstellungen/kontext', '.bilanz'],
  ['einstellungen-wissen', 'einstellungen/wissen', '.eigentum'],
];

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test.use({ viewport: { width: breite, height: breite < 500 ? 844 : 900 } });

    test('Anmelden', async ({ page }) => {
      await page.goto('./');
      await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await keinWaagerechtesScrollen(page);
      await page.screenshot({ path: `bilder/${breite}-anmelden.png` });
      await page.getByLabel('Name', { exact: true }).fill('Jörn');
      await page.getByLabel('Passwort', { exact: true }).fill('falsch');
      await page.getByRole('button', { name: 'Anmelden' }).click();
      await expect(page.getByRole('alert')).toContainText('stimmt nicht');
    });

    test('alle Bereiche', async ({ page }) => {
      test.setTimeout(180_000);
      const fehler: string[] = [];
      page.on('pageerror', (e) => fehler.push(e.message));
      await anmelden(page);
      const befunde: Record<string, string[]> = {};
      for (const [name, route, warte] of SEITEN) {
        await geheZu(page, route);
        if (warte) await expect(page.locator(warte).first()).toBeVisible({ timeout: 8000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        const b = await axe(page);
        if (b.length) befunde[name] = b;
        await keinWaagerechtesScrollen(page, name);
        await page.screenshot({ path: `bilder/${breite}-${name}.png`, fullPage: breite >= 768 });
      }
      expect(befunde).toEqual({});
      expect(fehler).toEqual([]);
    });

    test('nach dem Kauf: erste Schritte und Testphase', async ({ page }) => {
      await page.goto('./?modus=neu');
      await page.getByLabel('Name', { exact: true }).fill('Jörn');
      await page.getByLabel('Passwort', { exact: true }).fill('demo');
      await page.getByRole('button', { name: 'Anmelden' }).click();
      await expect(page.getByRole('heading', { name: 'Bis zur ersten belegten Antwort' })).toBeVisible();
      await expect(page.locator('.testphase')).toContainText('Testphase bis');
      await page.waitForTimeout(250);
      expect(await axe(page)).toEqual([]);
      await keinWaagerechtesScrollen(page, 'start');
      await page.screenshot({ path: `bilder/${breite}-start.png`, fullPage: breite >= 768 });
    });
  });
}
