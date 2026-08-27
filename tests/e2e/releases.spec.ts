import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { deriveKind } from '../../src/catalog/kind';
import {
  creditedWorks,
  releaseItems,
  releaseSections,
  SECTION_ITEM_CAP,
  sharedMirrorCategory,
} from '../../src/components/release-view';
import { hasThumbs } from '../../src/components/derivative';
import { itemById, loadCatalog } from '../../src/lib/catalog';
import { categorySlug } from '../../src/lib/url';
import { playwrightRuntime } from '../support/playwright-runtime';

const expectedCatalog = loadCatalog('src/generated/catalog.json', false);
const { site } = playwrightRuntime;

function release(slug: string) {
  const found = expectedCatalog.releases.find((candidate) => candidate.slug === slug);
  if (!found) throw new Error(`generated catalog is missing release ${slug}`);
  return found;
}

test('one room template serves a game, an audio disc and a fan disc', async ({ page }) => {
  // The same page shape has to fit releases with completely different contents, which is only
  // true if an empty section is absent rather than rendered empty.
  const expectations = [
    { slug: 'piposh-1', present: ['גרסאות להורדה', 'סריקות ותמונות', 'מסמכים'], absent: ['מוזיקה'] },
    { slug: 'hatbara-shel-piposh', present: ['מוזיקה'], absent: ['גרסאות להורדה', 'סריקות ותמונות', 'מסמכים'] },
    { slug: 'fan-disc-b038d0c7', present: ['מסמכים'], absent: ['גרסאות להורדה', 'סריקות ותמונות', 'מוזיקה'] },
    {
      slug: 'fan-disc-69541b3e',
      present: ['גרסאות להורדה', 'סריקות ותמונות', 'סרטונים', 'מוזיקה', 'מסמכים'],
      absent: [],
    },
  ] as const;

  for (const { slug, present, absent } of expectations) {
    const current = release(slug);
    const sections = releaseSections(releaseItems(current, itemById));
    expect(
      sections.map(({ headingHe }) => headingHe),
      `${slug} sections in the catalog`,
    ).toEqual([...present]);

    await page.goto(site.route(`release/${slug}/`));
    await expect(page.getByRole('heading', { level: 1, name: current.titleHe })).toBeVisible();
    for (const heading of present) {
      await expect(page.getByRole('heading', { name: heading }), `${slug} has ${heading}`).toBeVisible();
    }
    for (const heading of absent) {
      await expect(
        page.getByRole('heading', { name: heading }),
        `${slug} omits the empty ${heading}`,
      ).toHaveCount(0);
    }
    // כל הקבצים is always last and always collapsed.
    const allFiles = page.locator('details.all-files');
    await expect(allFiles).toHaveCount(1);
    expect(await allFiles.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false);
  }
});

