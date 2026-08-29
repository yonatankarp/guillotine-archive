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

/** One status in the sheet is written across two lines; the DOM and Playwright collapse it. */
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

test('the missing list is a page to read, not a trip to a spreadsheet', async ({ page }) => {
  await page.goto(site.route('missing/'));

  await expect(page.getByRole('heading', { level: 1, name: 'מה עוד חסר לנו' })).toBeVisible();

  const tables = page.locator('main').getByRole('table');
  if (expectedList.rows.length === 0) {
    // Degrading honestly means saying the list is not here, never that nothing is missing.
    await expect(tables).toHaveCount(0);
    await expect(page.locator('.empty-archive')).toContainText('הרשימה עצמה לא פה כרגע');
  } else {
    await expect(tables.first()).toBeVisible();
    const tableCount = await tables.count();

    /* The export is a spreadsheet: four pairs of columns with three empty gutters between
       them, and several lists stacked inside each pair. Rendered verbatim it was an
       eleven-column grid whose empty gutters became cells headed "עמודה 3" and whose last
       column was cut off at 1440px. It is lists now — but re-laying it out is only allowed
       to move values around, never to lose one, so every value the artifact carries has to
       still be somewhere on the page. Distinct values, not a count of cells: the same
       status word is repeated dozens of times and a substring check cannot tell those
       apart. Structure is asserted separately, below. */
    /* textContent, not innerText: innerText is what layout produced, and this assertion is
       the whole proof that re-laying the sheet out lost nothing. It must read the same at
       320px as at 1440px. */
    const pageText = normalize((await page.locator('main').textContent()) ?? '');
    const values = new Set(
      [...expectedList.headerHe, ...expectedList.rows.flat()]
        .map(normalize)
        .filter((cell) => cell !== ''),
    );
    expect(values.size, 'the artifact still carries values to render').toBeGreaterThan(0);
    for (const value of values) {
      expect(pageText, `the page still carries ${value}`).toContain(value);
    }

    // The gutters are gone, so nothing is announced as a numbered column any more.
    expect(pageText).not.toContain('עמודה');

    /* Two cells to a row at most — a name and its status. That is the whole difference
       between this page and the spreadsheet, and it is what makes it fit a phone. */
    const widest = await page
      .locator('main tr')
      .evaluateAll((rows) => Math.max(...rows.map((row) => row.children.length)));
    expect(widest, 'no row is wider than a name and a status').toBeLessThanOrEqual(2);

    /* Each list names itself, heads its status column, and uses the item name as the row
       header — without those the rows are a grid of unlabelled strings to a screen reader. */
    await expect(page.locator('main table > caption')).toHaveCount(tableCount);
    await expect(page.locator('main thead th')).toHaveCount(tableCount);
    for (const header of await page.locator('main thead th').all()) {
      await expect(header).toHaveAttribute('scope', 'col');
    }
    const rowHeaders = await page.locator('main tbody th').all();
    expect(rowHeaders.length).toBeGreaterThan(0);
    for (const header of rowHeaders) {
      await expect(header).toHaveAttribute('scope', 'row');
    }

    /* The old table scrolled inside a box that gave no sign it scrolled, so its cut-off
       last column read as data the archive had lost. Nothing here may be clipped at all. */
    const clipped = await page
      .locator('.missing-set')
      .evaluateAll((cards) => cards.filter((card) => card.scrollWidth > card.clientWidth + 1).length);
    expect(clipped, 'no list is cut off at the edge of its own card').toBe(0);
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
