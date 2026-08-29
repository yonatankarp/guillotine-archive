import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loadCatalog } from '../../src/lib/catalog';
import { categorySlug } from '../../src/lib/url';
import { playwrightRuntime } from '../support/playwright-runtime';

const EXPECTED_PAGE_SIZE = 100;
const expectedCatalog = loadCatalog('src/generated/catalog.json', false);
const { site } = playwrightRuntime;

const itemsByCategory = new Map(
  expectedCatalog.categories.map((category) => [
    category,
    expectedCatalog.items.filter((item) => item.category === category),
  ]),
);
const largestCategory = [...itemsByCategory].sort(
  ([, firstItems], [, secondItems]) => secondItems.length - firstItems.length,
)[0];

if (!largestCategory) throw new Error('generated catalog must contain an archive category');

const [category, expectedItems] = largestCategory;
const slug = categorySlug(category);
const pageNumbers = Array.from(
  { length: Math.max(1, Math.ceil(expectedItems.length / EXPECTED_PAGE_SIZE)) },
  (_, index) => index + 1,
);

function pageRoute(page: number): string {
  return page === 1 ? `archive/${slug}/` : `archive/${slug}/page/${page}/`;
}

test('large categories are fully covered by linked static pages capped at 100 items', async ({
  page,
}) => {
  const renderedPaths: string[] = [];
  const renderedViewUrls: string[] = [];

  for (const pageNumber of pageNumbers) {
    await page.goto(site.route(pageRoute(pageNumber)));

    const fileItems = page.locator('.file-list > li');
    const expectedPageItems = expectedItems.slice(
      (pageNumber - 1) * EXPECTED_PAGE_SIZE,
      pageNumber * EXPECTED_PAGE_SIZE,
    );
    await expect(fileItems).toHaveCount(expectedPageItems.length);
    expect(expectedPageItems.length).toBeLessThanOrEqual(EXPECTED_PAGE_SIZE);
    /*
     * A row prints its path in two halves: the name in the heading, the folders under it, so
     * that the filename is not written twice. Rejoining them here keeps this assertion on the
     * whole path — the page still promises the path exactly as it was saved — and reads both
     * halves off the same <li> so a row without a folder cannot shift one list against the
     * other. Only 'מה חסר?' sits at the archive root and has no folder half.
     */
    renderedPaths.push(
      ...(await fileItems.evaluateAll((rows) =>
        rows.map((row) => {
          const name = row.querySelector('.file-copy > strong bdi')?.textContent?.trim() ?? '';
          const folder = row.querySelector('.file-path bdi')?.textContent?.trim();
          return folder ? `${folder}/${name}` : name;
        }),
      )),
    );
    renderedViewUrls.push(
      ...(await page.locator('.file-action.view').evaluateAll((links) =>
        links.map((link) => (link as HTMLAnchorElement).href),
      )),
    );

    const pagination = page.getByRole('navigation', { name: 'עמודי קטגוריה' });
    if (pageNumbers.length === 1) {
      await expect(pagination).toHaveCount(0);
    } else {
      await expect(pagination).toContainText(`עמוד ${pageNumber} מתוך ${pageNumbers.length}`);
      if (pageNumber < pageNumbers.length) {
        await expect(
          pagination.getByRole('link', { name: `לעמוד הבא, עמוד ${pageNumber + 1}` }),
        ).toHaveAttribute('href', site.route(pageRoute(pageNumber + 1)));
      }
    }
  }

  expect(renderedPaths).toEqual(expectedItems.map(({ path }) => path));
  expect(renderedViewUrls).toEqual(expectedItems.map(({ viewUrl }) => viewUrl));
});

test('pagination keeps page one canonical, rejects non-generated pages, and is accessible', async ({
  page,
}) => {
  test.skip(pageNumbers.length < 2, 'fixture catalog has no category requiring page 2');

  await page.goto(site.route(pageRoute(2)));

  const pagination = page.getByRole('navigation', { name: 'עמודי קטגוריה' });
  await expect(pagination.getByText(`עמוד 2 מתוך ${pageNumbers.length}`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    pagination.getByRole('link', { name: 'לעמוד הקודם, עמוד 1' }),
  ).toHaveAttribute('href', site.route(pageRoute(1)));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  for (const invalidRoute of [
    `archive/${slug}/page/1/`,
    `archive/${slug}/page/${pageNumbers.length + 1}/`,
  ]) {
    const response = await page.goto(site.route(invalidRoute));
    expect(response?.status(), invalidRoute).toBe(404);
  }
});
