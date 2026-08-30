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

/*
 * A status cell, counted from the artifact rather than from the page: every row the sheet
 * gave a status to has to end up as exactly one list item wearing exactly one mark, and
 * that is the whole assertion that the status column became marks without dropping rows.
 * Anchored and terminated so a name that merely opens with the same word is not counted —
 * none does today, and the count assertion below would fail loudly if one ever did.
 */
const STATUS_WORDS = ['יש', 'צריך לסרוק', 'חסר'] as const;
const STATUS_CELL = /^(יש|צריך לסרוק|חסר)($|[\s(,.])/u;
const normalizedCells = expectedList.rows.flat().map(normalize);
const expectedStatusCells = normalizedCells.filter((cell) => STATUS_CELL.test(cell)).length;

/* The sheet qualifies some of its answers — "יש (חסר סריקה של ספר הסברים)" is still a yes —
   so the page buckets by the opening word, and so does this. Four numbers from one source:
   if the sentence at the top of the page ever stops agreeing with the sheet, this fails. */
const expectedPerWord = STATUS_WORDS.map(
  (word) => normalizedCells.filter((cell) => STATUS_CELL.test(cell) && cell.startsWith(word)).length,
);

test('the missing list is a page to read, not a trip to a spreadsheet', async ({ page }) => {
  await page.goto(site.route('missing/'));

  await expect(page.getByRole('heading', { level: 1, name: 'מה עוד חסר לנו' })).toBeVisible();

  const groups = page.locator('.missing-group');
  if (expectedList.rows.length === 0) {
    /* Degrading honestly means saying the list is not here, never that nothing is missing —
       and never showing a legend or an arithmetic sentence about rows that are not there. */
    await expect(groups).toHaveCount(0);
    await expect(page.locator('.missing-legend')).toHaveCount(0);
    await expect(page.locator('.missing-summary')).toHaveCount(0);
    await expect(page.locator('.empty-archive')).toContainText('הרשימה עצמה לא פה כרגע');
  } else {
    await expect(groups.first()).toBeVisible();

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
       320px as at 1440px. It also covers the three status words, which live in the legend
       once each now instead of in a column repeated on every list. */
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

    /*
     * The gutters are gone, so nothing is announced as a NUMBERED column any more. Matched on
     * the number rather than the word: the sheet's three empty spacer columns used to render as
     * headers reading "עמודה 1", "עמודה 3", "עמודה 6", and that is what must never come back.
     * The word itself is now legitimate prose — the legend opens
     * "העמודה שנקראה סטטוס הפכה כאן לשלושה סימנים" to explain where the status column went —
     * and a blanket substring check forbids the page from describing its own change.
     */
    expect(pageText).not.toMatch(/עמודה\s*\d/u);

    /* One statused row, one mark. Counted against the artifact, so a restructure that
       merged two rows or dropped one fails here even though every distinct value would
       still be findable in the text above. */
    expect(expectedStatusCells, 'the artifact still carries statuses').toBeGreaterThan(0);
    await expect(page.locator('.missing-groups .missing-mark')).toHaveCount(expectedStatusCells);
    /* Not equality: a list the sheet never gave a status to renders items and no marks, and
       that is a shape the parser has always allowed. Fewer items than marks is the bug. */
    expect(await page.locator('.missing-groups li').count()).toBeGreaterThanOrEqual(
      expectedStatusCells,
    );

    /* Each list names itself with a real heading, and every row says something. Without the
       heading the rows are a run of unlabelled strings to a screen reader, exactly as they
       were when the gutters were announced as columns. */
    const headings = await groups.locator('h2').all();
    expect(headings.length).toBe(await groups.count());
    for (const heading of headings) {
      expect(normalize((await heading.textContent()) ?? '')).not.toBe('');
    }
    for (const item of await page.locator('.missing-groups li').all()) {
      expect(normalize((await item.textContent()) ?? '')).not.toBe('');
    }

    /* The marks are decoration in the accessibility tree and the status word next to them
       is the real content, so a screen reader hears "יש" and never an emoji's English name.
       Asserted on every mark, because one unhidden glyph is one row that reads as noise. */
    for (const mark of await page.locator('.missing-mark').all()) {
      await expect(mark).toHaveAttribute('aria-hidden', 'true');
    }

    /* Learned once. Three marks, three words, and the words are the sheet's own — the
       legend is where "יש" and "צריך לסרוק" and "חסר" survive the column being removed. */
    const legendWords = page.locator('.missing-legend .missing-legend-word');
    await expect(legendWords).toHaveText(['יש', 'צריך לסרוק', 'חסר']);
    await expect(page.locator('.missing-legend .missing-mark')).toHaveCount(3);

    /* The page is titled "what we still lack" and most of its rows say יש. That has to be
       readable before the lists rather than after all of them, and it has to be the sheet's
       own arithmetic: the total and all three buckets, every one of them derived above. */
    const summary = page.locator('.missing-summary');
    await expect(summary).toContainText(String(expectedStatusCells));
    for (const count of expectedPerWord) {
      await expect(summary).toContainText(String(count));
    }
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
