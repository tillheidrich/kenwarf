import { test, expect } from '@playwright/test';
import { anmelden, axe, geheZu } from './hilfen';

test.use({ viewport: { width: 1440, height: 900 } });

test('Frage mit Belegen: Beleg-Marke führt zur Quelle, Fundstelle öffnet die Stelle', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'fragen');
  await page.getByLabel('Deine Frage').fill('Wie viel Anzahlung nehmen wir bei einer Treppe für 2.400 €?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.antwort-punkte li').first()).toContainText('30 %');
  await page.getByRole('button', { name: /^Beleg 2/ }).click();
  await expect(page.locator('#beleg-2')).toBeFocused();
  await page.locator('#beleg-1').getByRole('link', { name: 'Fundstelle öffnen' }).click();
  await expect(page.locator('.quelltext li.belegt').first()).toBeVisible();
  await expect(page.getByText('wörtlich gefunden')).toBeVisible();
});

test('Eingang: Ablehnen braucht eine Begründung, Freigeben schreibt den Artikel', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'eingang/v51');
  await page.getByRole('button', { name: 'Ablehnen' }).click();
  await page.getByRole('button', { name: 'Ablehnung speichern' }).click();
  await expect(page.getByText('Bitte begründe die Ablehnung')).toBeVisible();
  await expect(page.getByLabel(/Warum lehnst du ab/)).toBeFocused();
  expect(await axe(page)).toEqual([]);
  await page.getByLabel(/Warum lehnst du ab/).fill('Erst im Frühjahr wieder prüfen.');
  await page.getByRole('button', { name: 'Ablehnung speichern' }).click();
  await expect(page.locator('.entscheidung')).toContainText('Abgelehnt');

  await geheZu(page, 'eingang/v53');
  await page.getByRole('button', { name: 'Freigeben', exact: true }).click();
  await expect(page.locator('.meldung').filter({ hasText: 'Freigegeben' })).toBeVisible();
  await geheZu(page, 'wissen/einarbeitung/41-werkstatt-sicherheit.md');
  await expect(page.locator('.prosa')).toContainText('zehn Minuten nach');
});

test('Eingang: Konflikt zeigt neuen Vergleich mit dem heutigen Stand', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'eingang/v55');
  await expect(page.getByText('Die Datei wurde inzwischen geändert.')).toBeVisible();
  await expect(page.locator('.diff')).toContainText('Werkzeug nach der Montage zählen');
});

test('Befehlspalette und Tastenkürzel', async ({ page }) => {
  await anmelden(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Suchbegriff oder Frage' })).toBeFocused();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.type('Reklam');
  await expect(page.getByRole('option', { name: /^Reklamation/ }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#seitentitel')).toHaveText('Reklamation');
  await page.locator('#seitentitel').click();
  await page.keyboard.press('g');
  await page.keyboard.press('e');
  await expect(page).toHaveURL(/#\/eingang/);
  await page.keyboard.press('/');
  await expect(page.locator('#frage-eingabe')).toBeFocused();
});

test('Änderung vorschlagen landet im Eingang', async ({ page }) => {
  await anmelden(page, 'Kai');
  await geheZu(page, 'wissen/ablaeufe/18-reklamation.md');
  await page.getByRole('button', { name: 'Änderung vorschlagen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Änderung vorschlagen' });
  await expect(dlg).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await dlg.getByRole('button', { name: 'In den Eingang legen' }).click();
  await expect(dlg.getByText('noch nichts geändert')).toBeVisible();
  await dlg.locator('textarea').first().fill('Neuer Text für die Reklamation.');
  await dlg.getByLabel(/Warum/).fill('Ablauf vereinfacht');
  await dlg.getByRole('button', { name: 'In den Eingang legen' }).click();
  await expect(page.locator('.meldung')).toContainText('im Eingang');
});

test('Hinzufügen: Text speichern erzeugt Quelle und Vorschlag', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'hinzufuegen?art=text');
  await page.getByRole('button', { name: 'Text speichern' }).click();
  await expect(page.getByText('Da steht noch nichts.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Titel' }).fill('Transporter packen');
  await page.getByRole('textbox', { name: 'Inhalt (Pflicht)' }).fill('Schweres nach unten.\n\nGlas stehend im Glasbock.');
  await page.getByRole('button', { name: 'Text speichern' }).click();
  await expect(page.getByRole('heading', { name: /Gespeichert: Transporter packen/ })).toBeVisible();
  await expect(page.getByText('Ein Vorschlag liegt jetzt im Eingang.')).toBeVisible();
});

test('Leserin sieht keine Bearbeitung und keine Freigabe', async ({ page }) => {
  await anmelden(page, 'Lena');
  await geheZu(page, 'hinzufuegen');
  await expect(page.getByText('Dafür fehlt dir die Rolle')).toBeVisible();
  await geheZu(page, 'eingang/v51');
  await expect(page.getByText('Freigeben dürfen Freigeber und Admins.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Freigeben', exact: true })).toHaveCount(0);
  await geheZu(page, 'einstellungen/benutzer');
  await expect(page.locator('#einst-titel')).not.toHaveText('Benutzer und Rollen');
});

test('Prüflauf legt Vorschläge in den Eingang', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'wissen');
  await page.getByRole('button', { name: 'Prüflauf starten' }).click();
  await expect(page.getByRole('heading', { name: 'Ergebnis des Prüflaufs' })).toBeVisible();
  await expect(page.locator('.befunde')).toContainText('Lieferzeit Beschläge');
});

