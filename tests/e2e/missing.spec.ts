import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loadMissingList } from '../../src/lib/catalog';
import { hasHorizontalOverflow } from '../support/horizontal-overflow';
import { playwrightRuntime } from '../support/playwright-runtime';

/*
 * The rows are only ever written by a credentialed Drive sync, so the committed artifact
 * is empty until one runs and full afterwards. Both are correct states of this page and
 * both have to render, so the expectation is read from the artifact rather than guessed:
 * this spec is the same test before and after the sync that fills it in.
 */
const expectedList = loadMissingList('src/generated/missing-list.json');
const { site } = playwrightRuntime;

test('the missing list is a page to read, not a trip to a spreadsheet', async ({ page }) => {
  await page.goto(site.route('missing/'));

  await expect(page.getByRole('heading', { level: 1, name: 'מה עוד חסר לנו' })).toBeVisible();

  const table = page.getByRole('table');
  if (expectedList.rows.length === 0) {
    // Degrading honestly means saying the list is not here, never that nothing is missing.
    await expect(table).toHaveCount(0);
    await expect(page.locator('.empty-archive')).toContainText('הרשימה עצמה לא פה כרגע');
  } else {
    await expect(table).toBeVisible();
    // The header row is the accessible structure of a data table; without it the rows are
    // a grid of unlabelled strings to a screen reader.
    await expect(table.locator('thead th')).toHaveCount(expectedList.headerHe.length);
    for (const header of await table.locator('thead th').all()) {
      await expect(header).toHaveAttribute('scope', 'col');
    }
    await expect(table.locator('tbody tr')).toHaveCount(expectedList.rows.length);
    await expect(table.locator('caption')).toBeVisible();

    const firstCell = expectedList.rows[0]?.find((cell) => cell !== '');
    if (firstCell !== undefined) await expect(table).toContainText(firstCell);

    // A table of unknown width scrolls inside its own box, and a box only a mouse can
    // scroll is unreachable by keyboard.
    const scroller = page.locator('.missing-scroll');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    await expect(scroller).toHaveJSProperty('scrollLeft', 0);
  }

  /* The sheet is in the committed catalog, so the source stays one click away whether or
     not its rows have been exported yet. Asserted unconditionally: a link that vanishes
     is exactly the regression worth catching, and a guarded assertion would pass through it. */
  const source = page.getByRole('link', { name: 'הגיליון המקורי פתוח לכולם' });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('target', '_blank');
  await expect(source).toHaveAttribute('rel', 'noopener noreferrer');

  expect(await hasHorizontalOverflow(page)).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('every page offers the missing list in the footer', async ({ page }) => {
  await page.goto(site.route());

  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'מה חסר לנו' }),
  ).toHaveAttribute('href', site.route('missing/'));
});

test('the about page sends a reader to the missing list', async ({ page }) => {
  await page.goto(site.route('about/'));

  await page.getByRole('link', { name: 'מה שעוד חסר לנו' }).click();
  await expect(page).toHaveURL(new RegExp(`${site.route('missing/')}$`, 'u'));
  await expect(page.getByRole('heading', { level: 1, name: 'מה עוד חסר לנו' })).toBeVisible();
});
