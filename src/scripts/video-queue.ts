import { type QueueConfig, startQueue } from './media-queue';

/**
 * The screening player: one stage per release, the other videos of that release queued under
 * it, and the release plays through.
 *
 * All of the behaviour is media-queue.ts, which is also what drives the album player on
 * /listen/. This file is the eleven attribute names, the four Hebrew lines and the one DOM
 * call that make that engine a screening room rather than a record player.
 *
 * The stage is not a separate thing from the panel's player: it IS the panel's player, the
 * same single element the album panel carries, only visible. Chrome's user-agent sheet gives
 * `audio:not([controls])` display:none, which is why the album's element takes no space and
 * this one takes a frame.
 *
 * One element covers both states a video is in here, which is why there is one of everything.
 * A <video> with a poster and no source paints the still and asks the network for nothing, so
 * a release holding films the archive does not host queues them beside the ones it does: the
 * stage shows whichever still or film is selected, and the transport goes honestly inactive
 * on an item there is nothing to start. A release with nothing playable at all is that same
 * panel with the count at zero — see the reel shape in media-queue.ts, which is served with
 * no toggle and no bar rather than with two controls that would have to refuse every press.
 */
const SCREENING: QueueConfig = {
  root: '.album',
  rowMedia: 'video.item-player',
  attributes: {
    panel: 'data-screen-player',
    media: 'data-screen-video',
    nowLabel: 'data-screen-now-label',
    nowName: 'data-screen-now-name',
    seek: 'data-screen-seek',
    elapsed: 'data-screen-elapsed',
    total: 'data-screen-total',
    toggle: 'data-screen-toggle',
    previous: 'data-screen-prev',
    next: 'data-screen-next',
    queue: 'data-screen-queue',
  },
  labels: {
    playing: 'מוקרן עכשיו:',
    ready: 'מוכן להקרנה:',
    failed: 'לא הצלחנו להקרין:',
    skipped: 'סרטון אחד לא נטען, דילגנו עליו. מוקרן עכשיו:',
    /* Eight of the thirty-one. Their sources run past the transcode's own source cap, so the
       archive has a still of each and no rendition of any — which is a fact about the file
       and not a failure, and the line says so without apologising for it. */
    unhostable: 'גדול מדי בשביל לשבת פה:',
  },
  /*
   * The controls go, the element stays — and that is the one place this player parts company
   * with the album player, because the user-agent sheets part company first. A track row's
   * <audio> can be removed outright: without controls Chrome would not paint it anyway. A
   * <video> without controls still paints, and what it paints is its poster — which is the
   * only picture a queue row has to offer, and one the browser has already fetched. Removing
   * it would leave a strip of names where a filmstrip belongs, and putting the still back by
   * hand would mean writing .item-poster a second time in script, which is exactly the kind
   * of second copy this pair of files exists to avoid. So the row keeps its frame and loses
   * its handle on playback: the panel is the control now, the same as on /listen/.
   */
  retire: (element) => element.removeAttribute('controls'),
};

/**
 * The parts of the Fullscreen API that are not in the standard shape, declared rather than
 * cast at each call site. Safari carries the whole thing under a prefix; iOS Safari carries
 * none of it for an arbitrary element and only lets the <video> itself go.
 */
interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => void;
}

interface PrefixedDocument extends Document {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}

interface PrefixedVideo extends HTMLVideoElement {
  webkitEnterFullscreen?: () => void;
}

function fullscreenElement(): Element | null {
  const owner = document as PrefixedDocument;
  return document.fullscreenElement ?? owner.webkitFullscreenElement ?? null;
}

/**
 * Whether this browser will go fullscreen at all, by either route. False on a browser with the
 * API switched off — inside a sandboxed frame, or by policy — and the button is then not shown
 * rather than shown and inert.
 */
function fullscreenAvailable(stage: HTMLVideoElement): boolean {
  const owner = document as PrefixedDocument;
  return (
    document.fullscreenEnabled ||
    owner.webkitFullscreenEnabled === true ||
    typeof (stage as PrefixedVideo).webkitEnterFullscreen === 'function'
  );
}

/**
 * How big the film is, which is the visitor's decision and nobody else's.
 *
 * Two states, both off until pressed, both undone by the same press. Theater is CSS on the
 * panel and nothing more. Fullscreen asks for the PANEL rather than for the <video>, because
 * the video has had its controls taken away — the panel is the control now, and a fullscreen
 * <video> would be a film with no way to pause it that did not come from the platform.
 *
 * Neither fetches anything. The stage is preload="none" and stays that way; enlarging a frame
 * is a question about pixels the browser already has.
 */
function wireStageViews(panel: HTMLElement): void {
  const stage = panel.querySelector<HTMLVideoElement>('[data-screen-video]');
  const theater = panel.querySelector<HTMLButtonElement>('[data-screen-theater]');
  const fullscreen = panel.querySelector<HTMLButtonElement>('[data-screen-fullscreen]');
  /* A reel has no view controls at all, so this is the whole of what it needs from here. */
  if (stage === null || theater === null || fullscreen === null) return;

  theater.addEventListener('click', () => {
    const on = panel.dataset.theater === undefined;
    if (on) panel.dataset.theater = 'true';
    else delete panel.dataset.theater;
    theater.setAttribute('aria-pressed', on ? 'true' : 'false');
  });

  /**
   * iOS Safari has no element fullscreen — only the video's own, with the platform's controls
   * over it, which is the right answer there and the only one on offer. preload="none" means
   * nothing is loaded until someone presses play, and an empty element will not go; the press
   * is itself a gesture, so the film starts and goes as soon as the browser knows what it is.
   */
  const enterOnTheVideo = (): void => {
    const video = stage as PrefixedVideo;
    const go = (): void => {
      try {
        video.webkitEnterFullscreen?.();
      } catch {
        /* The platform refused — a source that never loaded, most likely. Nothing to undo. */
      }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      go();
      return;
    }
    video.addEventListener('loadedmetadata', go, { once: true });
    void video.play().catch(() => undefined);
  };

  fullscreen.addEventListener('click', () => {
    const owner = document as PrefixedDocument;
    if (fullscreenElement() !== null) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
      else owner.webkitExitFullscreen?.();
      return;
    }

    const target = panel as PrefixedElement;
    if (target.requestFullscreen) {
      void target.requestFullscreen().catch(() => undefined);
      return;
    }
    if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
      return;
    }
    enterOnTheVideo();
  });

  /*
   * Escape leaves fullscreen without pressing anything, and so does the browser's own chrome,
   * so the state is read back from the document rather than remembered here — a button that
   * went on claiming to be in fullscreen after the visitor had left it would be the panel
   * lying about which mode it is in.
   *
   * The iOS route puts the VIDEO fullscreen and not the panel, so this correctly leaves the
   * button unpressed there: the platform's own player is what is on screen, and it is not
   * this state.
   */
  const sync = (): void => {
    const active = fullscreenElement() === panel;
    if (active) panel.dataset.fullscreen = 'true';
    else delete panel.dataset.fullscreen;
    fullscreen.setAttribute('aria-pressed', active ? 'true' : 'false');
  };

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  /* Last, and only now: until this line the button is not on the page at all. */
  if (fullscreenAvailable(stage)) fullscreen.hidden = false;
}

export function upgradeScreenings(target: Document): void {
  startQueue(target, SCREENING);

  /* Only the panels the upgrade actually opened. A release holding one video never got one,
     and a panel that failed to wire is still hidden and must not grow controls. */
  for (const panel of target.querySelectorAll<HTMLElement>('[data-screen-player]:not([hidden])')) {
    wireStageViews(panel);
  }
}
