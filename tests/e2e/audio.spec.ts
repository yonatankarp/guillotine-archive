import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loadCatalog } from '../../src/lib/catalog';
import { releaseCoverPath } from '../../src/components/release-view';
import { playwrightRuntime } from '../support/playwright-runtime';

const expectedCatalog = loadCatalog('src/generated/catalog.json', false);
const { site } = playwrightRuntime;

/** A row gets a player exactly where the pipeline produced a rendition, and never otherwise. */
const playableTracks = expectedCatalog.items.filter(
  (item) => item.kind === 'track' && item.derivatives?.audio !== undefined,
);

const tracksByRelease = new Map<string, number>();
for (const track of playableTracks) {
  tracksByRelease.set(track.releaseSlug, (tracksByRelease.get(track.releaseSlug) ?? 0) + 1);
}

const counts = [...tracksByRelease.values()];
/* An album of two or more earns one player for the lot. A release holding a single track is
   already a player for the whole album, so it keeps the plain row it always had. */
const albumsWithPlayer = counts.filter((size) => size > 1);
const lonePlayers = counts.filter((size) => size === 1);

/* The listening page orders its albums by size, so the biggest is the first one on the page.
   Its rows are every track of that release; its playlist is the rows that can play. */
const albumOrder = [...tracksByRelease]
  .filter(([, size]) => size > 1)
  .sort(([, left], [, right]) => right - left)
  .map(([slug]) => slug);
const biggestSlug = albumOrder[0]!;
const biggestRows = expectedCatalog.items.filter(
  (item) => item.kind === 'track' && item.releaseSlug === biggestSlug,
).length;
const biggestPlaylist = tracksByRelease.get(biggestSlug)!;

/* Five of the 42 releases were ever scanned, so the panel meets a release with no cover far
   more often than one with a cover, and both have to be on the page to be checked. */
const coveredSlugs = new Set(
  expectedCatalog.releases.filter(releaseCoverPath).map((release) => release.slug),
);

function album(page: Page, index = 0) {
  return page.locator('.album').nth(index);
}

/** The panel's own controls, which exist only once the script has run. */
function panel(page: Page, index = 0) {
  const scope = album(page, index);
  return {
    audio: scope.locator('[data-album-audio]'),
    seek: scope.locator('[data-album-seek]'),
    elapsed: scope.locator('[data-album-elapsed]'),
    total: scope.locator('[data-album-total]'),
    toggle: scope.locator('[data-album-toggle]'),
    previous: scope.locator('[data-album-prev]'),
    next: scope.locator('[data-album-next]'),
    tracks: scope.locator('.track-play'),
  };
}

const isPaused = (page: Page, index = 0) =>
  panel(page, index)
    .audio.first()
    .evaluate((node: HTMLAudioElement) => node.paused);

/**
 * Hangs up every stream this file opened.
 *
 * Pausing an <audio> does not close its connection, and this is the only spec on the site that
 * fetches media at all, so without this a run leaves buffering Opus streams open behind every
 * test that pressed play. Hygiene rather than a fix for anything: it was added while chasing a
 * timeout in another spec, and it did not change that timeout. Guarded because the no-JS
 * context cannot evaluate anything.
 */
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => {
      for (const media of document.querySelectorAll('audio')) {
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
    })
    .catch(() => undefined);
});

