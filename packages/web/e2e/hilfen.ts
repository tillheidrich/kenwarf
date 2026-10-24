import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export const BREITEN = [390, 768, 1440] as const;

export async function anmelden(page: Page, name = 'Jörn') {
  await page.goto('./');
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Passwort', { exact: true }).fill('demo');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('#seitentitel')).toBeVisible();
}

export async function geheZu(page: Page, route: string) {
  await page.goto('./#/' + route);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#seitentitel').first()).toBeVisible();
  await page.waitForTimeout(250);
}

/** axe nach WCAG 2.2 AA; gibt die Befunde lesbar zurück. */
export async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`);
}

export async function keinWaagerechtesScrollen(page: Page, wo = '') {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `waagerechtes Scrollen ${wo}`).toBeLessThanOrEqual(iw);
}
