/**
 * One player per group, the list inside it, and the group plays through.
 *
 * This is the engine both players run on: the album player on /listen/ and the screening
 * player on /watch/. It was written for audio and turned out never to have been about audio —
 * every element it touches was already typed HTMLMediaElement, and a queue, a transport, a
 * seek bar and a tail reset do not care whether a picture comes with the sound. The two
 * players differ in eleven attribute names, four Hebrew lines and one DOM call, and all of
 * that is QueueConfig. Nothing else is duplicated, deliberately: this repository has already
 * paid once for two lists of the same thing drifting apart.
 *
 * Every row is served with its own plain <audio controls> or <video controls>, so with this
 * script absent the page is exactly what it always was: a working player on each row.
 * Everything here is additive. The panel and the per-row buttons are served hidden, and this
 * is the only thing that reveals them — nothing dead is ever shown to a visitor without
 * JavaScript.
 *
 * The list is not duplicated. The server renders exactly one <ul class="item-rows"> and the
 * upgrade MOVES it into the panel's empty queue slot, which is why every row keeps the
 * numbering and the per-item view and download links it was rendered with, and why a page of
 * 169 tracks does not carry two copies of them.
 *
 * The order of the last four steps is the whole no-JS story, and it is load-bearing: cue,
 * unhide the panel, move the list into it, then take the per-row players away. Moving the list
 * before the panel is visible would put it inside a hidden box, so a throw in between would
 * leave a visitor with no list at all; moving it after means a throw anywhere leaves the
 * served page standing.
 *
 * Nothing here fetches media. Cueing an item sets a source on a preload="none" element and
 * costs no bytes; the listening page carries 169 of them, and it has to stay free to open.
 * That is also why the clocks start unknown: the catalog has no length for any track, Drive
 * only reports duration for video, so a length is learned from the element itself the first
 * time someone actually plays something — and written back into the row while it is here.
 *
 * `play` does not bubble. A capture-phase listener on the document still sees it on its way
 * down to the target, which is why silencing every other player needs no per-element wiring
 * and keeps working for players added to the page later.
 */

/** A length nobody knows yet. Mono and LTR wherever it lands, like every other clock. */
const UNKNOWN_TIME = '--:--';

/** A run of dead items this long stops the group instead of racing it to the end. */
const FAILURE_LIMIT = 3;

/**
 * A panel with nothing on its queue that can play, which is a shape rather than a mode: it
 * carries no toggle and no bar, because a control that cannot do what it says is worse than
 * no control. The markup declares it and panelOf enforces exactly the shape declared, so the
 * "missing a part means no upgrade at all" rule holds for both shapes instead of being
 * loosened for the one that has fewer parts.
 */
const REEL_ATTRIBUTE = 'data-reel';

/** What the one toggle says it will do next. The same two words for a song and for a film. */
const PLAY_LABEL = 'נגן';
const PAUSE_LABEL = 'עצור';

/**
 * The panel's wiring, spelled out rather than built from a prefix. These exact strings are
 * also what the stylesheets and the end-to-end tests key on, so `data-album-audio` has to
 * stay greppable from the config through the component to the test that asserts it.
 */
export interface QueueAttributes {
  readonly panel: string;
  readonly media: string;
  readonly nowLabel: string;
  readonly nowName: string;
  readonly seek: string;
  readonly elapsed: string;
  readonly total: string;
  readonly toggle: string;
  readonly previous: string;
  readonly next: string;
  readonly queue: string;
}

/** The status line, in the states it is ever in. Every one of them names the item. */
export interface QueueLabels {
  readonly playing: string;
  readonly ready: string;
  readonly failed: string;
  readonly skipped: string;
  /**
   * Said of an item the archive has a picture of and no rendition of, which is a state and
   * not a fault. Only a queue whose rows can exist without a rendition needs one: a track
   * with no derivative renders no <audio> and never reaches a playlist at all, so the album
   * player leaves this unset and the branch that reads it never runs.
   */
  readonly unhostable?: string;
}