test('Zugang: Schlüssel nur für sich, mit Rechten und Ablauf, einzeln widerrufbar', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'einstellungen/apps');
  await expect(page.locator('.f12').first()).toContainText('geht an den Anbieter dieses Programms');
  const schl = page.locator('section[aria-labelledby="schl-titel"]');
  await expect(schl.locator('.token-zeile')).toHaveCount(1);
  await page.getByRole('button', { name: 'Neuer Schlüssel' }).click();
  const d = page.getByRole('dialog', { name: 'Neuer Schlüssel' });
  await expect(d.locator('.f12')).toBeVisible();
  await d.getByRole('button', { name: 'Schlüssel erstellen' }).click();
  await expect(d.getByRole('alert').or(d.locator('.hinweis--fehler'))).toContainText('Namen');
  await d.getByLabel('Wofür ist der Schlüssel?').fill('Nachtlauf-Agent');
  await d.getByRole('checkbox', { name: /^Vorschlagen/ }).check();
  await d.getByLabel('Gültig für').selectOption('30');
  await d.getByRole('button', { name: 'Schlüssel erstellen' }).click();
  const fertig = page.getByRole('dialog', { name: 'Dein neuer Schlüssel' });
  await expect(fertig.locator('.token')).toContainText('kern_');
  expect(await axe(page)).toEqual([]);
  await fertig.getByRole('button', { name: 'Fertig' }).click();
  const zeile = schl.locator('.token-zeile').filter({ hasText: 'Nachtlauf-Agent' });
  await expect(zeile).toContainText('Vorschlagen');
  await expect(zeile.locator('.token')).toHaveCount(0);
  await zeile.getByRole('button', { name: /widerrufen/ }).click();
  await page.getByRole('button', { name: 'Ja, widerrufen' }).click();
  await expect(schl.locator('.token-zeile')).toHaveCount(1);
  // OAuth-App trennen
  await page.getByRole('button', { name: 'Claude trennen' }).click();
  await page.getByRole('button', { name: 'Ja, trennen' }).click();
  await expect(page.getByText('Noch keine App verbunden.')).toBeVisible();
});

