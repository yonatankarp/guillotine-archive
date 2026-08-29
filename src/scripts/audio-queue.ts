import { type QueueConfig, startQueue, watchExclusivePlayback } from './media-queue';
import { upgradeScreenings } from './video-queue';

/**
 * The album player: one player per release, the tracklist inside it, and the album plays
 * through.
 *
 * All of the behaviour is media-queue.ts, which the screening player on /watch/ runs on too.
 * This file is the eleven attribute names, the four Hebrew lines and the one DOM call that
 * make that engine a record player rather than a screening room.
 *
 * It is also the page's one entry point, which is why it starts both players: BaseLayout
 * imports startAudioQueue() and nothing else, and a second import there would be a change to
 * a file this work does not own. The name is now narrower than the job — renaming it belongs
 * with whoever owns the layout.
 */
const ALBUM: QueueConfig = {
  root: '.album',
  rowMedia: 'audio.item-player',
  attributes: {
    panel: 'data-album-player',
    media: 'data-album-audio',
    nowLabel: 'data-album-now-label',
    nowName: 'data-album-now-name',
    seek: 'data-album-seek',
    elapsed: 'data-album-elapsed',
    total: 'data-album-total',
    toggle: 'data-album-toggle',
    previous: 'data-album-prev',
    next: 'data-album-next',
    queue: 'data-album-queue',
  },
  labels: {
    playing: 'מתנגן עכשיו:',
    ready: 'מוכן לנגן:',
    failed: 'לא הצלחנו לנגן:',
    skipped: 'רצועה אחת לא נטענה, דילגנו עליה. מתנגן עכשיו:',
  },
  /* Chrome's user-agent sheet gives audio:not([controls]) display:none, so a track row's own
     player can simply go: nothing is left behind and nothing takes a cell. A video row cannot
     do this — see the note beside the same field in video-queue.ts. */
  retire: (element) => element.remove(),
};

export function startAudioQueue(target: Document = document): void {
  watchExclusivePlayback(target);

  startQueue(target, ALBUM);
  upgradeScreenings(target);
}