export interface QueueConfig {
  /** The wrapper the server puts around one panel and the one list that belongs to it. */
  readonly root: string;
  /** The row's own served player, which is both the source of the queue and its fallback. */
  readonly rowMedia: string;
  readonly attributes: QueueAttributes;
  readonly labels: QueueLabels;
  /**
   * What becomes of a row's served player once the panel is the control.
   *
   * The only line of this engine that is not the same for both players, and it differs
   * because the user-agent sheets differ rather than because the two panels disagree about
   * anything. Chrome gives `audio:not([controls])` display:none, so a track row's player can
   * simply be removed; a `video:not([controls])` still paints, and its poster is the one
   * thing a queue row has to show, so a video row keeps the element and loses the controls.
   * Same principle either way: the panel is the control now.
   */
  readonly retire: (element: HTMLMediaElement) => void;
}

interface Item {
  /** Empty for an item the archive does not host — everything below still works on it. */
  readonly src: string;
  readonly nameHe: string;
  /** The still the stage shows before a frame is decoded, and after one fails to be. */
  readonly poster: string;
  readonly row: HTMLLIElement;
  readonly button: HTMLButtonElement;
  /** The row's own clock, filled in once the browser has told us how long this item is. */
  readonly time: HTMLElement | null;
}

/** Every part of the panel the script drives. Missing one of them means no upgrade at all. */
interface Panel {
  readonly root: HTMLElement;
  readonly player: HTMLMediaElement;
  readonly nowName: HTMLElement;
  readonly nowLabel: HTMLElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;
  /* The four parts a reel does not have. Stepping the queue is the whole of its transport. */
  readonly seek: HTMLInputElement | null;
  readonly elapsed: HTMLElement | null;
  readonly total: HTMLElement | null;
  readonly toggle: HTMLButtonElement | null;
  /** The empty slot the served list is moved into, and the queue's scrollport. */
  readonly queue: HTMLElement;
}

export function isMedia(value: EventTarget | null): value is HTMLMediaElement {
  return value instanceof HTMLMediaElement;
}

export function stopEveryOther(playing: HTMLMediaElement): void {
  for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (other !== playing && !other.paused) other.pause();
  }
}

/**
 * Seconds as a clock. formatDuration() on the server does the same job from milliseconds,
 * and is left there: importing it would pull the catalog's URL helpers into every page's
 * bundle to save four lines.
 */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNKNOWN_TIME;

  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function panelOf(group: Element, attributes: QueueAttributes): Panel | null {
  const at = <T extends Element>(name: string): T | null => group.querySelector<T>(`[${name}]`);

  const root = at<HTMLElement>(attributes.panel);
  const player = at<HTMLMediaElement>(attributes.media);
  const nowName = at<HTMLElement>(attributes.nowName);
  const nowLabel = at<HTMLElement>(attributes.nowLabel);
  const seek = at<HTMLInputElement>(attributes.seek);
  const elapsed = at<HTMLElement>(attributes.elapsed);
  const total = at<HTMLElement>(attributes.total);
  const toggle = at<HTMLButtonElement>(attributes.toggle);
  const previous = at<HTMLButtonElement>(attributes.previous);
  const next = at<HTMLButtonElement>(attributes.next);
  const queue = at<HTMLElement>(attributes.queue);

  if (
    root === null ||
    player === null ||
    nowName === null ||
    nowLabel === null ||
    previous === null ||
    next === null ||
    queue === null
  ) {
    return null;
  }

  /* The transport is required of every panel that claims to have one. A reel says it has
     none, and is held to that instead of to a shorter list of parts. */
  const reel = root.hasAttribute(REEL_ATTRIBUTE);
  if (!reel && (seek === null || elapsed === null || total === null || toggle === null)) {
    return null;
  }

  return { root, player, nowName, nowLabel, seek, elapsed, total, toggle, previous, next, queue };
}

/**
 * The queue, read off the rows themselves: the same list, in the same order, that a visitor
 * without this script would have played one row at a time.
 */
function itemsOf(group: Element, config: QueueConfig): Item[] {
  const items: Item[] = [];

  for (const button of group.querySelectorAll<HTMLButtonElement>('[data-track-play]')) {
    const row = button.closest('li');
    if (row === null) continue;

    const rowPlayer = row.querySelector<HTMLMediaElement>(config.rowMedia);
    /* A row that has a picture and no rendition — eight of the thirty-one videos, whose
       sources run past the transcode's own size cap and are never converted. It is served as
       a still and a pair of links out to the file, and that still is the whole of what it can
       put on a stage. An audio row never has one, so this is null on every playlist. */
    const still = row.querySelector<HTMLImageElement>('.item-poster img');
    if (rowPlayer === null && still === null) continue;

    items.push({
      src: rowPlayer?.src ?? '',
      nameHe: button.dataset.track ?? '',
      /* The row already carries the still the server chose for it, so the stage never has to
         be told a second time which frame stands for which file. */
      poster: rowPlayer instanceof HTMLVideoElement ? rowPlayer.poster : (still?.src ?? ''),
      row,
      button,
      time: row.querySelector<HTMLElement>('[data-track-time]'),
    });
  }

  return items;
}

