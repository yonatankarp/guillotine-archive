import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { deriveKind } from '../../src/catalog/kind';
import {
  creditedWorks,
  galleryGroups,
  releaseItems,
  releaseSections,
  SECTION_ITEM_CAP,
  sharedMirrorCategory,
} from '../../src/components/release-view';
import type { Release } from '../../src/catalog/types';
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
    { slug: 'piposh-1', present: ['מה שאפשר להוריד ולשחק', 'תמונות שסרקנו', 'מסמכים ושאר נייר'], absent: ['מוזיקה'] },
    { slug: 'hatbara-shel-piposh', present: ['מוזיקה'], absent: ['מה שאפשר להוריד ולשחק', 'תמונות שסרקנו', 'מסמכים ושאר נייר'] },
    { slug: 'fan-disc-b038d0c7', present: ['מסמכים ושאר נייר'], absent: ['מה שאפשר להוריד ולשחק', 'תמונות שסרקנו', 'מוזיקה'] },
    {
      slug: 'fan-disc-69541b3e',
      present: ['מה שאפשר להוריד ולשחק', 'תמונות שסרקנו', 'סרטונים', 'מוזיקה', 'מסמכים ושאר נייר'],
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
    // The full-file-list section is always last and always collapsed.
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
    /* A section shows artwork slides once its items have thumbnails and plain rows
       before that, so the selector follows the derivatives rather than assuming
       either state. Both render one element per item — the gallery splits its slides
       across one viewer per scanned object, and the count is over all of them. */
    const container = hasThumbs(section.items) && section.id === 'gallery'
      ? '.carousel-track > .viewer-slide'
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

/** The viewers a release's scanned section is split into, in render order. */
function galleryOf(current: Release) {
  const section = releaseSections(releaseItems(current, itemById)).find(
    ({ id }) => id === 'gallery',
  );
  return section ? galleryGroups(section.items, current.titleHe) : [];
}

test('a release splits its scans into one viewer per object that was scanned', async ({
  page,
}) => {
  const piposh = release('piposh-1');
  const groups = galleryOf(piposh);
  /* Both booklets are filed as booklet-page, so the kind could never tell an instruction
     book from a lyrics book. The two directories the archive filed them in can. */
  const booklets = groups.filter(({ items }) =>
    items.every(({ kind }) => kind === 'booklet-page'),
  );
  expect(booklets, 'two booklets, filed apart').toHaveLength(2);
  expect(new Set(booklets.map(({ headingHe }) => headingHe)).size, 'distinct names').toBe(2);

  await page.goto(site.route(`release/${piposh.slug}/`));

  const gallery = page.locator('section:has(h2:text-is("תמונות שסרקנו")) .media-gallery');
  await expect(gallery.locator('.carousel-track')).toHaveCount(groups.length);
  for (const group of groups) {
    /* Keyed on the id the grouping derived, not on the heading text: the heading isolates
       its own text in a <bdi>, and a Latin folder name is exactly why. */
    const shelf = gallery.locator(`.gallery-group:has(h3[id="${group.id}"])`);
    await expect(
      shelf.locator('.carousel-track'),
      `${group.headingHe} is one viewer of its own`,
    ).toHaveCount(1);
    await expect(shelf.locator('.carousel-track > .viewer-slide')).toHaveCount(
      group.items.length,
    );
    await expect(page.getByRole('heading', { level: 3, name: group.headingHe })).toBeVisible();
    // A heading sitting under the title פיפוש 1 does not say פיפוש 1 again.
    expect(group.headingHe, 'the heading drops the release name').not.toContain(piposh.titleHe);

    /* One scan at a time: a slide is the whole track, not a tile in a row of them. */
    expect(
      await shelf.locator('.carousel-track').evaluate((element) => {
        const width = element.getBoundingClientRect().width;
        return [...element.children].filter(
          (slide) => Math.abs(slide.getBoundingClientRect().width - width) >= 2,
        ).length;
      }),
      `every scan in ${group.headingHe} fills the viewer`,
    ).toBe(0);
  }

  /* A booklet spread is about twice as wide as it is tall and a box front is taller than
     it is wide. The frames are sized from those numbers, so they cannot all be one ratio —
     which is exactly what made the old covers read as broken. The slides are all one width
     now, so this measures the frame inside the slide, which is where the scan lives. */
  const box = groups.find(({ items }) => items.every(({ kind }) => kind === 'cover'));
  expect(box, 'the box is its own viewer').toBeDefined();
  const frameWidth = async (id: string) => {
    const frame = gallery
      .locator(`.gallery-group:has(h3[id="${id}"]) .viewer-slide .gallery-frame`)
      .first();
    return (await frame.boundingBox())!.width;
  };
  expect(await frameWidth(booklets[0]!.id)).toBeGreaterThan(await frameWidth(box!.id));

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('every scan on show links to the bigger rendition of itself', async ({ page }) => {
  const piposh = release('piposh-1');
  const groups = galleryOf(piposh);

  await page.goto(site.route(`release/${piposh.slug}/`));

  for (const group of groups) {
    const slides = page.locator(
      `.gallery-group:has(h3[id="${group.id}"]) .carousel-track > .viewer-slide`,
    );
    for (const [index, item] of group.items.entries()) {
      /* The displayed picture is the grid-sized rendition and the link under it is the
         full-view one. Pressing the scan has to reach something the page is not already
         showing, so the two must not be the same file. */
      const bigger = item.derivatives?.reader?.path ?? item.derivatives?.view?.path;
      const shown = item.derivatives?.thumb?.path;
      expect(bigger, `${item.name} has a full-view rendition`).toBeDefined();
      expect(shown, `${item.name} has a grid-sized rendition`).toBeDefined();
      expect(bigger, 'the two renditions are different files').not.toBe(shown);

      const shot = slides.nth(index).locator('a.viewer-shot');
      const [href, source] = await Promise.all([
        shot.getAttribute('href'),
        shot.locator('img').getAttribute('src'),
      ]);
      expect(href, `${item.name} opens its full-view rendition`).toContain(bigger!);
      expect(source, `${item.name} is shown at grid size`).toContain(shown!);
    }
  }
});

test('a release filed in one directory gets no heading it does not need', async ({ page }) => {
  const single = expectedCatalog.releases.find((candidate) => galleryOf(candidate).length === 1);
  expect(single, 'a release whose scans came from one object').toBeDefined();
  const [only] = galleryOf(single!);

  await page.goto(site.route(`release/${single!.slug}/`));

  const gallery = page.locator('section:has(h2:text-is("תמונות שסרקנו")) .media-gallery');
  await expect(gallery.locator('.carousel-track')).toHaveCount(1);
  await expect(gallery.locator('.carousel-track > .viewer-slide')).toHaveCount(
    only!.items.length,
  );
  /* One object needs no name of its own: the section heading above already named it. */
  await expect(gallery.locator('h3')).toHaveCount(0);
  await expect(gallery.locator('.carousel-track')).toHaveAttribute('aria-label', /תמונות שסרקנו/u);
});

test('a scan viewer opens on page one and steps with JavaScript off', async ({
  browser,
}, testInfo) => {
  const piposh = release('piposh-1');
  const groups = galleryOf(piposh);
  const widest = groups.reduce((most, group) =>
    group.items.length > most.items.length ? group : most,
  );
  /* A second object on the same page, to prove the two viewers stay two. */
  const other = groups.find(({ id }) => id !== widest.id);
  expect(other, 'a second scanned object in the same room').toBeDefined();

  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: testInfo.project.use.viewport ?? undefined,
  });
  const page = await context.newPage();
  try {
    await page.goto(site.route(`release/${piposh.slug}/`));
    const track = page.locator(
      `.gallery-group:has(h3[id="${widest.id}"]) .carousel-track`,
    );
    await expect(track.locator('> .viewer-slide')).toHaveCount(widest.items.length);

    const resting = await track.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const first = element.firstElementChild!.getBoundingClientRect();
      const second = element.children[1]!.getBoundingClientRect();

      return {
        direction: style.direction,
        overflowX: style.overflowX,
        snaps: style.scrollSnapType,
        /* The booklet is wider than the room it is in, which is the whole point. */
        scrolls: element.scrollWidth > element.clientWidth,
        /* RTL rests at the right edge, where page one of the booklet is. */
        opensOnPageOne: Math.abs(box.right - first.right) < 8,
        /* And page two is to its left, which is where a Hebrew reader turns. */
        pageTwoIsLeftwards: second.right < first.right,
        firstFillsTheTrack: Math.abs(first.width - box.width) < 2,
        pageScrollsSideways:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    expect(resting.direction).toBe('rtl');
    expect(resting.overflowX).toBe('auto');
    expect(resting.snaps).toContain('mandatory');
    expect(resting.scrolls, 'more scans than fit').toBe(true);
    expect(resting.opensOnPageOne, 'RTL opens at the right edge').toBe(true);
    expect(resting.pageTwoIsLeftwards, 'the next scan is to the left in RTL').toBe(true);
    expect(resting.firstFillsTheTrack, 'one scan on screen, at full width').toBe(true);
    expect(resting.pageScrollsSideways, 'the page itself never scrolls sideways').toBe(false);

    /* אחורה is on the right and קדימה on the left, the way a Hebrew reader turns a page. */
    const bar = track.locator('> .viewer-slide').first().locator('.viewer-bar');
    const forward = bar.getByRole('link', { name: /^קדימה/u });
    await expect(forward, 'the first scan has nothing behind it').toHaveCount(1);
    await expect(bar.getByRole('link', { name: /^אחורה/u })).toHaveCount(0);
    const secondBar = track.locator('> .viewer-slide').nth(1).locator('.viewer-bar');
    const back = secondBar.getByRole('link', { name: /^אחורה/u });
    const sides = {
      back: (await back.boundingBox())!.x,
      forward: (await secondBar.getByRole('link', { name: /^קדימה/u }).boundingBox())!.x,
    };
    expect(sides.back, 'אחורה sits to the right of קדימה').toBeGreaterThan(sides.forward);

    /* No script to run a control: קדימה is a link to the next slide, and following it is
       what moves the track. This is the whole no-JS story. */
    await forward.click();
    await expect
      .poll(async () =>
        track.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const first = element.firstElementChild!.getBoundingClientRect();
          const second = element.children[1]!.getBoundingClientRect();

          return {
            moved: Math.abs(element.scrollLeft) > 1,
            secondInView: Math.abs(box.right - second.right) < 8,
            firstGone: first.right > box.right - 1,
          };
        }),
      )
      .toEqual({ moved: true, secondInView: true, firstGone: true });

    /* Nothing touched the other object: two carousels, not one merged strip. */
    const otherTrack = page.locator(`.gallery-group:has(h3[id="${other!.id}"]) .carousel-track`);
    expect(
      await otherTrack.evaluate((element) => element.scrollLeft),
      'the other viewer stayed on its own page one',
    ).toBe(0);

    // And back the way we came.
    await back.click();
    await expect
      .poll(async () =>
        track.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const first = element.firstElementChild!.getBoundingClientRect();

          return {
            returned: Math.abs(element.scrollLeft) < 2,
            firstInView: Math.abs(box.right - first.right) < 8,
            pageScrollsSideways:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        }),
      )
      .toEqual({ returned: true, firstInView: true, pageScrollsSideways: false });

    /* Tabbing still works for the same reason it always did: a focused link is a link the
       browser scrolls into view, and the last scan has its own controls to reach. */
    const last = track.locator('> .viewer-slide:last-child a.viewer-shot');
    await last.focus();
    await expect(last).toBeFocused();
    await expect
      .poll(async () =>
        track.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const slide = element.lastElementChild!.getBoundingClientRect();

          return {
            lastInView: slide.left < box.right && slide.right > box.left,
            pageScrollsSideways:
              document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        }),
      )
      .toEqual({ lastInView: true, pageScrollsSideways: false });
  } finally {
    await context.close();
  }
});

