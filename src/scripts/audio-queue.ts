/**
 * One player per album, the tracklist inside it, and the album plays through.
 *
 * Every track row is served with its own plain <audio controls>, so with this script absent
 * the page is exactly what it always was: a working player on each row. Everything here is
 * additive. The album player and the per-row buttons are served hidden, and this is the only
 * thing that reveals them — nothing dead is ever shown to a visitor without JavaScript.
 *
 * The tracklist is not duplicated. The server renders exactly one <ul class="item-rows"> and
 * the upgrade MOVES it into the panel's empty queue slot, which is why every row keeps the
 * numbering and the per-track view and download links it was rendered with, and why a page of
 * 169 tracks does not carry two copies of them.
 *
 * The order of the last four steps is the whole no-JS story, and it is load-bearing: cue,
 * unhide the panel, move the list into it, then take the per-row players away. Moving the list
 * before the panel is visible would put the tracklist inside a hidden box, so a throw in
 * between would leave a visitor with no list at all; moving it after means a throw anywhere
 * leaves the served page standing.
 *
 * Nothing here fetches audio. Cueing a track sets a source on a preload="none" element and
 * costs no bytes; the listening page carries 169 of them, and it has to stay free to open.
 * That is also why the clocks start unknown: the catalog has no length for any track, Drive
 * only reports duration for video, so a length is learned from the element itself the first
 * time someone actually plays something — and written back into the row while it is here.
 *
 * `play` does not bubble. A capture-phase listener on the document still sees it on its way
 * down to the target, which is why silencing every other player needs no per-element wiring
 * and keeps working for players added to the page later.
 */

/** One rendered list and the player above it: one release. */
const ALBUM_SELECTOR = '.album';

/** A length nobody knows yet. Mono and LTR wherever it lands, like every other clock. */
const UNKNOWN_TIME = '--:--';

/** What the status line says once the album is actually running. */
const PLAYING_LABEL = 'מתנגן עכשיו:';

interface Track {
  readonly src: string;
  readonly nameHe: string;
  readonly row: HTMLLIElement;
  readonly button: HTMLButtonElement;
  /** The row's own clock, filled in once the browser has told us how long this track is. */
  readonly time: HTMLElement | null;
}

/** Every part of the panel the script drives. Missing one of them means no upgrade at all. */
interface Panel {
  readonly root: HTMLElement;
  readonly player: HTMLAudioElement;
  readonly nowName: HTMLElement;
  readonly nowLabel: HTMLElement;
  readonly seek: HTMLInputElement;
  readonly elapsed: HTMLElement;
  readonly total: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  /** The empty slot the served tracklist is moved into, and the playlist's scrollport. */
  readonly queue: HTMLElement;
}

function isMedia(value: EventTarget | null): value is HTMLMediaElement {
  return value instanceof HTMLMediaElement;
}

function stopEveryOther(playing: HTMLMediaElement): void {
  for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (other !== playing && !other.paused) other.pause();
  }
}

/**
 * Seconds as a clock. formatDuration() on the server does the same job from milliseconds,
 * and is left there: importing it would pull the catalog's URL helpers into every page's
 * bundle to save four lines.
 */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN_TIME;

  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function panelOf(album: Element): Panel | null {
  const root = album.querySelector<HTMLElement>('[data-album-player]');
  const player = album.querySelector<HTMLAudioElement>('[data-album-audio]');
  const nowName = album.querySelector<HTMLElement>('[data-album-now-name]');
  const nowLabel = album.querySelector<HTMLElement>('[data-album-now-label]');
  const seek = album.querySelector<HTMLInputElement>('[data-album-seek]');
  const elapsed = album.querySelector<HTMLElement>('[data-album-elapsed]');
  const total = album.querySelector<HTMLElement>('[data-album-total]');
  const toggle = album.querySelector<HTMLButtonElement>('[data-album-toggle]');
  const previous = album.querySelector<HTMLButtonElement>('[data-album-prev]');
  const next = album.querySelector<HTMLButtonElement>('[data-album-next]');
  const queue = album.querySelector<HTMLElement>('[data-album-queue]');

  if (
    root === null ||
    player === null ||
    nowName === null ||
    nowLabel === null ||
    seek === null ||
    elapsed === null ||
    total === null ||
    toggle === null ||
    previous === null ||
    next === null ||
    queue === null
  ) {
    return null;
  }

  return { root, player, nowName, nowLabel, seek, elapsed, total, toggle, previous, next, queue };
}

