import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import MiniSearch from 'minisearch';
import { getSearchOptions, type SearchDocument } from '../../src/catalog/search';

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

test('Hebrew search ranks the collection before English-named files', async ({ page }) => {
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');

  await expect(page.getByRole('searchbox', { name: 'מה מחפשים?' })).toHaveValue('פיפוש 1');
  await expect(page.locator('[data-search-status]')).toContainText('תוצאות');
  const results = page.locator('[data-search-results] > li');
  await expect(results.first()).toContainText('פיפוש 1');
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
});

test('Latin-only search is unsupported while mixed queries use their Hebrew words', async ({ page }) => {
  await page.goto('/search/?q=piposh');
  await expect(page.locator('[data-search-status]')).toHaveText('החיפוש באתר הוא בעברית.');
  await expect(page.locator('[data-search-results] > li')).toHaveCount(0);

  await page.goto('/search/?q=piposh%20%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');
  await expect(page.locator('[data-search-results] > li').first()).toContainText('פיפוש 1');
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
});

test('search submission and category changes rerun the current Hebrew query', async ({ page }) => {
  let indexRequests = 0;
  await page.route('**/data/search-index.json', async (route) => {
    indexRequests += 1;
    await route.continue();
  });
  await page.goto('/search/');

  const form = page.getByRole('search', { name: 'חיפוש בארכיון' });
  await expect(form).toHaveAttribute('action', '/search/');
  await expect(form).toHaveAttribute('method', 'get');
  const input = page.getByRole('searchbox', { name: 'מה מחפשים?' });
  await expect(input).toHaveAccessibleDescription(/תומך במילות חיפוש בעברית/u);
  await input.fill('פיפוש');
  await page.getByRole('button', { name: 'חיפוש' }).click();
  await expect(page.getByRole('link', { name: 'פתיחת אוסף — פיפוש 1' })).toBeVisible();

  await page.getByLabel('סוג חומר').selectOption('פתרונות');
  await expect(page.getByText('פיפוש 1 - פתרון.docx', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toHaveCount(0);
  expect(indexRequests).toBe(1);
});

test('search controls cannot drift while a delayed index is loading', async ({ page }) => {
  let releaseRequest!: () => void;
  let markRequested!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const requestRelease = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  await page.route('**/data/search-index.json', async (route) => {
    markRequested();
    await requestRelease;
    await route.continue();
  });

  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');
  await requestStarted;
  const input = page.getByRole('searchbox', { name: 'מה מחפשים?' });
  const category = page.getByLabel('סוג חומר');
  const submit = page.getByRole('button', { name: 'חיפוש' });
  try {
    await expect(page.locator('[data-search-root]')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('[data-search-status]')).toContainText('טוענים');
    await expect(input).toBeDisabled();
    await expect(category).toBeDisabled();
    await expect(submit).toBeDisabled();
  } finally {
    releaseRequest();
  }

  await expect(input).toBeEnabled();
  await expect(category).toBeEnabled();
  await expect(submit).toBeEnabled();
  await expect(input).toHaveValue('פיפוש 1');
  await expect(page.locator('[data-search-root]')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-search-results] > li').first()).toContainText('פיפוש 1');
});

test('static search form remains useful and non-busy without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/search/');
    const root = page.locator('[data-search-root]');
    await expect(root).toHaveAttribute('aria-busy', 'false');
    await expect(root.locator('[data-search-status]')).toContainText('כתבו משהו בעברית');
    await expect(root.locator('[data-search-status]')).not.toContainText('טוענים');
    await expect(page.getByRole('searchbox', { name: 'מה מחפשים?' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'חיפוש' })).toBeEnabled();
    await expect(root.getByRole('link', { name: 'כל הארכיון' })).toBeVisible();
    await expect(page.getByRole('search', { name: 'חיפוש בארכיון' })).toHaveAttribute(
      'action',
      '/search/',
    );
  } finally {
    await context.close();
  }
});

