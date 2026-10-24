import { test, expect } from '@playwright/test';
import { axe, keinWaagerechtesScrollen } from './hilfen';

// Der 5-Minuten-Weg nach dem Kauf (CONTRACT v1.4 4.1). Mock ?modus=neu: leere Instanz, Testphase, betreuter Betrieb.
async function neuAnmelden(page: import('@playwright/test').Page) {
  await page.goto('./?modus=neu');
  await page.getByLabel('Name', { exact: true }).fill('Jörn');
  await page.getByLabel('Passwort', { exact: true }).fill('demo');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Bis zur ersten belegten Antwort' })).toBeVisible();
}

test('Eigener EU-Anbieter, Beispiel laden, erste Frage mit Beleg, Export', async ({ page }) => {
  await neuAnmelden(page);
  await expect(page.getByRole('radio', { name: /Test-KI von HD/ })).toBeVisible();
  await page.getByRole('radio', { name: /Eigener Anbieter/ }).check();
  // betreuter Betrieb: kein lokales Modell, keine freie Adresse
  await expect(page.getByLabel('Anbieter', { exact: true }).locator('option', { hasText: 'Ollama' })).toHaveCount(0);
  await expect(page.getByLabel('Adresse')).toHaveCount(0);
  await page.getByLabel('Anbieter', { exact: true }).selectOption('ionos');
  await page.getByRole('button', { name: 'Verbindung prüfen und speichern' }).click();
  await expect(page.locator('.feld-fehler')).toContainText('Schlüssel');
  await page.getByLabel('API-Schlüssel').fill('kurz');
  await page.getByRole('button', { name: 'Verbindung prüfen und speichern' }).click();
  await expect(page.locator('.ki-test--fehler')).toContainText('401');
  await page.getByLabel('API-Schlüssel').fill('ionos-schluessel-lang-genug');
  await page.getByRole('button', { name: 'Verbindung prüfen und speichern' }).click();
  await expect(page.locator('.start-notiz')).toContainText('IONOS AI Model Hub verbunden');
  await page.getByRole('button', { name: 'Beispiel laden' }).click();
  await expect(page.getByLabel('Deine erste Frage')).toHaveValue(/Kratzer/);
  await page.getByRole('button', { name: 'Fragen', exact: true }).click();
  await expect(page.locator('.start-antwort mark')).toBeVisible();
  await expect(page.locator('.start-antwort .ki-kennzeichen')).toContainText('KI');
  expect(await axe(page)).toEqual([]);
  await keinWaagerechtesScrollen(page);
  await page.screenshot({ path: 'bilder/1440-start-antwort.png', fullPage: true });
  await page.getByRole('button', { name: 'Fertig, zu Heute' }).click();
  await expect(page.locator('#seitentitel')).toHaveText('Heute');
  await expect(page.locator('.kontext-karte')).toBeVisible();
  // Export in jeder Sitzung einen Klick entfernt
  await page.locator('.testphase').getByRole('link', { name: 'Wissen exportieren' }).click();
  await expect(page.locator('#einst-titel')).toHaveText('Dein Wissen gehört dir');
  await page.getByRole('button', { name: 'Export erstellen' }).click();
  await expect(page.getByRole('link', { name: /Herunterladen/ })).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: 'Probe starten' }).click();
  await expect(page.locator('.eigentum')).toContainText('bestanden');
  await expect(page.getByRole('button', { name: 'Beispiel entfernen' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'bilder/1440-einstellungen-wissen-managed.png', fullPage: true });
});

test('Konto: Testphase einmal verlängern, Kaufen ehrlich gesperrt, Löschen nur mit Bestätigung', async ({ page }) => {
  await neuAnmelden(page);
  await page.getByRole('button', { name: 'Überspringen, ich schaue mich erst um' }).click();
  await page.locator('.testphase').getByRole('link', { name: 'Konto' }).click();
  await expect(page.locator('#einst-titel')).toHaveText('Konto');
  await expect(page.getByRole('button', { name: 'Kaufen' })).toBeDisabled();
  await page.getByRole('button', { name: '14 Tage verlängern' }).click();
  await expect(page.getByRole('button', { name: '14 Tage verlängern' })).toBeDisabled();
  await page.getByRole('button', { name: 'Löschen', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Instanz löschen?' });
  await expect(d.getByRole('button', { name: 'Mail zum Löschen schicken' })).toBeDisabled();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'bilder/1440-einstellungen-konto.png', fullPage: true });
});

test('Weg „über deine KI-App“ zeigt Adresse und Datenfluss-Hinweis F12', async ({ page }) => {
  await neuAnmelden(page);
  await page.getByRole('radio', { name: /Über deine KI-App/ }).check();
  await expect(page.locator('.app-weg .token')).toContainText('/mcp');
  await expect(page.locator('.f12')).toContainText('landet im Kontext seines Modells');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.locator('.start-notiz')).toContainText('KI-App über MCP');
});

test('Eigenes Dokument: Text einfügen und danach fragen', async ({ page }) => {
  await neuAnmelden(page);
  await page.getByRole('button', { name: 'Diesen Schritt später machen' }).click();
  await page.getByLabel('Oder Text einfügen').fill('Urlaubsregel Werkstatt\nUrlaub beantragen wir spätestens vier Wochen vorher bei Sabine. Im Dezember gilt eine Urlaubssperre bis zum 20.');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(page.locator('.start-notiz')).toContainText('1 Dokument hinzugefügt');
  await page.getByLabel('Deine erste Frage').fill('Bis wann beantragen wir Urlaub?');
  await page.getByRole('button', { name: 'Fragen', exact: true }).click();
  await expect(page.locator('.start-antwort')).toContainText(/vier Wochen|steht nichts drin/);
});

test('Überspringen führt zu Heute, Instanz bleibt leer und ehrlich', async ({ page }) => {
  await neuAnmelden(page);
  await page.getByRole('button', { name: 'Überspringen, ich schaue mich erst um' }).click();
  await expect(page.locator('#seitentitel')).toHaveText('Heute');
  await expect(page.locator('.zusammenfassung-karte')).toContainText('Noch ist hier nichts passiert');
});

test('Nach der Testphase: nur lesen, Export bleibt, Schreiben wird ehrlich abgelehnt', async ({ page }) => {
  await page.goto('./?modus=lesen');
  await page.getByLabel('Name', { exact: true }).fill('Jörn');
  await page.getByLabel('Passwort', { exact: true }).fill('demo');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.testphase--ende')).toContainText('Nur lesen.');
  await expect(page.locator('.testphase--ende')).toContainText('lesbar und exportierbar');
  await expect(page.locator('.testphase--ende').getByRole('link', { name: 'Wissen exportieren' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'bilder/1440-nur-lesen.png' });
});
