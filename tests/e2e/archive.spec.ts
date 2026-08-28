import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import MiniSearch from 'minisearch';
import { getSearchOptions, type SearchDocument } from '../../src/catalog/search';
import type { CatalogItem } from '../../src/catalog/types';
import { formatFileCount } from '../../src/lib/archive';
import { releaseCoverPath, releaseItems, releaseSections } from '../../src/components/release-view';
import { itemById, loadCatalog } from '../../src/lib/catalog';
import { hasHorizontalOverflow } from '../support/horizontal-overflow';
import { playwrightRuntime } from '../support/playwright-runtime';

const expectedCatalog = loadCatalog('src/generated/catalog.json', false);
const expectedReleases = expectedCatalog.releases;
const { site } = playwrightRuntime;
const searchIndexPattern = `**${site.route('data/search-index.json')}`;

/** Items the curator filed into one named group of a collection. */
function expectedGroupItems(collectionSlug: string, groupHe: string): CatalogItem[] {
  return expectedCatalog.items.filter((item) =>
    item.collectionLinks.some(
      (link) =>
        link.slug === collectionSlug &&
        link.relationship === 'part-of-release' &&
        link.groupHe === groupHe,
    ),
  );
}

function expectedRelease(slug: string) {
  const release = expectedReleases.find((candidate) => candidate.slug === slug);
  if (!release) throw new Error(`generated catalog is missing release ${slug}`);
  return release;
}

/**
 * The href a search result renders comes from the committed index, not from a page render.
 * That artifact is only rewritten by a real Drive sync, so it lags `collectionHref` in
 * src/catalog/search.ts: it still stores /games/<slug>/ while the generator emits
 * /release/<slug>/. Reading the expectation out of the artifact keeps this correct both
 * before and after the sync that regenerates it, instead of being wrong on one side.
 */
function storedCollectionHref(titleHe: string): string {
  const index = JSON.parse(readFileSync('public/data/search-index.json', 'utf8')) as {
    storedFields: Record<string, { kind?: string; titleHe?: string; href?: string }>;
  };
  const document = Object.values(index.storedFields).find(
    (stored) => stored?.kind === 'collection' && stored.titleHe === titleHe,
  );
  if (!document?.href) throw new Error(`search index has no collection document ${titleHe}`);

  return site.route(document.href.replace(/^\//u, ''));
}

function searchFileDocument(
  id: string,
  titleHe: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  const category = overrides.category ?? 'פתרונות';
  const viewUrl = `https://drive.google.com/file/d/${id}/view`;

  return {
    id: `file:${id}`,
    kind: 'file',
    titleHe,
    aliasesHe: '',
    pathHe: titleHe,
    relationshipsHe: '',
    tagsHe: '',
    categoriesHe: category,
    descriptionHe: '',
    textHe: '',
    href: viewUrl,
    category,
    categories: [category],
    filename: `${id}.bin`,
    path: `${category}/${id}.bin`,
    mimeType: 'application/octet-stream',
    size: 42,
    collectionLinks: [],
    viewUrl,
    downloadUrl: null,
    ...overrides,
  };
}

function serializedSearchIndex(documents: readonly SearchDocument[]): string {
  const index = new MiniSearch<SearchDocument>(getSearchOptions());
  index.addAll([...documents]);
  return JSON.stringify(index);
}

async function useSearchIndex(page: Page, documents: readonly SearchDocument[]): Promise<void> {
  const body = serializedSearchIndex(documents);
  await page.route(searchIndexPattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body }),
  );
}

async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
  const viewport = page.viewportSize();
  const box = await locator.boundingBox();
  expect(viewport).not.toBeNull();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 0.5);
}

async function expectNotOverlapping(first: Locator, second: Locator): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  const overlaps = !(
    firstBox!.x + firstBox!.width <= secondBox!.x
    || secondBox!.x + secondBox!.width <= firstBox!.x
    || firstBox!.y + firstBox!.height <= secondBox!.y
    || secondBox!.y + secondBox!.height <= firstBox!.y
  );
  expect(overlaps).toBe(false);
}