test.describe('with the script switched off', () => {
  test.use({ javaScriptEnabled: false });

  test('every track still plays on its own', async ({ page }) => {
    /* The reason the players are server-rendered at all. The upgrade takes them away, so this
       is the only proof that what it takes away was ever there. */
    await page.goto(site.route('listen/'));

    /* The rows only. The panel's own player is on the page too, but it is hidden, carries no
       controls and has no source until the script cues it, so it is not part of what a
       visitor without the script can play. */
    await expect(page.locator('.item-rows audio[controls]')).toHaveCount(playableTracks.length);
    for (const source of await page.locator('.item-rows audio').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('src') ?? ''),
    )) {
      expect(source, 'every player points at a hosted rendition').toContain(
        'generated/derivatives/',
      );
    }

    /* The script-only layer ships in the HTML, so it has to be inert rather than merely
       unstyled: none of it may reach the page, the accessibility tree or the tab order. The
       seek bar is the part with a scoped `display` of its own, and a scoped rule ties with
       [hidden] and wins on source order — which is exactly what this catches. */
    await expect(page.locator('.album-player')).toHaveCount(albumsWithPlayer.length);
    await expect(page.locator('.album-player:visible')).toHaveCount(0);
    /* Both halves matter: the bar has to be in the served HTML, and it has to be invisible.
       Counting only what is visible would pass just as well on a page that lost the bar. */
    await expect(page.locator('.album-player input[type="range"]')).toHaveCount(
      albumsWithPlayer.length,
    );
    await expect(page.locator('.album-player input[type="range"]:visible')).toHaveCount(0);
    await expect(page.locator('.player-transport button:visible')).toHaveCount(0);
    await expect(page.locator('.track-play:visible')).toHaveCount(0);
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /נגן/u })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveCount(0);

    /* The tracklist is served OUTSIDE the panel and stays there. The upgrade is what moves it
       in, so with the script off the list is exactly where it always was — inside the hidden
       panel it would be a tracklist nobody can see. */
    await expect(page.locator('.album > ul.item-rows')).toHaveCount(
      await page.locator('.album').count(),
    );
    await expect(page.locator('.album-player ul.item-rows')).toHaveCount(0);
    await expect(page.locator('[data-album-queue]:visible')).toHaveCount(0);
    await expect(page.locator('.player-list-note:visible')).toHaveCount(0);

    /* The numbering is the disc's, not the script's: a tracklist is numbered either way. */
    await expect(album(page).locator('.track-number')).toHaveCount(biggestRows);
    await expect(album(page).locator('.track-number').first()).toHaveText('01');
  });
});

