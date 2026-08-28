import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { loadCatalog } from '../../src/lib/catalog';
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
const biggestSlug = [...tracksByRelease].sort(([, left], [, right]) => right - left)[0]![0];
const biggestRows = expectedCatalog.items.filter(
  (item) => item.kind === 'track' && item.releaseSlug === biggestSlug,
).length;
const biggestPlaylist = tracksByRelease.get(biggestSlug)!;

function album(page: Page, index = 0) {
  return page.locator('.album').nth(index);
}

test.describe('with the script switched off', () => {
  test.use({ javaScriptEnabled: false });

  test('every track still plays on its own', async ({ page }) => {
    /* The reason the players are server-rendered at all. The upgrade takes them away, so this
       is the only proof that what it takes away was ever there. */
    await page.goto(site.route('listen/'));

    /* The rows only. The panel's own player is on the page too and also carries `controls`,
       but it is hidden and has no source until the script cues it, so it is not part of what
       a visitor without the script can play. */
    await expect(page.locator('.item-rows audio[controls]')).toHaveCount(playableTracks.length);
    for (const source of await page.locator('.item-rows audio').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('src') ?? ''),
    )) {
      expect(source, 'every player points at a hosted rendition').toContain(
        'generated/derivatives/',
      );
    }

    /* The script-only layer ships in the HTML, so it has to be inert rather than merely
       unstyled: none of it may reach the page, the accessibility tree or the tab order. */
    await expect(page.locator('.album-player')).toHaveCount(albumsWithPlayer.length);
    await expect(page.locator('.album-player:visible')).toHaveCount(0);
    await expect(page.locator('.track-play:visible')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /נגן/u })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveCount(0);
  });
});

test('an album is upgraded to one player and a playlist', async ({ page }) => {
  await page.goto(site.route('listen/'));

  /* One player per album that has more than one track, plus the lone tracks that were left
     as they were: the per-row players are gone, not hidden. */
  await expect(page.locator('audio')).toHaveCount(albumsWithPlayer.length + lonePlayers.length);
  await expect(page.locator('.item-rows audio')).toHaveCount(lonePlayers.length);

  const first = album(page);
  await expect(first.locator('.album-player')).toBeVisible();
  await expect(first.locator('[data-album-audio]')).toHaveCount(1);
  await expect(first.locator('.item-rows > li')).toHaveCount(biggestRows);

  /* The list is still a list, and each track is still one row of it. */
  const buttons = first.locator('.track-play');
  await expect(buttons).toHaveCount(biggestPlaylist);
  await expect(buttons.first()).toBeVisible();
  await expect(first.getByRole('list')).toHaveCount(1);
  await expect(first.getByRole('listitem')).toHaveCount(biggestRows);

  const cued = first.locator('[data-album-audio]');
  await expect(cued).toHaveJSProperty('preload', 'none');
  await expect(cued).toHaveAttribute('src', /generated\/derivatives\//u);
  await expect(buttons.first()).toHaveAttribute('aria-current', 'true');
  await expect(first.locator('[data-album-now-name]')).toHaveText(
    (await buttons.first().getAttribute('data-track')) ?? '',
  );
  /* Cued is not playing, and the panel says the cued thing until a track actually starts. */
  await expect(first.locator('[data-album-now-label]')).toHaveText('מוכן לנגן:');
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
  const player = first.locator('[data-album-audio]');
  const third = first.locator('.track-play').nth(2);
  const name = (await third.getAttribute('data-track')) ?? '';

  await third.click();

  await expect(third).toHaveAttribute('aria-current', 'true');
  await expect(first.locator('.track-play[aria-current="true"]')).toHaveCount(1);
  /* The live region names the track, which is how a change with no control behind it —
     the album moving on by itself — reaches a screen reader at all. */
  await expect(first.getByRole('status')).toContainText(name);
  await expect
    .poll(async () => player.evaluate((node: HTMLAudioElement) => node.paused))
    .toBe(false);
  await expect(first.locator('[data-album-now-label]')).toHaveText('מתנגן עכשיו:');
});

test('one track plays at a time, across albums', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const players = page.locator('[data-album-audio]');
  expect(await players.count()).toBeGreaterThan(1);

  await album(page, 0).locator('.track-play').first().click();
  await expect
    .poll(async () => players.nth(0).evaluate((node: HTMLAudioElement) => node.paused))
    .toBe(false);

  await album(page, 1).locator('.track-play').first().click();
  await expect
    .poll(async () => players.nth(1).evaluate((node: HTMLAudioElement) => node.paused))
    .toBe(false);

  const playing = await page.evaluate(
    () => [...document.querySelectorAll('audio')].filter((node) => !node.paused).length,
  );
  expect(playing, 'exactly one player is active').toBe(1);
  await expect
    .poll(async () => players.nth(0).evaluate((node: HTMLAudioElement) => node.paused))
    .toBe(true);
});

test('an album plays through', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const first = album(page);
  const player = first.locator('[data-album-audio]');
  const buttons = first.locator('.track-play');
  const second = (await buttons.nth(1).getAttribute('data-track')) ?? '';

  await buttons.first().click();
  const played = await player.getAttribute('src');

  /* A finished track hands over to the next one in the same album, and the playlist says so. */
  await player.evaluate((node) => node.dispatchEvent(new Event('ended')));

  await expect(player).not.toHaveAttribute('src', played ?? '');
  await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(buttons.first()).not.toHaveAttribute('aria-current', 'true');
  await expect(first.getByRole('status')).toContainText(second);
});

test('the playlist is usable from the keyboard alone', async ({ page }) => {
  await page.goto(site.route('listen/'));

  const buttons = album(page).locator('.track-play');
  await buttons.nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(buttons.first()).not.toHaveAttribute('aria-current', 'true');

  /* Tabbing forward reaches the next track without passing anything that traps: the rest of
     a row is the two Drive links and nothing else. */
  for (let press = 0; press < 6; press += 1) {
    if (await buttons.nth(2).evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(buttons.nth(2)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(buttons.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(album(page).locator('.track-play[aria-current="true"]')).toHaveCount(1);
});

test('the playlist is clean for axe and stays inside 320px', async ({ page }) => {
  for (const route of ['listen/', 'release/hatbara-shel-piposh/']) {
    await page.goto(site.route(route));

    /* Analysed with a track current, because aria-current and the live region only carry
       anything once the album has been sent somewhere. Paused again so the scan is not
       reading a page mid-playback. */
    const player = album(page).locator('[data-album-audio]');
    await album(page).locator('.track-play').nth(1).click();
    await expect(player).toHaveAttribute('aria-label', /.+/u);
    await player.evaluate((node: HTMLAudioElement) => node.pause());
    expect((await new AxeBuilder({ page }).analyze()).violations, route).toEqual([]);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `${route} does not scroll sideways`).toBeLessThanOrEqual(
      overflow.clientWidth,
    );
  }
});