test('homepage is a Hebrew RTL, cover-first grid of the six games only', async ({ page }) => {
  await page.goto(site.route());
  await expect(page).toHaveURL(site.url());

  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: 'ארכיון גיליוטין' })).toHaveCount(1);

  /* The home page is the games and nothing else. Putting the other 36 releases
     under them is what buried them, so everything else lives behind a tab. */
  const games = expectedReleases.filter(({ type }) => type === 'game');
  const tiles = page.getByTestId('release-tile');
  expect(expectedReleases).toHaveLength(42);
  expect(games).toHaveLength(6);
  await expect(tiles).toHaveCount(games.length);

  for (const release of expectedReleases.filter(({ type }) => type !== 'game')) {
    await expect(
      page.locator(`[data-release="${release.slug}"]`),
      `${release.slug} is not on the home page`,
    ).toHaveCount(0);
  }

  for (const release of games) {
    const tile = page.locator(`[data-release="${release.slug}"]`);
    await expect(tile, `${release.slug} tile`).toHaveCount(1);
    await expect(tile).toHaveAttribute('href', site.route(`release/${release.slug}/`));
    const image = tile.locator('.release-cover > img');
    const placeholder = tile.locator('.release-cover > .release-placeholder');
    const coverPath = releaseCoverPath(release);
    if (coverPath) {
      await expect(image, `${release.slug} cover`).toHaveCount(1);
      await expect(image).toHaveAttribute(
        'src',
        site.route(coverPath),
      );
      /* Matted, not filled. Covers are not all 3:4 — פיפוש 2's scan is a near-square front
         panel — and filling the frame meant cropping, which cut its title off both sides.
         Showing the whole artwork beats a uniform edge-to-edge grid. */
      await expect(image).toHaveCSS('object-fit', 'contain');
      await expect(placeholder, `${release.slug} has no placeholder with a cover`).toHaveCount(0);
    } else {
      await expect(image, `${release.slug} has no image without a cover`).toHaveCount(0);
      await expect(placeholder, `${release.slug} placeholder`).toHaveCount(1);
    }
  }

  /* Every cover the page claims is a real file, not a broken link. Derived through
     releaseCoverPath rather than off coverFileId, because a release can carry a site-only
     cover that never entered the catalog — פיפוש המהפכה has one, since no image of its box
     exists in the archive at all. */
  const coveredSlugs = expectedReleases.filter(releaseCoverPath).map(({ slug }) => slug);
  expect(coveredSlugs.length, 'the grid shows covers').toBeGreaterThan(0);
  for (const slug of coveredSlugs) {
    const image = page.locator(`[data-release="${slug}"] .release-cover > img`);
    // Covers are lazy, so a tile below the fold has not fetched yet on a phone viewport.
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          image.evaluate(
            (element: HTMLImageElement) => element.complete && element.naturalWidth > 0,
          ),
        { message: `${slug} cover loaded` },
      )
      .toBe(true);
  }

  // The only quoted line on the page is a real archive string, printed with its source file.
  await expect(page.getByText('בבקשה תקראו אותי - משעמם להיות פה לבד')).toBeVisible();
  await expect(page.locator('.found-string figcaption')).toContainText('דיסק הקונגרס');


  const character = page.getByRole('img', { name: 'חזי מפיפוש מציץ אל הארכיון' });
  await expect(character).toBeVisible();
  await expect(character).toHaveAttribute('src', site.route('assets/characters/hezi.png'));
  expect(
    await character.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    })),
  ).toEqual({ complete: true, naturalWidth: 145, naturalHeight: 365 });
  await expect(character).toHaveCSS('filter', 'none');
  await expect(character).toHaveCSS('mix-blend-mode', 'normal');
  await expect(character).toHaveCSS('opacity', '1');
  await expect(character).toHaveCSS('object-fit', 'contain');
  await expectNotOverlapping(character, page.getByRole('heading', { level: 1 }));

  const skipLink = page.getByRole('link', { name: 'דלגו לתוכן' });
  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveAttribute('href', '#main');
  await expect(page.getByRole('navigation', { name: 'ניווט ראשי' })).toBeVisible();
  // The archive shelves are demoted rather than deleted.
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'כל הקבצים לפי מדף' }),
  ).toHaveAttribute('href', site.route('archive/'));
  // Storage is an implementation detail, so no page names the service that holds the files.
  await expect(page.getByRole('contentinfo')).toContainText('נפתחים בלשונית חדשה');
  await expect(page.getByRole('contentinfo').getByText(/Drive/u)).toHaveCount(0);

  expect(await hasHorizontalOverflow(page), 'the page never scrolls sideways').toBe(false);
  await expectWithinViewport(page, page.locator('.site-header'));
  await expectWithinViewport(page, character);
  for (const tile of await tiles.all()) await expectWithinViewport(page, tile);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('the Piposh 1 room shows only the sections it has, with direct Drive actions', async ({ page }) => {
  await page.goto(site.route('release/piposh-1/'));

  await expect(page.getByRole('heading', { level: 1, name: 'פיפוש 1' })).toBeVisible();

  /* Derived, because this room's contents change when the owner adds material — it gained a
     music section the day its audio disc was unpacked in Drive, and a hardcoded "no music
     here" failed a sync that had done exactly what it was asked to. The invariant that
     survives is the page agreeing with the catalog. */
  const piposhOne = expectedReleases.find(({ slug }) => slug === 'piposh-1')!;
  const sections = releaseSections(releaseItems(piposhOne, itemById)).map(
    ({ headingHe }) => headingHe,
  );
  expect(sections.length, 'piposh-1 has sections to show').toBeGreaterThan(0);

  for (const heading of sections) {
    await expect(page.getByRole('heading', { name: heading }), `shows ${heading}`).toBeVisible();
  }

  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'צפייה — piposh1.exe' }),
  ).toHaveAttribute('href', /^https:\/\/drive\.google\.com\//u);
  await expect(
    page.getByRole('link', { name: 'הורדה — piposh1.exe' }),
  ).toHaveAttribute('href', /drive\.google\.com/u);

  // The curator's grouping of a release survives as a per-row label.
  await expect(page.locator('.item-group', { hasText: 'גרסאות בעברית' }).first()).toBeVisible();
  await expect(
    page.locator('.item-group', { hasText: 'מהדורות רשמיות בשפות זרות' }).first(),
  ).toBeVisible();

  await expect(page.locator('main [download]')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('complete archive browsing remains available without search', async ({ page }) => {
  const solutionItems = expectedCatalog.items.filter(({ category }) => category === 'פתרונות');
  const solutionCountLabel = formatFileCount(solutionItems.length);
  await page.goto(site.route('archive/'));

  await expect(page.getByRole('heading', { level: 1, name: 'כל הקבצים, מדף אחרי מדף' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: `פתרונות, ${solutionCountLabel}` }),
  ).toBeVisible();
  await page.getByRole('link', { name: /משחקים מלאים/u }).click();
  await expect(page).toHaveURL(site.url('archive/games/'));
  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  /* /release/<slug>/ is generated for all 42 releases; /games/<slug>/ only for the six
     games, so a collection link built on it 404s for the other 36. */
  await expect(
    page.getByRole('link', { name: 'שייך למהדורה הרשמית: פיפוש 1' }).first(),
  ).toHaveAttribute('href', site.route('release/piposh-1/'));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto(site.route('archive/solutions/'));
  await expect(page.locator('.category-intro > p')).toContainText(
    `${solutionCountLabel} בקטגוריה הזאת.`,
  );
  await expect(page.locator('.file-list > li')).toHaveCount(solutionItems.length);
});

test('the legacy /games/<slug>/ alias still renders the release room', async ({ page }) => {
  /* The catalog renders collection links as /release/<slug>/, generated for all 42. The
     committed search index still stores /games/<slug>/ and is only rewritten by a Drive
     sync, and a deployed site keeps serving that index until the sync merges, so this
     alias has to go on resolving. It covers the six games and nothing else. */
  const release = expectedRelease('piposh-2');
  await page.goto(site.route(`games/${release.slug}/`));

  await expect(page.getByRole('heading', { level: 1, name: release.titleHe })).toBeVisible();
  await expect(page.locator('.release-room')).toHaveCount(1);
  /* Anchored on the section id, not its wording: this test cares that the alias renders a
     complete room, and the heading copy belongs to whoever owns ReleaseRoom. */
  await expect(page.locator('#section-all')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('/games/ is the one page holding every release, and the widening chip lands on it', async ({
  page,
}) => {
  /* The chip promised the full count and pointed at the home page, which is the six
     games. Nothing linked to /games/ at all, so the archive had no all-releases page. */
  const games = expectedReleases.filter(({ type }) => type === 'game');
  await page.goto(site.route('games/'));

  await expect(page.getByRole('heading', { level: 1, name: 'כל מה שיש לנו' })).toHaveCount(1);
  const cells = page.locator('.release-grid > li');
  await expect(cells).toHaveCount(expectedReleases.length);
  for (const release of expectedReleases) {
    await expect(
      page.locator(`[data-release="${release.slug}"]`),
      `${release.slug} is on the all-releases page`,
    ).toHaveCount(1);
  }

  // Games lead here exactly as they do on the home page.
  for (let index = 0; index < games.length; index += 1) {
    await expect(cells.nth(index), `tile ${index} is a game`).toHaveAttribute(
      'data-release-type',
      'game',
    );
  }
  await expect(cells.nth(games.length)).not.toHaveAttribute('data-release-type', 'game');

  const widening = page.locator('.facet-chip').first();
  await expect(widening).toContainText('הכול');
  await expect(widening).toContainText(String(expectedReleases.length));
  await expect(widening).toHaveAttribute('href', site.route('games/'));
  await expect(widening).toHaveAttribute('aria-current', 'page');

  /* The tab strip already lists every type, so repeating them as chips shipped each
     type twice to the same URL. */
  const tabs = page.getByRole('navigation', { name: 'מדורי הארכיון' });
  await expect(tabs).toBeVisible();
  await expect(page.locator('.facets a[href*="/browse/type/"]')).toHaveCount(0);

  // This page is not one type, so no tab may claim to be the current page.
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(0);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('subject and year pages mark no tab current and never repeat the types as chips', async ({
  page,
}) => {
  /* Every non-type facet page passed 'other' as the active tab, so a screen reader
     announced the visitor was inside לא ברור מה זה on all seven of them. */
  const subjectSlug = expectedCatalog.releaseFacets.subjectSlugs.find((slug) =>
    expectedReleases.some((release) => release.subjectSlug === slug),
  );
  expect(subjectSlug, 'the catalog has at least one subject facet page').toBeDefined();
  const year = expectedCatalog.releaseFacets.years[0];
  expect(year, 'the catalog has at least one year facet page').toBeDefined();

  for (const path of [`browse/subject/${subjectSlug!}/`, `browse/year/${year!}/`]) {
    await page.goto(site.route(path));

    const tabs = page.getByRole('navigation', { name: 'מדורי הארכיון' });
    await expect(tabs, `${path} shows the tab strip`).toBeVisible();
    await expect(
      tabs.locator('[aria-current="page"]'),
      `${path} marks no tab as the current page`,
    ).toHaveCount(0);
    await expect(
      tabs.getByRole('link', { name: /לא ברור מה זה/u }),
      `${path} keeps the other tab, unmarked`,
    ).toHaveCount(1);

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});

test('every filtered page keeps a route back to the all-releases page', async ({ page }) => {
  /* The widening control is the only way out of a filter without the back button, so a
     type page that drops the whole chip bar is the same dead end in a new place. */
  const subjectSlug = expectedCatalog.releaseFacets.subjectSlugs[0];
  const year = expectedCatalog.releaseFacets.years[0];

  for (const path of [
    'browse/type/game/',
    `browse/subject/${subjectSlug!}/`,
    `browse/year/${year!}/`,
  ]) {
    await page.goto(site.route(path));

    const widening = page.locator('.facet-chip').first();
    await expect(widening, `${path} offers the widening chip`).toContainText('הכול');
    await expect(widening, `${path} widening chip target`).toHaveAttribute(
      'href',
      site.route('games/'),
    );
    // It widens, so it must not claim the visitor is already there.
    await expect(widening).not.toHaveAttribute('aria-current', 'page');

    await expect(
      page.locator('.facets a[href*="/browse/type/"]'),
      `${path} does not repeat the tab strip as chips`,
    ).toHaveCount(0);
  }
});

test('the header sends every page to the all-releases list, and the brand still goes home', async ({
  page,
}) => {
  await page.goto(site.route('release/piposh-1/'));

  const nav = page.getByRole('navigation', { name: 'ניווט ראשי' });
  await expect(nav.getByRole('link', { name: 'מהדורות' })).toHaveAttribute(
    'href',
    site.route('games/'),
  );
  await expect(
    page.getByRole('link', { name: 'ארכיון גיליוטין — דף הבית' }),
  ).toHaveAttribute('href', site.route());
});

test('release tiles sit a heading level below the section that contains them', async ({ page }) => {
  /* Tiles emitted h2, so each title read as a peer of the h2 introducing the grid.
     axe cannot see this: no level is skipped, the outline is simply wrong. */
  for (const [path, expectedTiles] of [
    ['', expectedReleases.filter(({ type }) => type === 'game').length],
    ['games/', expectedReleases.length],
    ['browse/type/game/', expectedReleases.filter(({ type }) => type === 'game').length],
  ] as const) {
    await page.goto(site.route(path));

    await expect(
      page.locator('.release-copy h3'),
      `${path || 'home'} tile titles are h3`,
    ).toHaveCount(expectedTiles);
    await expect(
      page.locator('.release-copy h2'),
      `${path || 'home'} has no tile title left at h2`,
    ).toHaveCount(0);
    // A tile is only correctly nested if a real h2 introduces the grid above it.
    expect(
      await page.getByRole('heading', { level: 2 }).count(),
      `${path || 'home'} has a section heading above the grid`,
    ).toBeGreaterThan(0);
  }
});

test('Drive actions and back links have a high-contrast visible focus indicator', async ({ page }) => {
  for (const [path, accessibleName] of [
    ['release/piposh-1/', 'צפייה — piposh1.exe'],
    ['archive/games/', 'חזרה לכל המדפים'],
  ] as const) {
    await page.goto(site.route(path));
    const link = page.getByRole('link', { name: accessibleName }).first();
    await link.focus();
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS('outline-color', 'rgb(20, 23, 16)');
    await expect(link).toHaveCSS('outline-style', 'solid');
    await expect(link).toHaveCSS('outline-width', '4px');
  }
});

test('new archive pages remain within a 320px viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== '320px', 'narrow viewport check');

  for (const path of [
    'release/piposh-1/',
    'release/fan-disc-69541b3e/',
    'games/',
    'browse/type/game/',
    'browse/year/1999/',
    'listen/',
    'watch/',
    'archive/',
    'archive/games/',
    'about/',
  ]) {
    await page.goto(site.route(path));
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
  await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201'));

  await expect(page.getByRole('searchbox', { name: 'נו, מה מחפשים?' })).toHaveValue('פיפוש 1');
  await expect(page.locator('[data-search-status]')).toContainText('תוצאות');
  const results = page.locator('[data-search-results] > li');
  await expect(results.first()).toContainText('פיפוש 1');
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
  await expect(page.getByText('piposh1.exe', { exact: true })).toBeVisible();
});

test('Latin-only search is unsupported while mixed queries use their Hebrew words', async ({ page }) => {
  await page.goto(site.route('search/?q=piposh'));
  await expect(page.locator('[data-search-status]')).toHaveText('החיפוש פה עובד בעברית בלבד. סליחה, ככה בנינו אותו.');
  await expect(page.locator('[data-search-results] > li')).toHaveCount(0);

  await page.goto(site.route('search/?q=piposh%20%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201'));
  await expect(page.locator('[data-search-results] > li').first()).toContainText('פיפוש 1');
  await expect(page.getByText('piposh1-english.exe', { exact: true })).toBeVisible();
});

test('search submission and category changes rerun the current Hebrew query', async ({ page }) => {
  const solutions = expectedGroupItems('piposh-1', 'פתרונות');
  expect(solutions).toHaveLength(1);
  const solution = solutions[0]!;
  let indexRequests = 0;
  await page.route(searchIndexPattern, async (route) => {
    indexRequests += 1;
    await route.continue();
  });
  await page.goto(site.route('search/'));

  const form = page.getByRole('search', { name: 'חיפוש בארכיון' });
  await expect(form).toHaveAttribute('action', site.route('search/'));
  await expect(form).toHaveAttribute('method', 'get');
  const input = page.getByRole('searchbox', { name: 'נו, מה מחפשים?' });
  await expect(input).toHaveAccessibleDescription(/החיפוש מבין עברית/u);
  await input.fill('פיפוש');
  await page.getByRole('button', { name: 'חיפוש' }).click();
  await expect(page.getByRole('link', { name: 'פתיחת אוסף — פיפוש 1' })).toBeVisible();

  await page.getByLabel('איזה מדף').selectOption('פתרונות');
  await expect(page.getByText(solution.name, { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: `צפייה — ${solution.name}` }),
  ).toHaveAttribute('href', solution.viewUrl);
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
  await page.route(searchIndexPattern, async (route) => {
    markRequested();
    await requestRelease;
    await route.continue();
  });

  await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201'));
  await requestStarted;
  const input = page.getByRole('searchbox', { name: 'נו, מה מחפשים?' });
  const category = page.getByLabel('איזה מדף');
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
    await page.goto(site.route('search/'));
    const root = page.locator('[data-search-root]');
    await expect(root).toHaveAttribute('aria-busy', 'false');
    await expect(root.locator('[data-search-status]')).toContainText('כתבו משהו בעברית');
    await expect(root.locator('[data-search-status]')).not.toContainText('טוענים');
    await expect(page.getByRole('searchbox', { name: 'נו, מה מחפשים?' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'חיפוש' })).toBeEnabled();
    await expect(root.getByRole('link', { name: 'כל הארכיון' })).toBeVisible();
    await expect(page.getByRole('search', { name: 'חיפוש בארכיון' })).toHaveAttribute(
      'action',
      site.route('search/'),
    );
  } finally {
    await context.close();
  }
});

for (const failure of ['aborted', 'non-OK', 'corrupt'] as const) {
  test(`search ${failure} index failure keeps an explicit browse fallback`, async ({ page }) => {
    await page.route(searchIndexPattern, async (route) => {
      if (failure === 'aborted') {
        await route.abort();
      } else if (failure === 'non-OK') {
        await route.fulfill({ status: 503, body: 'unavailable' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{broken' });
      }
    });
    await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9'));

    await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toBeVisible();
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toHaveAttribute('href', site.route('archive/'));
    await expect(page.locator('[data-search-results] > li')).toHaveCount(0);
    await expect(page.locator('[data-search-root]')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('searchbox', { name: 'נו, מה מחפשים?' })).toBeEnabled();
    await expect(page.getByLabel('איזה מדף')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'חיפוש' })).toBeEnabled();
  });
}

test('unexpected stored search metadata fails safely without unsafe result links', async ({ page }) => {
  await useSearchIndex(page, [
    searchFileDocument('safe-security-result', 'בדיקת אבטחה'),
    searchFileDocument('unsafe-security-result', 'בדיקת אבטחה', {
      href: 'javascript:alert(1)',
      viewUrl: 'data:text/html,unsafe',
      downloadUrl: '//unsafe.example/file',
    }),
  ]);
  await page.goto(site.route('search/?q=%D7%91%D7%93%D7%99%D7%A7%D7%AA%20%D7%90%D7%91%D7%98%D7%97%D7%94'));

  await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
  await expect(page.locator('[data-search-results] > li')).toHaveCount(0);
  await expect(
    page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
  ).toBeVisible();
  await expect(page.locator('[data-search-root] a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('[data-search-root] a[href^="data:"]')).toHaveCount(0);
  await expect(page.locator('[data-search-root] a[href^="//"]')).toHaveCount(0);
});

for (const corruption of ['file without view URL', 'file disguised as collection'] as const) {
  test(`search rejects ${corruption} without partial results`, async ({ page }) => {
    const malformed =
      corruption === 'file without view URL'
        ? searchFileDocument('malformed-result', 'בדיקת תקלה', { viewUrl: null })
        : searchFileDocument('malformed-result', 'בדיקת תקלה', {
            kind: 'collection',
            titleHe: 'בדיקת תקלה',
            href: '/release/piposh-1/',
          });
    await useSearchIndex(page, [
      searchFileDocument('safe-result', 'בדיקת תקלה'),
      malformed,
    ]);

    await page.goto(site.route('search/?q=%D7%91%D7%93%D7%99%D7%A7%D7%AA%20%D7%AA%D7%A7%D7%9C%D7%94'));
    await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
    await expect(page.locator('[data-search-results] > li')).toHaveCount(0);
    await expect(
      page.locator('[data-search-root]').getByRole('link', { name: 'כל הארכיון' }),
    ).toBeVisible();
  });
}

test('search result actions expose exact metadata and safe Drive links', async ({ page }) => {
  await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201'));

  const englishResult = page
    .locator('[data-search-results] > li')
    .filter({ hasText: 'piposh1-english.exe' });
  await expect(englishResult.locator('.result-heading bdi')).toHaveText('piposh1-english.exe');
  await expect(englishResult).toContainText('משחקים מלאים');
  await expect(englishResult).toContainText('application/x-msdownload');
  await expect(englishResult).toContainText('משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe');
  for (const actionName of [
    'צפייה — piposh1-english.exe',
    'הורדה — piposh1-english.exe',
  ]) {
    const action = englishResult.getByRole('link', { name: actionName });
    await expect(action).toHaveAttribute('href', /^https:\/\/drive\.google\.com\//u);
    await expect(action).toHaveAttribute('target', '_blank');
    await expect(action).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(
    page.getByRole('link', { name: 'פתיחת אוסף — פיפוש 1' }),
  ).toHaveAttribute('href', storedCollectionHref('פיפוש 1'));
});

test('search has honest empty, singular, and plural count wording', async ({ page }) => {
  await useSearchIndex(page, [
    searchFileDocument('single-solution', 'בודד', { category: 'פתרונות' }),
    searchFileDocument('single-game', 'בודד', { category: 'משחקים מלאים' }),
    searchFileDocument('plural-one', 'רבים'),
    searchFileDocument('plural-two', 'רבים'),
  ]);
  await page.goto(site.route('search/?q=%D7%A7%D7%A9%D7%A7%D7%95%D7%A9'));
  await expect(page.locator('[data-search-status]')).toHaveText('לא מצאנו כלום! חיפשנו, קיבינימאט, באמת חיפשנו.');

  await page.goto(site.route('search/?q=%D7%91%D7%95%D7%93%D7%93'));
  await expect(page.locator('[data-search-status]')).toHaveText('2 תוצאות');
  await page.getByLabel('איזה מדף').selectOption('פתרונות');
  await expect(page.locator('[data-search-status]')).toHaveText('תוצאה אחת');

  await page.goto(site.route('search/?q=%D7%A8%D7%91%D7%99%D7%9D'));
  await expect(page.locator('[data-search-status]')).toHaveText('2 תוצאות');
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
  await useSearchIndex(page, documents);

  await page.goto(site.route('search/?q=%D7%90%D7%95%D7%A6%D7%A8'));
  await expect(page.locator('[data-search-status]')).toHaveText(
    '101 תוצאות. מוצגות רק 100 התוצאות הראשונות.',
  );
  await expect(page.locator('[data-search-results] > li')).toHaveCount(100);
});

test('search page is accessible and stays within a 320px viewport', async ({ page }, testInfo) => {
  await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201'));
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

test('pages carry their stylesheet inline so a stale page can never lose its styling', async ({
  page,
}) => {
  /* GitHub Pages serves HTML with max-age=600 and cannot be configured. A hashed
     stylesheet is renamed and deleted by any deploy that touches CSS, so cached
     HTML asked for a file that was gone, got a 404, and rendered the site
     completely unstyled until a manual refresh. Reported in the wild.
     Inlined, stale HTML carries stale CSS instead of none. */
  for (const route of ['', 'listen/', 'watch/', 'browse/type/audio-cd/', 'release/piposh-1/']) {
    await page.goto(site.route(route));

    const localSheets = page.locator('link[rel="stylesheet"][href^="/guillotine-archive"]');
    await expect(localSheets, `${route || 'home'} links no hashed stylesheet`).toHaveCount(0);

    const inlined = await page
      .locator('style')
      .evaluateAll((nodes) => nodes.reduce((total, node) => total + (node.textContent ?? '').length, 0));
    expect(inlined, `${route || 'home'} carries inline CSS`).toBeGreaterThan(5000);

    /* Proof it is actually applied, not merely present. */
    await expect(page.locator('body')).toHaveCSS('margin', '0px');
  }
});