for (const failure of ['aborted', 'non-OK', 'corrupt'] as const) {
  test(`search ${failure} index failure keeps an explicit browse fallback`, async ({ page }) => {
    await page.route('**/data/search-index.json', async (route) => {
      if (failure === 'aborted') {
        await route.abort();
      } else if (failure === 'non-OK') {
        await route.fulfill({ status: 503, body: 'unavailable' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{broken' });
      }
    });
    await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9');

    await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toHaveAttribute('href', '/archive/');
    await expect(page.locator('[data-search-results] > li')).toHaveCount(0);
    await expect(page.locator('[data-search-root]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('searchbox', { name: 'מה מחפשים?' })).toBeEnabled();
    await expect(page.getByLabel('סוג חומר')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'חיפוש' })).toBeEnabled();
  });
}

test('unexpected stored search metadata fails safely without unsafe result links', async ({ page }) => {
  await page.route('**/data/search-index.json', async (route) => {
    const response = await route.fetch();
    const serialized = JSON.parse(await response.text()) as {
      storedFields: Record<string, { href?: string; viewUrl?: string; downloadUrl?: string }>;
    };
    serialized.storedFields['0']!.href = 'javascript:alert(1)';
    serialized.storedFields['6']!.viewUrl = 'data:text/html,unsafe';
    serialized.storedFields['6']!.downloadUrl = '//unsafe.example/file';
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(serialized),
    });
  });
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9');

  await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
  await expect(page.locator('[data-search-root] a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('[data-search-root] a[href^="data:"]')).toHaveCount(0);
  await expect(page.locator('[data-search-root] a[href^="//"]')).toHaveCount(0);
});

for (const corruption of ['file without view URL', 'file disguised as collection'] as const) {
  test(`search rejects ${corruption} without partial results`, async ({ page }) => {
    await page.route('**/data/search-index.json', async (route) => {
      const response = await route.fetch();
      const serialized = JSON.parse(await response.text()) as {
        storedFields: Record<string, Record<string, unknown>>;
      };
      const englishFile = serialized.storedFields['6']!;
      if (corruption === 'file without view URL') {
        englishFile.viewUrl = null;
      } else {
        englishFile.kind = 'collection';
        englishFile.titleHe = 'מהדורה זרה';
        englishFile.href = '/games/piposh-1/';
      }
      await route.fulfill({
        response,
        contentType: 'application/json',
        body: JSON.stringify(serialized),
      });
    });

    await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');
    await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
    await expect(page.locator('[data-search-results] > li')).toHaveCount(0);
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toBeVisible();
  });
}

test('search result actions expose exact metadata and safe Drive links', async ({ page }) => {
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');

  const englishResult = page
    .locator('[data-search-results] > li')
    .filter({ hasText: 'piposh1-english.exe' });
  await expect(englishResult.locator('.result-heading bdi')).toHaveText('piposh1-english.exe');
  await expect(englishResult).toContainText('משחקים מלאים');
  await expect(englishResult).toContainText('application/x-msdownload');
  await expect(englishResult).toContainText('משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe');
  for (const actionName of [
    'צפייה ב־Drive — piposh1-english.exe',
    'הורדה — piposh1-english.exe',
  ]) {
    const action = englishResult.getByRole('link', { name: actionName });
    await expect(action).toHaveAttribute('href', /^https:\/\/drive\.google\.com\//u);
    await expect(action).toHaveAttribute('target', '_blank');
    await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(
    page.getByRole('link', { name: 'פתיחת אוסף — פיפוש 1' }),
  ).toHaveAttribute('href', '/games/piposh-1/');
});

test('search has honest empty, singular, and plural count wording', async ({ page }) => {
  await page.goto('/search/?q=%D7%A7%D7%A9%D7%A7%D7%95%D7%A9');
  await expect(page.locator('[data-search-status]')).toHaveText(
    'לא מצאנו תוצאות. אפילו לא מתחת לשטיח.',
  );

  await page.goto('/search/?q=%D7%9E%D7%AA%D7%97%D7%99%D7%9C%D7%99%D7%9D');
  await page.getByLabel('סוג חומר').selectOption('פתרונות');
  await expect(page.locator('[data-search-status]')).toHaveText('תוצאה אחת');

  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9');
  await expect(page.locator('[data-search-status]')).toHaveText(/^[2-9]\d* תוצאות$/u);
});

test('search reports the true total while rendering at most 100 results', async ({ page }) => {
  const documents: SearchDocument[] = Array.from({ length: 101 }, (_, index) => ({
    id: `file:${index.toString().padStart(3, '0')}`,
    kind: 'file',
    titleHe: 'אוצר',
    aliasesHe: '',
    pathHe: '',
    relationshipsHe: '',
    tagsHe: '',
    categoriesHe: 'מסמכים',
    descriptionHe: '',
    textHe: '',
    href: `https://drive.google.com/file/d/${index}/view`,
    category: 'מסמכים',
    categories: ['מסמכים'],
    filename: `very-long-latin-archive-filename-${index}.bin`,
    path: `מסמכים/very-long-latin-archive-filename-${index}.bin`,
    mimeType: 'application/octet-stream',
    size: index,
    collectionLinks: [],
    viewUrl: `https://drive.google.com/file/d/${index}/view`,
    downloadUrl: null,
  }));
  const index = new MiniSearch<SearchDocument>(getSearchOptions());
  index.addAll(documents);
  await page.route('**/data/search-index.json', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(index),
    }),
  );

  await page.goto('/search/?q=%D7%90%D7%95%D7%A6%D7%A8');
  await expect(page.locator('[data-search-status]')).toHaveText(
    '101 תוצאות. מוצגות רק 100 התוצאות הראשונות.',
  );
  await expect(page.locator('[data-search-results] > li')).toHaveCount(100);
});

test('search page is accessible and stays within a 320px viewport', async ({ page }, testInfo) => {
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  if (testInfo.project.name === '320px') {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false);
    await expectWithinViewport(page, page.locator('[data-search-root]'));
    for (const result of await page.locator('[data-search-results] > li').all()) {
      await expectWithinViewport(page, result);
    }
  }
});