test('an album is upgraded to one designed player and a playlist', async ({ page }) => {
  await page.goto(site.route('listen/'));

  /* One player per album that has more than one track, plus the lone tracks that were left
     as they were: the per-row players are gone, not hidden. */
  await expect(page.locator('audio')).toHaveCount(albumsWithPlayer.length + lonePlayers.length);
  await expect(page.locator('.item-rows audio')).toHaveCount(lonePlayers.length);

  const first = album(page);
  const controls = panel(page);
  await expect(first.locator('.album-player')).toBeVisible();
  await expect(controls.audio).toHaveCount(1);
  await expect(first.locator('.item-rows > li')).toHaveCount(biggestRows);

  /* The browser's own control is gone: the panel around it is the control now. */
  await expect(controls.audio).toHaveJSProperty('controls', false);
  await expect(controls.toggle).toBeVisible();
  await expect(controls.previous).toBeVisible();
  await expect(controls.next).toBeVisible();
  await expect(controls.seek).toBeVisible();

  /* The point of the whole panel: the tracklist is INSIDE it, not a second list underneath.
     One list, the one the server rendered, moved in — so there is no copy of it left outside
     and every row kept the links and the number it was served with. */
  await expect(first.locator('.album-player [data-album-queue] > ul.item-rows')).toHaveCount(1);
  await expect(page.locator('[data-album-queue] > ul.item-rows')).toHaveCount(
    albumsWithPlayer.length,
  );
  /* Nothing is left behind: the only lists still hanging under an .album are the releases
     holding a single track, which never got a panel to move into. */
  await expect(page.locator('.album > ul.item-rows')).toHaveCount(lonePlayers.length);
  await expect(first.locator('.album-player .item-rows > li')).toHaveCount(biggestRows);
  await expect(
    first.locator('.album-player .item-rows > li').first().locator('.file-action'),
    'a row inside the playlist still opens and still downloads the file',
  ).toHaveCount(2);

  /* The list is still a list, and each track is still one row of it. */
  await expect(controls.tracks).toHaveCount(biggestPlaylist);
  await expect(controls.tracks.first()).toBeVisible();
  await expect(first.getByRole('list')).toHaveCount(1);
  await expect(first.getByRole('listitem')).toHaveCount(biggestRows);

  await expect(controls.audio).toHaveJSProperty('preload', 'none');
  await expect(controls.audio).toHaveAttribute('src', /generated\/derivatives\//u);
  await expect(controls.tracks.first()).toHaveAttribute('aria-current', 'true');
  await expect(first.locator('[data-album-now-name]')).toHaveText(
    (await controls.tracks.first().getAttribute('data-track')) ?? '',
  );
  /* Cued is not playing, and the panel says the cued thing until a track actually starts. */
  await expect(first.locator('[data-album-now-label]')).toHaveText('מוכן לנגן:');
  await expect(controls.toggle).toHaveAttribute('aria-label', 'נגן');
  /* Nothing has been loaded, so nothing knows how long it is, and the bar says so rather
     than offering a position inside a length it does not have. */
  await expect(controls.total).toHaveText('--:--');
  await expect(controls.elapsed).toHaveText('0:00');
  await expect(controls.seek).toHaveAttribute('aria-disabled', 'true');
  /* The album starts at its first track, so there is nothing behind it. */
  await expect(controls.previous).toHaveAttribute('aria-disabled', 'true');
  await expect(controls.next).toHaveAttribute('aria-disabled', 'false');
});

test('a long playlist scrolls inside the player instead of stretching it', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const first = album(page);
  const queue = first.locator('[data-album-queue]');
  await expect(first.locator('.album-player')).toBeVisible();

  /* The biggest release here is 47 rows deep and the listening page carries 169. A list that
     long has to run inside its own scrollport, or the player stops being a player. */
  expect(biggestRows).toBeGreaterThan(20);
  const box = await queue.evaluate((node) => ({
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
    playerHeight: node.closest('.album-player')!.getBoundingClientRect().height,
  }));
  expect(box.scrollHeight, 'the playlist is taller than the window it runs in').toBeGreaterThan(
    box.clientHeight,
  );
  expect(box.playerHeight, 'and the player is a card, not a page').toBeLessThan(900);

  /* The playlist opens at the top of the album, with nothing scrolled yet. */
  expect(await queue.evaluate((node) => node.scrollTop)).toBe(0);
});

/**
 * Where the album is has to stay visible on its own. Measured rather than asserted through the
 * call that does it: scrollIntoView is easy to call and easy to have no effect, and the page
 * moving instead of the playlist is a real failure that looks identical in the source.
 */
