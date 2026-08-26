import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 0.5);
}

test('homepage is a Hebrew RTL, cover-first entry to the archive', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'ארכיון גיליוטין' })).toHaveCount(1);

  const gameTiles = page.getByTestId('game-tile');
  await expect(gameTiles).toHaveCount(6);
  await expect(page.getByRole('link', { name: /פיפוש 1 — לדף המשחק/u })).toBeVisible();
  await expect(gameTiles.locator('[data-cover-kind="fallback"]')).toHaveCount(6);
  await expect(gameTiles.locator('img')).toHaveCount(0);
  const piposhOne = page.locator('[data-game="piposh-1"]');
  await expect(piposhOne).toContainText(
    'פיפוש עולה למטוס, התעלומה עולה איתו, ועכשיו גם הקבצים מצטרפים לחקירה.',
  );
  await expect(page.locator('[data-game="piposh-2"] .fact-badge')).toHaveText(
    '0 קבצים מקוטלגים',
  );
  await expect(page.getByText('הסנכרון הרשמי עוד בדרך')).toHaveCount(0);

  const searchbox = page.getByRole('searchbox', { name: 'חיפוש בארכיון' });
  await expect(searchbox).toBeVisible();
  await expect(searchbox).toHaveAttribute('placeholder', /בעברית/u);
  await expect(searchbox).toHaveAttribute('aria-describedby', 'home-search-hint');
  await expect(searchbox).toHaveAccessibleDescription(/החיפוש הרשמי מבין עברית/u);
  const searchForm = page.getByRole('search');
  await expect(searchForm).toHaveAttribute('action', '/search/');
  expect(await searchForm.evaluate((form: HTMLFormElement) => form.method)).toBe('get');
  await expect(page.getByText(/קיבינימאט/u)).toHaveCount(1);
  await expect(page.getByText('תיק ציבורי / לעיון חופשי')).toBeVisible();
  await expect(page.getByText('תיק ציבורי / מס׳ 1997')).toHaveCount(0);

  const skipLink = page.getByRole('link', { name: 'דלגו לתוכן' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveAttribute('href', '#main');
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('Google Drive');

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
  await expectWithinViewport(page, page.locator('.site-header'));
  await expectWithinViewport(page, page.locator('.hero'));
  await expectWithinViewport(page, page.locator('.search-controls'));
  for (const tile of await gameTiles.all()) await expectWithinViewport(page, tile);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
