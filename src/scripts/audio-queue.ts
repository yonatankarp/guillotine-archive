/**
 * One player per album, and the album plays through.
 *
 * Every track row is served with its own plain <audio controls>, so with this script absent
 * the page is exactly what it always was: a working player on each row. Everything here is
 * additive. The album player and the per-row buttons are served hidden, and this is the only
 * thing that reveals them — nothing dead is ever shown to a visitor without JavaScript.
 *
 * The upgrade takes the per-row players away only after the album player is wired and on
 * screen, so a throw halfway through leaves the fallback standing rather than nothing.
 *
 * `play` does not bubble. A capture-phase listener on the document still sees it on its way
 * down to the target, which is why silencing every other player needs no per-element wiring
 * and keeps working for players added to the page later.
 */

/** One rendered list and the player above it: one release. */
const ALBUM_SELECTOR = '.album';

interface Track {
  readonly src: string;
  readonly nameHe: string;
  readonly row: HTMLLIElement;
  readonly button: HTMLButtonElement;
}

function isMedia(value: EventTarget | null): value is HTMLMediaElement {
  return value instanceof HTMLMediaElement;
}

function stopEveryOther(playing: HTMLMediaElement): void {
  for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (other !== playing && !other.paused) other.pause();
  }
}

function upgradeAlbum(album: Element): void {
  const panel = album.querySelector<HTMLElement>('[data-album-player]');
  const player = album.querySelector<HTMLAudioElement>('[data-album-audio]');
  const nowPlaying = album.querySelector<HTMLElement>('[data-album-now-name]');
  const nowLabel = album.querySelector<HTMLElement>('[data-album-now-label]');
  const buttons = [...album.querySelectorAll<HTMLButtonElement>('[data-track-play]')];
  if (panel === null || player === null || nowPlaying === null || nowLabel === null) return;

  /* The playlist is read off the rows themselves, so it is the same list, in the same order,
     that a visitor without this script would have played one row at a time. */
  const tracks: Track[] = [];
  for (const button of buttons) {
    const row = button.closest('li');
    const rowPlayer = row?.querySelector<HTMLAudioElement>('audio.item-player') ?? null;
    if (row === null || rowPlayer === null) continue;
    tracks.push({ src: rowPlayer.src, nameHe: button.dataset.track ?? '', row, button });
  }
  if (tracks.length < 2) return;

  let current = 0;

  /** Cues a track, and says which one it is in both places assistive tech reads. */
  const select = (index: number, play: boolean): void => {
    const track = tracks[index];
    if (track === undefined) return;

    current = index;
    /* Re-assigning the same source would reload it and lose the position, so a second press
       on the track already cued just resumes it. */
    if (player.src !== track.src) player.src = track.src;
    nowPlaying.textContent = track.nameHe;

    for (const other of tracks) {
      if (other === track) other.button.setAttribute('aria-current', 'true');
      else other.button.removeAttribute('aria-current');
    }

    /* Autoplay can refuse even inside a user-initiated chain, and a refusal must not throw
       an unhandled rejection. */
    if (play) void player.play().catch(() => undefined);
  };

  for (const [index, track] of tracks.entries()) {
    track.button.addEventListener('click', () => select(index, true));
  }

  /* The panel opens cued rather than playing, and it only starts saying so once it is. */
  player.addEventListener('play', () => { nowLabel.textContent = 'מתנגן עכשיו:'; }, { once: true });

  player.addEventListener('ended', () => {
    if (current + 1 >= tracks.length) return;
    select(current + 1, true);
    /* Keep the track that took over in view without yanking the page around it. */
    tracks[current]?.row.scrollIntoView({ block: 'nearest' });
  });

  select(0, false);
  panel.hidden = false;
  for (const track of tracks) track.button.hidden = false;

  /* Last: until this line every row still plays on its own. */
  for (const track of tracks) track.row.querySelector('audio.item-player')?.remove();
}

export function startAudioQueue(target: Document = document): void {
  target.addEventListener(
    'play',
    (event) => {
      if (isMedia(event.target)) stopEveryOther(event.target);
    },
    true,
  );

  for (const album of target.querySelectorAll(ALBUM_SELECTOR)) upgradeAlbum(album);
}