test('the playlist follows the playing track, and only the playlist moves', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const first = album(page);
  const queue = first.locator('[data-album-queue]');
  const controls = panel(page);
  await expect(first.locator('.album-player')).toBeVisible();

  /** The playlist's own scroll, and where the current row sits inside its window. */
  const followed = () =>
    queue.evaluate((node) => {
      const row = node.querySelector('li:has(.track-play[aria-current="true"])');
      const window_ = node.getBoundingClientRect();
      const here = row?.getBoundingClientRect();
      return {
        scrolled: node.scrollTop,
        inside:
          here !== undefined && here.top >= window_.top - 1 && here.bottom <= window_.bottom + 1,
      };
    });

  /* Compared across one action at a time rather than against a single baseline: Playwright
     scrolls a control into view before it clicks it, so only the change either side of a track
     change says anything about what the player itself moved. */
  const pageAt = () => page.evaluate(() => Math.round(window.scrollY));

  expect((await followed()).scrolled, 'the album opens at its first track').toBe(0);

  /* One: the album moving on by itself, the change no control made. Twelve tracks is far
     enough down that a playlist which does not follow leaves the track off-screen. Dispatched
     rather than clicked, so nothing but the player can move anything. */
  await controls.tracks.first().click();
  const restingPage = await pageAt();
  for (let step = 0; step < 12; step += 1) {
    await controls.audio.evaluate((node) => node.dispatchEvent(new Event('ended')));
  }
  await expect(controls.tracks.nth(12)).toHaveAttribute('aria-current', 'true');
  const advanced = await followed();
  expect(advanced.scrolled, 'the playlist scrolled down after the album').toBeGreaterThan(0);
  expect(advanced.inside, 'and the track that took over is in the window').toBe(true);
  /* The page is the thing that must NOT move. Six players sit down this one, and pulling the
     document out from under a reader is worse than losing sight of a row. */
  expect(await pageAt(), 'the document stayed where the reader left it').toBe(restingPage);

  /* Two: the transport, which has to carry the playlist the same way in both directions. */
  await controls.audio.evaluate((node: HTMLAudioElement) => node.pause());
  for (let press = 0; press < 6; press += 1) await controls.next.click();
  await expect(controls.tracks.nth(18)).toHaveAttribute('aria-current', 'true');
  const stepped = await followed();
  expect(stepped.scrolled, 'next carried the playlist with it').toBeGreaterThan(advanced.scrolled);
  expect(stepped.inside).toBe(true);

  for (let press = 0; press < 12; press += 1) await controls.previous.click();
  await expect(controls.tracks.nth(6)).toHaveAttribute('aria-current', 'true');
  const back = await followed();
  expect(back.scrolled, 'previous scrolled the playlist back up').toBeLessThan(stepped.scrolled);
  expect(back.inside).toBe(true);

  /* Three: a row picked from the keyboard, the one selection that can land on a track scrolled
     out of the window — a mouse press is already looking at the row it hits. */
  await controls.tracks.nth(11).focus();
  const focusedPage = await pageAt();
  await page.keyboard.press('Enter');
  await expect(controls.tracks.nth(11)).toHaveAttribute('aria-current', 'true');
  const picked = await followed();
  expect(picked.inside, 'the picked track is fully in the window').toBe(true);
  expect(await pageAt()).toBe(focusedPage);

  /* And nobody is yanked back over a track already on screen: track 11 came to rest at the
     bottom of the window, so the one above it is in view and stepping back moves nothing. */
  await controls.previous.click();
  await expect(controls.tracks.nth(10)).toHaveAttribute('aria-current', 'true');
  expect(
    (await followed()).scrolled,
    'a track already in the window scrolls nothing',
  ).toBe(picked.scrolled);
});

test('every album gets art, and one with no scan gets the filed placeholder', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const panels = page.locator('.album-player');
  await expect(panels).toHaveCount(albumsWithPlayer.length);
  expect(albumOrder.some((slug) => !coveredSlugs.has(slug)), 'a coverless album is on the page').toBe(
    true,
  );

  for (const [index, slug] of albumOrder.entries()) {
    const art = panels.nth(index).locator('.player-art');
    const covered = coveredSlugs.has(slug);
    await expect(art.locator('img'), slug).toHaveCount(covered ? 1 : 0);
    /* The dither the whole site uses for a release nobody ever scanned, and it is decoration:
       the page already says the release name in its own heading. */
    await expect(art.locator('.release-placeholder.dither'), slug).toHaveCount(covered ? 0 : 1);
    if (!covered) {
      await expect(art.locator('.release-placeholder')).toHaveAttribute('aria-hidden', 'true');
    }
  }
});

test('cueing an album fetches nothing', async ({ page }) => {
  /* The page carries 169 rows and hands six album players a source at load. Setting a source
     on preload="none" must stay free, or the listening page starts costing megabytes to open. */
  const fetched: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/generated/derivatives/')) fetched.push(request.url());
  });

  await page.goto(site.route('listen/'));
  await expect(album(page).locator('.album-player')).toBeVisible();
  await expect(page.locator('[data-album-audio]')).toHaveCount(albumsWithPlayer.length);

  expect(fetched, 'the upgrade cues every album and downloads none of them').toEqual([]);
});

