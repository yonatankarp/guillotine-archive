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

test('Piposh 1 is an official-material hub with direct Drive actions', async ({ page }) => {
  await page.goto('/games/piposh-1/');

  await expect(page.getByRole('heading', { level: 1, name: 'פיפוש 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'גרסאות בעברית' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'מהדורות רשמיות בשפות זרות' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'פתרונות' })).toBeVisible();
  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('פיפוש 1 - פתרון.docx', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'הורדה — piposh1.exe' }),
  ).toHaveAttribute('href', /drive\.google\.com/u);
  await expect(page.getByText('ביקורת.jpg', { exact: true })).toHaveCount(0);
  await expect(page.getByText('fan.zip', { exact: true })).toHaveCount(0);
  await expect(page.locator('main [download]')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('complete archive browsing remains available without search', async ({ page }) => {
  await page.goto('/archive/');

  await expect(page.getByRole('heading', { level: 1, name: 'כל הארכיון' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'פתרונות, קובץ אחד' })).toBeVisible();
  await page.getByRole('link', { name: /משחקים מלאים/u }).click();
  await expect(page).toHaveURL(/\/archive\/games\/$/u);
  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'חלק מהמהדורה הרשמית: פיפוש 1' }).first(),
  ).toHaveAttribute('href', '/games/piposh-1/');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto('/archive/solutions/');
  await expect(page.getByText('קובץ אחד בקטגוריה הזאת.')).toBeVisible();
});

test('games without fixture items show an honest empty state', async ({ page }) => {
  await page.goto('/games/piposh-2/');

  await expect(page.getByRole('heading', { level: 1, name: 'פיפוש 2' })).toBeVisible();
  await expect(page.getByText(/עדיין אין בתיק הזה קבצים מקוטלגים/u)).toBeVisible();
  await expect(page.locator('.file-list')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('Drive actions and back links have a high-contrast visible focus indicator', async ({ page }) => {
  for (const [path, accessibleName] of [
    ['/games/piposh-1/', 'צפייה ב־Drive — piposh1.exe'],
    ['/archive/games/', 'חזרה לכל הארכיון'],
  ] as const) {
    await page.goto(path);
    const link = page.getByRole('link', { name: accessibleName }).first();
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS('outline-color', 'rgb(23, 21, 18)');
    await expect(link).toHaveCSS('outline-style', 'solid');
    await expect(link).toHaveCSS('outline-width', '4px');
  }
});

test('new archive pages remain within a 320px viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '320px', 'narrow viewport check');

  for (const path of ['/games/', '/games/piposh-1/', '/archive/', '/archive/games/', '/about/']) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
      `horizontal overflow at ${path}`,
    ).toBe(false);
    await expectWithinViewport(page, page.locator('main'));
  }
});