test('the congress disc credits the people who made its fan games', async ({ page }) => {
  const congress = release('fan-disc-69541b3e');
  const credits = creditedWorks(releaseItems(congress, itemById));
  expect(credits).toHaveLength(19);

  await page.goto(site.route(`release/${congress.slug}/`));

  await expect(page.getByRole('heading', { name: 'מי בכלל עשה את זה' })).toBeVisible();
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
  /* One player per album now, not one per row: the script folds each release's rows into a
     single player with a playlist, and a release holding one track keeps its row player.
     Either way that is exactly one <audio> per release that has something to play. */
  const albums = new Set(playableTracks.map(({ releaseSlug }) => releaseSlug));
  await expect(page.locator('audio')).toHaveCount(albums.size);
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
  /* A player appears exactly where a hosted rendition exists, the same rule the tracks
     above follow. Today that is nowhere — 27 of the 31 are formats no browser decodes
     whatever we convert to, and we host a poster and a duration instead of 6.4 GB — so
     this asserts zero players from the data rather than from a hardcoded zero, and starts
     asserting real ones the first time a sync produces a rendition. */
  const playableVideos = videos.filter(({ derivatives }) => derivatives?.video !== undefined);
  await expect(page.locator('video')).toHaveCount(playableVideos.length);
  /* A poster stands in for a video that cannot play, and the row drops it the moment one
     can, so what is on the page is the videos with a still and no rendition — not every
     video with a still. */
  const posters = videos.filter(
    ({ derivatives }) => derivatives?.poster !== undefined && derivatives?.video === undefined,
  );
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

  await page.getByLabel('איזה סוג קובץ').selectOption('build');
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

test('one track plays at a time and an album plays through', async ({ page }) => {
  await page.goto(site.route('listen/'));

  /* One player per album now, and the rows are its playlist: a row's button hands its track
     to the album's single player. */
  const players = page.locator('[data-album-audio]');
  expect(await players.count()).toBeGreaterThan(1);
  const paused = (index: number) =>
    players.nth(index).evaluate((node: HTMLAudioElement) => node.paused);

  /* Two albums, started one after the other. The second must silence the first: nothing on
     the site should ever overlap audio. */
  await page.locator('.album').nth(0).locator('.track-play').first().click();
  await expect.poll(() => paused(0), { message: 'the first album started' }).toBe(false);

  await page.locator('.album').nth(1).locator('.track-play').first().click();
  await expect.poll(() => paused(1), { message: 'the later album kept playing' }).toBe(false);
  await expect.poll(() => paused(0), { message: 'the earlier album stopped' }).toBe(true);

  expect(
    await page.evaluate(
      () => [...document.querySelectorAll('audio')].filter((node) => !node.paused).length,
    ),
    'exactly one player is active',
  ).toBe(1);

  /* When a track ends, the next in the SAME album takes over in that album's own player, the
     playlist says which one, and nothing in a different album is touched. */
  const album = page.locator('.album').nth(0);
  const buttons = album.locator('.track-play');
  await buttons.first().click();
  const started = await players.nth(0).getAttribute('src');

  await players.nth(0).evaluate((node) => node.dispatchEvent(new Event('ended')));

  await expect(players.nth(0), 'the next track took over').not.toHaveAttribute(
    'src',
    started ?? '',
  );
  await expect(buttons.nth(1), 'the playlist marks it').toHaveAttribute('aria-current', 'true');
  await expect.poll(() => paused(1), { message: 'a different album stayed silent' }).toBe(true);
});