test('a list with no audio is left exactly as it was', async ({ page }) => {
  /* The wrapper goes around every rendered list, including the video ones, and must add
     nothing at all to a list that has nothing to play. */
  await page.goto(site.route('watch/'));

  await expect(page.locator('.album')).not.toHaveCount(0);
  await expect(page.locator('.album-player')).toHaveCount(0);
  await expect(page.locator('.track-play')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('picking a track plays it in the album player and says which one', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const first = album(page);
  const controls = panel(page);
  const third = controls.tracks.nth(2);
  const name = (await third.getAttribute('data-track')) ?? '';

  await third.click();

  await expect(third).toHaveAttribute('aria-current', 'true');
  await expect(first.locator('.track-play[aria-current="true"]')).toHaveCount(1);
  /* The live region names the track, which is how a change with no control behind it —
     the album moving on by itself — reaches a screen reader at all. */
  await expect(first.getByRole('status')).toContainText(name);
  await expect.poll(() => isPaused(page)).toBe(false);
  await expect(first.locator('[data-album-now-label]')).toHaveText('מתנגן עכשיו:');
  await expect(controls.toggle).toHaveAttribute('aria-label', 'עצור');
});

test('the panel plays, pauses and steps through the album', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const controls = panel(page);
  const second = (await controls.tracks.nth(1).getAttribute('data-track')) ?? '';

  await controls.toggle.click();
  await expect.poll(() => isPaused(page), { message: 'the panel started the cued track' }).toBe(
    false,
  );
  await expect(controls.toggle).toHaveAttribute('aria-label', 'עצור');

  await controls.toggle.click();
  await expect.poll(() => isPaused(page), { message: 'the same button stopped it' }).toBe(true);
  await expect(controls.toggle).toHaveAttribute('aria-label', 'נגן');

  /* Stepping keeps the album as it was found: a paused album is cued on, not started. */
  await controls.next.click();
  await expect(controls.tracks.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(album(page).locator('[data-album-now-name]')).toHaveText(second);
  expect(await isPaused(page), 'a paused album stays paused when it is stepped').toBe(true);
  await expect(controls.previous).toHaveAttribute('aria-disabled', 'false');

  await controls.previous.click();
  await expect(controls.tracks.first()).toHaveAttribute('aria-current', 'true');
  /* Nothing sits before the first track, and the control that would go there says so. It is
     marked rather than disabled so it keeps its place in the tab order — losing focus because
     the album reached its end is worse than a control that says it has nothing to do.
     dispatchEvent, not click: Playwright refuses to click an aria-disabled control, which is
     the tooling agreeing about the state. This drives the listener past that refusal to prove
     the guard behind it holds too. */
  await expect(controls.previous).toHaveAttribute('aria-disabled', 'true');
  await controls.previous.dispatchEvent('click');
  await expect(controls.tracks.first()).toHaveAttribute('aria-current', 'true');
  expect(await isPaused(page), 'the album did not start itself at its own edge').toBe(true);
});

test('the bar says where the track is and seeks from the keyboard', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const controls = panel(page);
  await controls.tracks.first().click();

  /* A length is only ever learned from the file itself: the catalog has none for a track. */
  await expect
    .poll(() => controls.seek.getAttribute('aria-disabled'), {
      message: 'the length arrived with the track',
    })
    .toBe('false');
  await expect(controls.total).toHaveText(/^\d+:\d\d$/u);
  expect(Number(await controls.seek.getAttribute('max'))).toBeGreaterThan(0);
  /* And the row keeps what the panel learned, because nothing else was ever going to tell it. */
  await expect(album(page).locator('.item-rows > li').first().locator('[data-track-time]')).toHaveText(
    /^\d+:\d\d$/u,
  );

  await controls.audio.evaluate((node: HTMLAudioElement) => node.pause());
  await controls.seek.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  /* The bar is forced LTR like every other number on the site, so the forward arrow moves
     forward whatever the page direction is. */
  await expect
    .poll(() => controls.audio.evaluate((node: HTMLAudioElement) => node.currentTime))
    .toBeGreaterThan(0);
  /* A slider reading "37" is a slider reading nothing: a position is a time. */
  await expect(controls.seek).toHaveAttribute('aria-valuetext', /^\d+:\d\d מתוך \d+:\d\d$/u);
  await expect(controls.elapsed).toHaveText(/^\d+:\d\d$/u);
});

test('one track plays at a time, across albums', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const players = page.locator('[data-album-audio]');
  expect(await players.count()).toBeGreaterThan(1);

  await panel(page, 0).tracks.first().click();
  await expect.poll(() => isPaused(page, 0)).toBe(false);

  await panel(page, 1).tracks.first().click();
  await expect.poll(() => isPaused(page, 1)).toBe(false);

  const playing = await page.evaluate(
    () => [...document.querySelectorAll('audio')].filter((node) => !node.paused).length,
  );
  expect(playing, 'exactly one player is active').toBe(1);
  await expect.poll(() => isPaused(page, 0)).toBe(true);
});

