/**
 * One track at a time, and an album plays through.
 *
 * The players are plain <audio controls> elements, so with this script absent
 * they still work: you just get independent players, which is what the site did
 * before. Everything here is additive.
 *
 * `play` and `ended` do not bubble, so both listeners capture. A capture-phase
 * listener on the document still sees a non-bubbling event on its way down to
 * the target, which is why this needs no per-element wiring and keeps working
 * for players added to the page later.
 */

/** The album a track belongs to: one rendered list, which is one release. */
const ALBUM_SELECTOR = '.item-rows';

function isMedia(value: EventTarget | null): value is HTMLMediaElement {
  return value instanceof HTMLMediaElement;
}

function stopEveryOther(playing: HTMLMediaElement): void {
  for (const other of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    if (other !== playing && !other.paused) other.pause();
  }
}

function nextInAlbum(finished: HTMLMediaElement): HTMLMediaElement | null {
  const album = finished.closest(ALBUM_SELECTOR);
  if (album === null) return null;

  const players = [...album.querySelectorAll<HTMLMediaElement>('audio')];
  const position = players.indexOf(finished as HTMLAudioElement);

  return position === -1 ? null : players[position + 1] ?? null;
}

export function startAudioQueue(target: Document = document): void {
  target.addEventListener(
    'play',
    (event) => {
      if (isMedia(event.target)) stopEveryOther(event.target);
    },
    true,
  );

  target.addEventListener(
    'ended',
    (event) => {
      if (!isMedia(event.target)) return;

      const next = nextInAlbum(event.target);
      if (next === null) return;

      /* Autoplay can still refuse even inside a user-initiated chain, and a
         refusal must not throw an unhandled rejection. */
      void next.play().catch(() => undefined);
      /* Keep the playing track in view without yanking the page around it. */
      next.closest('li')?.scrollIntoView({ block: 'nearest' });
    },
    true,
  );
}