function upgradeGroup(group: Element, config: QueueConfig): void {
  const panel = panelOf(group, config.attributes);
  if (panel === null) return;

  const items = itemsOf(group, config);
  if (items.length < 2) return;

  const { labels } = config;
  const { player, seek } = panel;
  /* Before the first select rather than on the first item, because two items the archive
     does not host both carry an empty source: the source alone cannot say that the selection
     changed, so the index has to, and it has to start somewhere no item is. */
  let current = -1;
  /* True between grabbing the bar and letting go, so playback cannot fight the drag. */
  let scrubbing = false;
  /* True while the group is meant to be sounding, so an item that dies is replaced by one
     playing when someone is listening and by one merely cued when nobody is. */
  let running = false;
  /* Dead items since the last one that actually played. */
  let failures = 0;
  /* Set when a dead item has been stepped over, so the next `play` says so. */
  let pendingSkip = false;

  const length = (): number => (seek === null ? 0 : Number(seek.max));

  /** Everything the bar says: the fill, the elapsed clock, and what a screen reader hears. */
  const showPosition = (seconds: number): void => {
    if (seek === null || panel.elapsed === null) return;

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
   * An item whose length is still unknown has nothing to seek inside, so the bar says so
   * rather than pretending a position in it means something.
   */
  const setLength = (seconds: number): void => {
    const known = Number.isFinite(seconds) && seconds > 0;

    /* The one place an item's length is ever known first-hand, so the row keeps it. Written
       before the bar, because a reel has no bar and the row still wants the number. */
    const row = items[current]?.time;
    if (known && row) row.textContent = clock(seconds);

    if (seek === null || panel.total === null) return;

    seek.max = known ? String(Math.floor(seconds)) : '0';
    seek.setAttribute('aria-disabled', known ? 'false' : 'true');
    panel.total.textContent = known ? clock(seconds) : UNKNOWN_TIME;
  };

  const markEnds = (): void => {
    panel.previous.setAttribute('aria-disabled', current === 0 ? 'true' : 'false');
    panel.next.setAttribute('aria-disabled', current + 1 >= items.length ? 'true' : 'false');
  };

  /**
   * Scrolls the queue — and ONLY the queue — until the given row is inside its window.
   *
   * row.scrollIntoView({ block: 'nearest' }) does the same job in one line and was what this
   * used, but it walks every scrollport up the chain: on the listening page, an album advancing
   * by itself moved the document 366px as well, which is a worse thing to do to a reader than
   * the problem it was solving. Setting scrollTop on the container is the whole fix.
   *
   * Gentle by construction, like block: 'nearest' was: a row already fully in view moves
   * nothing, so someone who has scrolled off to read another part of the list is only pulled
   * back once the item actually leaves the window.
   */
  const reveal = (row: HTMLElement): void => {
    const window_ = panel.queue.getBoundingClientRect();
    const here = row.getBoundingClientRect();

    if (here.top < window_.top) panel.queue.scrollTop -= window_.top - here.top;
    else if (here.bottom > window_.bottom) panel.queue.scrollTop += here.bottom - window_.bottom;
  };

  /** Cues an item, and says which one it is in both places assistive tech reads. */
  const select = (index: number, play: boolean): void => {
    const item = items[index];
    if (item === undefined) return;

    /* Re-assigning the same source would reload it and lose the position, so a second press
       on the item already cued just resumes it. The index is half of the test because two
       items the archive does not host share the one empty source, and stepping between them
       has to change the picture. */
    const changed = index !== current || player.src !== item.src;
    /* An item that will never play. Its still IS the item, here and on the queue row. */
    const playable = item.src !== '';
    current = index;

    if (changed) {
      /* Before the source, so the stage never shows the previous film's last frame while the
         next one loads. A poster costs nothing the row has not already paid: it is the same
         file the queue row is showing, so the browser has it. */
      if (player instanceof HTMLVideoElement) {
        /* Every one of the 31 videos in the catalog carries a still, so the empty branch is
           defensive — and it removes the attribute rather than setting it empty, because an
           empty poster URL resolves against the document and asks for the page again. */
        if (item.poster === '') player.removeAttribute('poster');
        else player.poster = item.poster;
      }

      if (playable) player.src = item.src;
      else {
        /* Nothing to ask the network for. Dropping the source and re-running the load leaves
           the element empty and painting its poster, which is the whole of what this item
           has — and it is the only way the previous film stops showing under it. */
        player.removeAttribute('src');
        player.load();
      }

      if (seek !== null) seek.value = '0';
      setLength(Number.NaN);
      showPosition(0);
    }

    panel.nowName.textContent = item.nameHe;

    /* The transport says what it can do with THIS item and not with the queue in general.
       There is nothing to start and nothing to seek inside a file we do not host: the bar was
       turned off by setLength above, and every control that needs the file says so with
       aria-disabled rather than disabled, so it keeps its place in the tab order. A reel
       carries none of them — its own markup already left them out. */
    panel.toggle?.setAttribute('aria-disabled', playable ? 'false' : 'true');
    if (!playable && labels.unhostable !== undefined) {
      panel.nowLabel.textContent = labels.unhostable;
    } else if (playable && panel.nowLabel.textContent === labels.unhostable) {
      /* Back to cued. A play, if one follows, overwrites this from its own handler. */
      panel.nowLabel.textContent = labels.ready;
    }

    for (const other of items) {
      if (other === item) other.button.setAttribute('aria-current', 'true');
      else other.button.removeAttribute('aria-current');
    }
    markEnds();

    /* Autoplay can refuse even inside a user-initiated chain, and a refusal must not throw
       an unhandled rejection. play() on a source-less element fires `play` and would have the
       panel announce a film that is not running, so an unhostable item is never asked. */
    if (play && playable) void player.play().catch(() => undefined);
  };

  /** Prev and next keep the group as it was: playing stays playing, cued stays quiet. */
  const step = (delta: number): void => {
    const index = current + delta;
    if (index < 0 || index >= items.length) return;

    select(index, !player.paused);
    const row = items[index]?.row;
    if (row) reveal(row);
  };

  /* Picking an item scrolls to it too. Clicking one is usually already looking at it, so this
     is for the keyboard and for a press that lands on a row half out of the window. */
  for (const [index, item] of items.entries()) {
    item.button.addEventListener('click', () => {
      select(index, true);
      reveal(item.row);
    });
  }

  panel.toggle?.addEventListener('click', () => {
    /* A source-less element reports itself paused, so testing the element would send this
       straight into play(). The item is what knows, and the button is aria-disabled rather
       than disabled precisely so that it is still reachable and still has to refuse. */
    if (items[current]?.src === '') return;
    if (player.paused) void player.play().catch(() => undefined);
    else player.pause();
  });
  panel.previous.addEventListener('click', () => step(-1));
  panel.next.addEventListener('click', () => step(1));

  /* input fires for a drag and for the arrow keys alike, so the clock follows the handle
     either way; the seek itself waits for the release, so a drag across an item does not
     ask the network for every frame it passes. */
  seek?.addEventListener('input', () => {
    if (length() <= 0) return;
    scrubbing = true;
    showPosition(Number(seek.value));
  });

  seek?.addEventListener('change', () => {
    scrubbing = false;
    if (length() <= 0) return;
    player.currentTime = Number(seek.value);
  });

  player.addEventListener('loadedmetadata', () => setLength(player.duration));

  player.addEventListener('timeupdate', () => {
    if (scrubbing) return;
    if (seek !== null) seek.value = String(Math.floor(player.currentTime));
    showPosition(player.currentTime);
  });

  /* The one event that only fires when something is actually coming out, so it is the only
     honest place to forget the failures that came before it. */
  player.addEventListener('playing', () => {
    failures = 0;
  });

  player.addEventListener('play', () => {
    running = true;
    panel.root.dataset.playing = 'true';
    panel.toggle?.setAttribute('aria-label', PAUSE_LABEL);
    /* The panel opens cued rather than playing, and it only starts saying so once it is. The
       line then stays put: a pause is written on the button that caused it, and re-announcing
       the line every time someone pauses is noise, not information. So the label is written
       once per state the group is actually in, and having just stepped over a dead item is
       one of those states — play() queues this event rather than firing it, so the error
       handler cannot write that line itself without this one overwriting it. */
    const label = pendingSkip ? labels.skipped : labels.playing;
    pendingSkip = false;
    if (panel.nowLabel.textContent !== label) panel.nowLabel.textContent = label;
  });

  player.addEventListener('pause', () => {
    running = false;
    delete panel.root.dataset.playing;
    panel.toggle?.setAttribute('aria-label', PLAY_LABEL);
  });

  /**
   * An item whose derivative 404s or will not decode used to end the group where it stood:
   * play() rejects into the catch that swallows a refused autoplay, `ended` never fires, and
   * every item after it is reachable only by clicking it one at a time. So a dead item says
   * so, is marked on its own row, and the group steps over it.
   *
   * Only while someone is listening, and only for a short run of them: a release whose files
   * are all gone has to stop rather than walk itself to the end asking for every one of them.
   *
   * The stage is left alone on purpose. Its poster is the still the row already shows, it is
   * the one part of a dead film that still works, and the row's own view and download links
   * still reach the original — so what a visitor is looking at goes on being the thing the
   * line above it is talking about.
   */
  player.addEventListener('error', () => {
    const item = items[current];
    if (item === undefined) return;

    /* A row nobody asked the network for cannot have failed. A file the archive does not host
       is a state and not a fault, and it must not be able to mark itself dead, step the queue
       past itself, or spend one of the three strikes below — whatever a given engine decides
       to fire when the source is dropped and the load re-run. */
    if (item.src === '') return;

    /* An attribute, not a class: the row's own styling belongs to the stylesheet. */
    item.button.dataset.trackFailed = 'true';
    /* aria-disabled rather than disabled, so the button keeps its place in the tab order and
       an item that failed once can still be tried again. */
    item.button.setAttribute('aria-disabled', 'true');
    failures += 1;

    if (!running || failures >= FAILURE_LIMIT || current + 1 >= items.length) {
      /* A media error fires no `pause` and leaves paused false, so the panel would go on
         calling itself playing. Asking for the pause routes the toggle, the dataset and
         `running` back through the one handler that owns them; it is a no-op if already
         paused, which is the other way into this branch. */
      player.pause();
      if (seek !== null) seek.value = '0';
      setLength(Number.NaN);
      showPosition(0);
      panel.nowLabel.textContent = labels.failed;
      return;
    }

    pendingSkip = true;
    select(current + 1, true);
    const row = items[current]?.row;
    if (row) reveal(row);
  });

  player.addEventListener('ended', () => {
    if (current + 1 >= items.length) {
      /* The group is over, so the panel goes back to what it was served as instead of sitting
         at the end of the last item still claiming to play it. Re-cueing the first one is
         what makes the next press play the group rather than replay its tail, and the element
         is preload="none", so cueing it asks the network for nothing. */
      running = false;
      select(0, false);
      /* Unless the item it has gone back to is one the archive does not host, in which case
         select has already written the truer line and this one would paint over it. */
      if (items[0]?.src !== '') panel.nowLabel.textContent = labels.ready;
      const first = items[0]?.row;
      if (first) reveal(first);
      return;
    }
    select(current + 1, true);
    /* The one change no control made, so the queue following it is the only thing that says
       where the group went — the status line says which item, this says where it is. */
    const row = items[current]?.row;
    if (row) reveal(row);
  });

  select(0, false);
  panel.root.hidden = false;

  /* The panel is on screen and wired, so the list can come inside it. Same element, so every
     row keeps its number, its links and its place in the order. Moving a media element within
     one document does not re-run the media load algorithm, and these are preload="none" with
     nothing playing, so the move costs no bytes. */
  const list = group.querySelector<HTMLUListElement>('ul.item-rows');
  if (list !== null) panel.queue.append(list);

  for (const item of items) item.button.hidden = false;

  /* Last: until this line every row still plays on its own. */
  for (const item of items) {
    const served = item.row.querySelector<HTMLMediaElement>(config.rowMedia);
    if (served !== null) config.retire(served);
  }
}

/**
 * Silences every other player on the page whenever one starts. One listener for the whole
 * document, so an album and a screening cannot sound at once no matter which page carries
 * both and no matter which panel was wired first.
 */
export function watchExclusivePlayback(target: Document): void {
  target.addEventListener(
    'play',
    (event) => {
      if (isMedia(event.target)) stopEveryOther(event.target);
    },
    true,
  );
}

export function startQueue(target: Document, config: QueueConfig): void {
  for (const group of target.querySelectorAll(config.root)) upgradeGroup(group, config);
}