test('an album plays through', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const first = album(page);
  const controls = panel(page);
  const second = (await controls.tracks.nth(1).getAttribute('data-track')) ?? '';

  await controls.tracks.first().click();
  const played = await controls.audio.getAttribute('src');

  /* A finished track hands over to the next one in the same album, and the playlist says so. */
  await controls.audio.evaluate((node) => node.dispatchEvent(new Event('ended')));

  await expect(controls.audio).not.toHaveAttribute('src', played ?? '');
  await expect(controls.tracks.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(controls.tracks.first()).not.toHaveAttribute('aria-current', 'true');
  await expect(first.getByRole('status')).toContainText(second);
});

test('the player is usable from the keyboard alone', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const controls = panel(page);

  /* The panel first: its three controls are ordinary buttons, so Enter works the transport. */
  await controls.next.focus();
  await page.keyboard.press('Enter');
  await expect(controls.tracks.nth(1)).toHaveAttribute('aria-current', 'true');

  await controls.tracks.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(controls.tracks.nth(1)).toHaveAttribute('aria-current', 'true');

  /* Tabbing forward reaches the next track without passing anything that traps: the rest of
     a row is the two Drive links and nothing else. */
  for (let press = 0; press < 6; press += 1) {
    if (await controls.tracks.nth(2).evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(controls.tracks.nth(2)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(controls.tracks.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(album(page).locator('.track-play[aria-current="true"]')).toHaveCount(1);
});

test('the player is clean for axe and stays inside 320px', async ({ page }) => {
  for (const route of ['listen/', 'release/hatbara-shel-piposh/']) {
    await page.goto(site.route(route));

    /* Analysed with a track current and a length known, because aria-current, the live region
       and the bar's own range only carry anything once the album has been sent somewhere.
       Paused again so the scan is not reading a page mid-playback. */
    const controls = panel(page);
    await controls.tracks.nth(1).click();
    await expect(controls.audio).toHaveAttribute('aria-label', /.+/u);
    await expect.poll(() => controls.seek.getAttribute('aria-disabled')).toBe('false');
    await controls.audio.evaluate((node: HTMLAudioElement) => node.pause());
    expect((await new AxeBuilder({ page }).analyze()).violations, route).toEqual([]);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${route} does not scroll sideways`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );

    /* The playlist has to be measured on its own. overflow-y: auto computes overflow-x to auto
       as well, so a row too wide for the panel would scroll sideways INSIDE the playlist and
       never reach the document — the check above would pass over exactly the region where
       sideways overflow is now most likely. Every playlist on the page, because the longest
       filename in the catalog is 41 characters and it is not in the first album. */
    const inside = await page
      .locator('[data-album-queue]')
      .evaluateAll((nodes) => nodes.map((node) => node.scrollWidth - node.clientWidth));
    expect(Math.max(0, ...inside), `${route} playlist does not scroll sideways either`).toBe(0);
  }
});