/**
 * The playlist, read off the rows themselves: the same list, in the same order, that a
 * visitor without this script would have played one row at a time.
 */
function playlistOf(album: Element): Track[] {
  const tracks: Track[] = [];

  for (const button of album.querySelectorAll<HTMLButtonElement>('[data-track-play]')) {
    const row = button.closest('li');
    const rowPlayer = row?.querySelector<HTMLAudioElement>('audio.item-player') ?? null;
    if (row === null || rowPlayer === null) continue;

    tracks.push({
      src: rowPlayer.src,
      nameHe: button.dataset.track ?? '',
      row,
      button,
      time: row.querySelector<HTMLElement>('[data-track-time]'),
    });
  }

  return tracks;
}

function upgradeAlbum(album: Element): void {
  const panel = panelOf(album);
  if (panel === null) return;

  const tracks = playlistOf(album);
  if (tracks.length < 2) return;

  const { player, seek } = panel;
  let current = 0;
  /* True between grabbing the bar and letting go, so playback cannot fight the drag. */
  let scrubbing = false;

  const length = (): number => Number(seek.max);

  /** Everything the bar says: the fill, the elapsed clock, and what a screen reader hears. */
  const showPosition = (seconds: number): void => {
    const duration = length();
    const played = duration > 0 ? Math.min(100, (seconds / duration) * 100) : 0;

    seek.style.setProperty('--played', `${played}%`);
    panel.elapsed.textContent = clock(seconds);
    seek.setAttribute(
      'aria-valuetext',
      duration > 0 ? `${clock(seconds)} מתוך ${clock(duration)}` : clock(seconds),
    );
  };

  /**
   * A track whose length is still unknown has nothing to seek inside, so the bar says so
   * rather than pretending a position in it means something.
   */
  const setLength = (seconds: number): void => {
    const known = Number.isFinite(seconds) && seconds > 0;

    seek.max = known ? String(Math.floor(seconds)) : '0';
    seek.setAttribute('aria-disabled', known ? 'false' : 'true');
    panel.total.textContent = known ? clock(seconds) : UNKNOWN_TIME;

    /* The one place a track's length is ever known, so the row keeps it. */
    const row = tracks[current]?.time;
    if (known && row) row.textContent = clock(seconds);
  };

  const markEnds = (): void => {
    panel.previous.setAttribute('aria-disabled', current === 0 ? 'true' : 'false');
    panel.next.setAttribute('aria-disabled', current + 1 >= tracks.length ? 'true' : 'false');
  };

  /**
   * Scrolls the playlist — and ONLY the playlist — until the given row is inside its window.
   *
   * row.scrollIntoView({ block: 'nearest' }) does the same job in one line and was what this
   * used, but it walks every scrollport up the chain: on the listening page, an album advancing
   * by itself moved the document 366px as well, which is a worse thing to do to a reader than
   * the problem it was solving. Setting scrollTop on the container is the whole fix.
   *
   * Gentle by construction, like block: 'nearest' was: a row already fully in view moves
   * nothing, so someone who has scrolled off to read another part of the album is only pulled
   * back once the track actually leaves the window.
   */
  const reveal = (row: HTMLElement): void => {
    const window_ = panel.queue.getBoundingClientRect();
    const here = row.getBoundingClientRect();

    if (here.top < window_.top) panel.queue.scrollTop -= window_.top - here.top;
    else if (here.bottom > window_.bottom) panel.queue.scrollTop += here.bottom - window_.bottom;
  };

  /** Cues a track, and says which one it is in both places assistive tech reads. */
  const select = (index: number, play: boolean): void => {
    const track = tracks[index];
    if (track === undefined) return;

    current = index;
    /* Re-assigning the same source would reload it and lose the position, so a second press
       on the track already cued just resumes it. */
    if (player.src !== track.src) {
      player.src = track.src;
      seek.value = '0';
      setLength(Number.NaN);
      showPosition(0);
    }
    panel.nowName.textContent = track.nameHe;

    for (const other of tracks) {
      if (other === track) other.button.setAttribute('aria-current', 'true');
      else other.button.removeAttribute('aria-current');
    }
    markEnds();

    /* Autoplay can refuse even inside a user-initiated chain, and a refusal must not throw
       an unhandled rejection. */
    if (play) void player.play().catch(() => undefined);
  };

  /** Prev and next keep the album as it was: playing stays playing, cued stays quiet. */
  const step = (delta: number): void => {
    const index = current + delta;
    if (index < 0 || index >= tracks.length) return;

    select(index, !player.paused);
    const row = tracks[index]?.row;
    if (row) reveal(row);
  };

  /* Picking a track scrolls to it too. Clicking one is usually already looking at it, so this
     is for the keyboard and for a press that lands on a row half out of the window. */
  for (const [index, track] of tracks.entries()) {
    track.button.addEventListener('click', () => {
      select(index, true);
      reveal(track.row);
    });
  }

  panel.toggle.addEventListener('click', () => {
    if (player.paused) void player.play().catch(() => undefined);
    else player.pause();
  });
  panel.previous.addEventListener('click', () => step(-1));
  panel.next.addEventListener('click', () => step(1));

  /* input fires for a drag and for the arrow keys alike, so the clock follows the handle
     either way; the seek itself waits for the release, so a drag across a track does not
     ask the network for every frame it passes. */
  seek.addEventListener('input', () => {
    if (length() <= 0) return;
    scrubbing = true;
    showPosition(Number(seek.value));
  });

  seek.addEventListener('change', () => {
    scrubbing = false;
    if (length() <= 0) return;
    player.currentTime = Number(seek.value);
  });

  player.addEventListener('loadedmetadata', () => setLength(player.duration));

  player.addEventListener('timeupdate', () => {
    if (scrubbing) return;
    seek.value = String(Math.floor(player.currentTime));
    showPosition(player.currentTime);
  });

  player.addEventListener('play', () => {
    panel.root.dataset.playing = 'true';
    panel.toggle.setAttribute('aria-label', 'עצור');
    /* The panel opens cued rather than playing, and it only starts saying so once it is. The
       line stays on the track from then on: a pause is written on the button that caused it,
       and re-announcing the line every time someone pauses is noise, not information. Writing
       the same string back would be exactly that announcement, so it is written once. */
    if (panel.nowLabel.textContent !== PLAYING_LABEL) panel.nowLabel.textContent = PLAYING_LABEL;
  });

  player.addEventListener('pause', () => {
    delete panel.root.dataset.playing;
    panel.toggle.setAttribute('aria-label', 'נגן');
  });

  player.addEventListener('ended', () => {
    if (current + 1 >= tracks.length) return;
    select(current + 1, true);
    /* The one change no control made, so the playlist following it is the only thing that says
       where the album went — the status line says which track, this says where it is. */
    const row = tracks[current]?.row;
    if (row) reveal(row);
  });

  select(0, false);
  panel.root.hidden = false;

  /* The panel is on screen and wired, so the tracklist can come inside it. Same element, so
     every row keeps its number, its links and its place in the order. Moving an <audio> within
     one document does not re-run the media load algorithm, and these are preload="none" with
     nothing playing, so the move costs no bytes. */
  const list = album.querySelector<HTMLUListElement>('ul.item-rows');
  if (list !== null) panel.queue.append(list);

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