test('KI-Anbieter wechseln setzt „noch nicht geprüft“, Prüfbank misst', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'einstellungen/ki');
  await expect(page.locator('.ki-status')).toContainText('ohne KI');
  await page.getByRole('radio', { name: /OpenAI-kompatibel/ }).check();
  await page.getByLabel('Adresse des Servers').fill('https://api.mistral.ai/v1');
  await page.getByLabel('Modell für Antworten').fill('mistral-medium-latest');
  await page.getByLabel('API-Schlüssel').fill('ein-langer-test-schluessel');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.ki-status')).toContainText('noch nicht geprüft');
  await page.getByRole('button', { name: 'Prüfbank laufen lassen' }).click();
  await expect(page.locator('.ki-status')).toContainText('geprüft');
  await expect(page.getByText('Rechte-Lecks', { exact: true })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  // Antworten tragen jetzt die KI-Kennzeichnung mit Modell (Art. 50 KI-VO)
  await geheZu(page, 'fragen?q=Ein Kunde ruft an, an seiner neuen Schranktür ist ein Kratzer');
  await expect(page.locator('.ki-kennzeichen')).toContainText('Diese Antwort hat eine KI aus euren Dokumenten erzeugt (Modell: mistral-medium-latest');
  await geheZu(page, 'einstellungen/kontext');
  await expect(page.locator('.bilanz')).toContainText('Weiß Bescheid');
  expect(await axe(page)).toEqual([]);
});

test('Konto: Passwort ändern, Gerät abmelden, überall abmelden', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'einstellungen/anmeldung');
  await page.getByLabel('Bisheriges Passwort').fill('falsch');
  await page.getByLabel('Neues Passwort', { exact: true }).fill('ein langer neuer satz');
  await page.getByLabel('Neues Passwort wiederholen').fill('ein langer neuer satz');
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(page.locator('.hinweis--fehler')).toContainText('stimmt nicht');
  await page.getByLabel('Bisheriges Passwort').fill('demo');
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(page.locator('.meldung').filter({ hasText: 'Passwort geändert' })).toBeVisible();
  await expect(page.locator('.geraet-zeile')).toHaveCount(1);
  expect(await axe(page)).toEqual([]);
  await page.getByRole('button', { name: 'Überall abmelden' }).click();
  await page.getByRole('button', { name: 'Ja, überall abmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
});

test('Admin setzt Passwort zurück, Person muss ein eigenes festlegen', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'einstellungen/benutzer');
  await page.getByRole('button', { name: 'Passwort von Kai Brandes zurücksetzen' }).click();
  await page.getByRole('button', { name: 'Ja, zurücksetzen' }).click();
  const einmal = (await page.getByRole('dialog', { name: 'Einmal-Passwort' }).locator('.token').textContent())!.trim();
  await page.getByRole('button', { name: 'Fertig' }).click();
  await page.locator('.ich').getByRole('button', { name: 'Abmelden' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Kai');
  await page.getByLabel('Passwort', { exact: true }).fill(einmal);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Eigenes Passwort festlegen' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByLabel('Einmal-Passwort vom Admin').fill(einmal);
  await page.getByLabel('Neues Passwort', { exact: true }).fill('kais eigener langer satz');
  await page.getByLabel('Neues Passwort wiederholen').fill('kais eigener langer satz');
  await page.getByRole('button', { name: 'Passwort speichern' }).click();
  await expect(page.locator('#seitentitel')).toHaveText('Heute');
});

test('Nicht-Admins sehen keinen KI-Endpunkt', async ({ page }) => {
  await anmelden(page, 'Sabine');
  await geheZu(page, 'einstellungen');
  await expect(page.locator('.einst-link').filter({ hasText: 'KI-Anbieter' })).toHaveCount(0);
  await geheZu(page, 'einstellungen/datenweg');
  await expect(page.locator('.datenweg')).not.toContainText('http');
});