test('a room caps each section and sends the rest to the paginated Drive mirror', async ({ page }) => {
  const congress = release('fan-disc-69541b3e');
  const sections = releaseSections(releaseItems(congress, itemById));
  const capped = sections.filter(({ hiddenCount }) => hiddenCount > 0);
  expect(capped.length).toBeGreaterThan(0);

  await page.goto(site.route(`release/${congress.slug}/`));

  for (const section of sections) {
    /* A section shows artwork tiles once its items have thumbnails and plain rows
       before that, so the selector follows the derivatives rather than assuming
       either state. Both render one element per item. */
    const container = hasThumbs(section.items) && section.id === 'gallery'
      ? '.media-gallery > li'
      : '.item-rows > li';
    const entries = page.locator(
      `section:has(h2:text-is("${section.headingHe}")) ${container}`,
    );
    await expect(entries, `${section.headingHe} entries`).toHaveCount(section.items.length);
    expect(section.items.length).toBeLessThanOrEqual(SECTION_ITEM_CAP);
  }
  for (const section of capped) {
    await expect(
      page.locator(`section:has(h2:text-is("${section.headingHe}")) .room-more`),
    ).toContainText(String(section.hiddenCount));
  }
  // Every "see the rest" link must point at a shelf that actually holds those files. Six
  // releases are filed across two or three shelves, so one link per room would be a lie.
  for (const section of capped) {
    const category = sharedMirrorCategory(section.items);
    expect(category, `${section.headingHe} shares one shelf`).not.toBeNull();
    await expect(
      page.locator(`section:has(h2:text-is("${section.headingHe}")) .room-more a`),
    ).toHaveAttribute('href', site.route(`archive/${categorySlug(category!)}/`));
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('the congress disc credits the people who made its fan games', async ({ page }) => {
  const congress = release('fan-disc-69541b3e');
  const credits = creditedWorks(releaseItems(congress, itemById));
  expect(credits).toHaveLength(19);

  await page.goto(site.route(`release/${congress.slug}/`));

  await expect(page.getByRole('heading', { name: 'מי עשה את זה' })).toBeVisible();
  await expect(page.locator('.credit-list > li')).toHaveCount(credits.length);
  await expect(page.locator('.credit-list')).toContainText('אופיר אלמקיאס');
  await expect(page.getByText('קרבות של חזי נגד כולם כמו בכל בוקר בפיפוש.zip')).toBeVisible();
});

test('extracted Hebrew document text is rendered on the page, not only indexed', async ({ page }) => {
  const letters = release('fan-disc-b038d0c7');
  const documents = releaseItems(letters, itemById).filter((item) =>
    (item.extractedTextHe ?? '').trim().length > 0,
  );
  expect(documents).toHaveLength(6);
  const first = documents[0]!;

  await page.goto(site.route(`release/${letters.slug}/`));

  const body = page.locator('.item-text > p').first();
  await expect(body).toBeVisible();
  await expect(body).toContainText(first.extractedTextHe!.trim().slice(0, 40));
  await expect(page.locator('.item-source').first()).toContainText(first.path);
});

test('a release without a cover gets a designed placeholder, not a broken frame', async ({ page }) => {
  const revolution = release('piposh-revolution');
  expect(revolution.coverFileId).toBeUndefined();

  await page.goto(site.route(`release/${revolution.slug}/`));

  const placeholder = page.locator('.room-cover > .release-placeholder');
  await expect(placeholder).toHaveCount(1);
  await expect(page.locator('.room-cover img')).toHaveCount(0);
  // The mat stays dark in both themes so a missing scan never becomes a white box.
  await expect(page.locator('.room-cover')).toHaveCSS('background-color', 'rgb(7, 9, 7)');
  const painted = await placeholder.evaluate((element) => ({
    // The shared .dither utility paints the texture on the element itself.
    dither: getComputedStyle(element).backgroundImage.includes('conic-gradient'),
    // The release accent tints one corner from ::after, so it never sits under the title.
    accentTint: getComputedStyle(element, '::after').backgroundImage.includes('radial-gradient'),
  }));
  expect(painted).toEqual({ dither: true, accentTint: true });
});

test('the facet grid narrows the release list on real pre-rendered pages', async ({ page }) => {
  const games = expectedCatalog.releases.filter(({ type }) => type === 'game');
  expect(games).toHaveLength(6);

  await page.goto(site.route());
  const tabs = page.getByRole('navigation', { name: 'מדורי הארכיון' });

  /* On the home page the games tab is the current one, and it points home rather
     than to a filter page, because home already is the games. */
  const gamesTab = tabs.getByRole('link', { name: /המשחקים/u });
  await expect(gamesTab).toHaveAttribute('aria-current', 'page');
  await expect(gamesTab).toContainText(String(games.length));

  /* Every other section is one real pre-rendered page behind its own tab. */
  const musicTab = tabs.locator(`a[href="${site.route('browse/type/audio-cd/')}"]`);
  await expect(musicTab).toHaveCount(1);
  const audioDiscs = expectedCatalog.releases.filter(({ type }) => type === 'audio-cd');
  await expect(musicTab).toContainText(String(audioDiscs.length));
  await musicTab.click();

  await expect(page).toHaveURL(site.url('browse/type/audio-cd/'));
  await expect(page.getByTestId('release-tile')).toHaveCount(audioDiscs.length);
  for (const disc of audioDiscs) {
    await expect(page.locator(`[data-release="${disc.slug}"]`)).toHaveCount(1);
  }
  await expect(
    page
      .getByRole('navigation', { name: 'מדורי הארכיון' })
      .locator(`a[href="${site.route('browse/type/audio-cd/')}"]`),
  ).toHaveAttribute('aria-current', 'page');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // A subject facet gathers every release about one game, whatever its type.
  const aboutPiposhOne = expectedCatalog.releases.filter(
    ({ subjectSlug }) => subjectSlug === 'piposh-1',
  );
  expect(aboutPiposhOne.length).toBeGreaterThan(1);
  await page.goto(site.route('browse/subject/piposh-1/'));
  await expect(page.getByTestId('release-tile')).toHaveCount(aboutPiposhOne.length);
});

test('listen and watch list the real material and say what cannot play', async ({ page }) => {
  const tracks = expectedCatalog.items.filter(({ kind }) => kind === 'track');
  const videos = expectedCatalog.items.filter(({ kind }) => kind === 'video');
  expect(tracks).toHaveLength(169);
  expect(videos).toHaveLength(31);

  /* A player appears exactly where a hosted rendition exists, and never
     otherwise: no element may claim to play a file the site cannot serve. */
  const playableTracks = tracks.filter(({ derivatives }) => derivatives?.audio !== undefined);

  await page.goto(site.route('listen/'));
  await expect(page.getByRole('heading', { level: 1, name: 'מוזיקה' })).toBeVisible();
  await expect(page.locator('.item-rows > li')).toHaveCount(tracks.length);
  await expect(page.locator('audio')).toHaveCount(playableTracks.length);
  for (const source of await page.locator('audio').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLAudioElement).getAttribute('src') ?? ''),
  )) {
    expect(source, 'every player points at a hosted rendition').toContain(
      'generated/derivatives/',
    );
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.goto(site.route('watch/'));
  await expect(page.getByRole('heading', { level: 1, name: 'סרטונים' })).toBeVisible();
  await expect(page.locator('.item-rows > li')).toHaveCount(videos.length);
  /* We host a poster and a duration, never the video: 6.4 GB, and 27 of 31 are
     formats no browser decodes whatever we convert to. */
  await expect(page.locator('video')).toHaveCount(0);
  const posters = videos.filter(({ derivatives }) => derivatives?.poster !== undefined);
  await expect(page.locator('.item-poster img')).toHaveCount(posters.length);
  // The one warning on the site: formats no browser will ever play.
  const warning = page.locator('.warn-note');
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText('27');
  await expect(warning).toContainText('WMV');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('search narrows by file kind without a stored kind field', async ({ page }) => {
  await page.goto(site.route('search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9'));

  const status = page.locator('[data-search-status]');
  await expect(status).toContainText('תוצאות');
  const unfiltered = page.locator('[data-search-results] > li');
  const unfilteredCount = await unfiltered.count();
  expect(unfilteredCount).toBeGreaterThan(0);

  await page.getByLabel('סוג קובץ').selectOption('build');
  await expect(page.locator('[data-search-results] > li')).not.toHaveCount(unfilteredCount);
  const kinds = await page
    .locator('[data-search-results] > li')
    .evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
  expect(kinds.length).toBeGreaterThan(0);
  for (const row of kinds) expect(row).not.toContain('image/');

  // The filter is part of the shareable URL, like the category filter beside it.
  await expect(page).toHaveURL(/kind=build/u);
});

test('the browser derives the same item kind the catalog stored', async () => {
  // The search kind filter re-runs deriveKind on the fields the index stores, because the
  // index has no kind of its own. That is only sound while the derivation still agrees.
  for (const item of expectedCatalog.items) {
    expect(
      deriveKind({
        mimeType: item.mimeType,
        path: item.path,
        size: item.size,
        name: item.name,
      }),
      item.path,
    ).toBe(item.kind);
  }
});