test('Heute: Zusammenfassung ist Standard, Entscheidungsvorlage und Fokus sind Angebote', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'heute');
  await expect(page.locator('.zusammenfassung-karte')).toContainText('Im Eingang warten');
  await expect(page.getByRole('radio', { name: 'Zusammenfassung' })).toBeChecked();
  await expect(page.locator('.budget')).toHaveCount(0);
  await expect(page.locator('.ansicht-hinweis')).toContainText('aus Rohdaten');
  await expect(page.locator('.ansicht-hinweis')).toContainText('läuft ab am');
  // sanfter Hinweis nur für die Person selbst, schließbar
  await expect(page.locator('.sanfter-hinweis')).toContainText('Nur du siehst diesen Hinweis');
  await page.getByRole('button', { name: 'Hinweis schließen' }).click();
  await expect(page.locator('.sanfter-hinweis')).toHaveCount(0);
  await page.getByRole('button', { name: 'Nur Abweichungen' }).click();
  await expect(page.locator('.zusammenfassung-karte')).toContainText('Seit deiner letzten Ansicht neu');
  await page.getByRole('button', { name: 'Als Entscheidungsvorlage' }).click();
  await expect(page.getByRole('heading', { name: /Zu entscheiden/ })).toBeVisible();
  // Stufen: Satz, Absatz, Beleg, Original
  const p1 = page.locator('.punkt').filter({ hasText: 'Nr. 53' });
  await expect(p1.locator('.lese-ampel')).toContainText('Ja, heute lesen');
  await p1.getByRole('button', { name: 'Mehr dazu' }).click();
  await expect(p1.locator('.punkt-absatz')).toBeVisible();
  await p1.getByRole('button', { name: 'Beleg' }).click();
  await expect(p1.locator('mark')).toContainText('Lüftung an');
  expect(await axe(page)).toEqual([]);
  await p1.getByRole('link', { name: /Original öffnen/ }).click();
  await expect(page.locator('.quelltext li.belegt').first()).toBeVisible();
});

test('Heute im Fokus mit harter Grenze legt Punkte auf morgen', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'einstellungen/lesen');
  await page.getByRole('radio', { name: /^Fokus/ }).check();
  await page.getByRole('checkbox', { name: /^Lesebudget/ }).check();
  await page.getByRole('spinbutton', { name: 'Minuten pro Tag' }).fill('1');
  await page.getByRole('checkbox', { name: /Harte Grenze/ }).check();
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.meldung').filter({ hasText: 'Gespeichert' })).toBeVisible();
  await geheZu(page, 'heute');
  await expect(page.getByRole('radio', { name: 'Fokus' })).toBeChecked();
  await expect(page.locator('.budget')).toContainText('Harte Grenze');
  await expect(page.locator('.zurueck')).toContainText('Für morgen zurückgelegt');
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'bilder/1440-heute-fokus.png', fullPage: true });
});

test('Erst du, dann ich: Abgleich mit der eigenen Einschätzung', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'fragen');
  await page.getByRole('checkbox', { name: /Erst du, dann ich/ }).check();
  await page.getByLabel('Deine Frage').fill('Wie viel Anzahlung nehmen wir bei einer Treppe für 2.400 €?');
  await page.getByRole('button', { name: 'Fragen', exact: true }).click();
  await expect(page.getByText('Schreib zuerst deine eigene Einschätzung')).toBeVisible();
  await page.getByLabel(/Deine Einschätzung/).fill('Ich glaube, bei 2.400 € nehmen wir keine Anzahlung, erst ab 3.000 €.');
  await page.getByRole('button', { name: 'Fragen', exact: true }).click();
  await expect(page.locator('.abgleich-rahmen')).toBeVisible();
  await expect(page.locator('.abgleich-gleich')).toContainText('Stimmt mit dir überein');
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: 'bilder/1440-fragen-erst-du.png', fullPage: true });
  await page.getByRole('button', { name: 'Das ist falsch' }).click();
  await page.getByRole('dialog', { name: 'Das ist falsch' }).getByRole('button', { name: 'Melden' }).click();
  await expect(page.locator('.meldung').filter({ hasText: 'Fehlerbuch' })).toBeVisible();
});

test('Eingang zeigt höchstens drei offene Vorschläge, Rest als Zahl', async ({ page }) => {
  await anmelden(page);
  await geheZu(page, 'eingang');
  await expect(page.locator('.vorschlag-zeile')).toHaveCount(3);
  await expect(page.locator('.wip-hinweis')).toContainText('weitere');
  await page.getByRole('button', { name: 'Alle zeigen' }).click();
  await expect(page.locator('.vorschlag-zeile')).toHaveCount(4);
});
