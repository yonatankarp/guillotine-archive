import { describe, expect, test } from 'vitest';
import type { CatalogItem } from '../../src/catalog/types';
import {
  audioUrl,
  formatDuration,
  hasAudio,
  hasThumbs,
  hasVideo,
  playsInBrowser,
  posterUrl,
  thumbUrl,
  videoUrl,
  viewUrl,
} from '../../src/components/derivative';

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'file-1',
    name: 'Scan_000.jpg',
    mimeType: 'image/jpeg',
    size: 1024,
    modifiedTime: null,
    path: 'משחקים מלאים/פיפוש 1/חוברת/Scan_000.jpg',
    viewUrl: 'https://drive.google.com/file/d/file-1/view',
    downloadUrl: null,
    category: 'משחקים מלאים',
    kind: 'booklet-page',
    releaseSlug: 'piposh-1',
    aliasesHe: [],
    tagsHe: [],
    collectionLinks: [],
    ...overrides,
  };
}

describe('derivative resolution', () => {
  test('returns null for every rendition before a sync has produced any', () => {
    const bare = item();

    expect(thumbUrl(bare)).toBeNull();
    expect(viewUrl(bare)).toBeNull();
    expect(audioUrl(bare)).toBeNull();
    expect(videoUrl(bare)).toBeNull();
    expect(posterUrl(bare)).toBeNull();
    expect(hasThumbs([bare])).toBe(false);
    expect(hasAudio([bare])).toBe(false);
    expect(hasVideo([bare])).toBe(false);
  });

  test('resolves each tier to a site path', () => {
    const withImages = item({
      derivatives: {
        thumb: { path: 'generated/derivatives/file-1-thumb.webp', bytes: 20_000 },
        view: { path: 'generated/derivatives/file-1-view.webp', bytes: 180_000 },
      },
    });

    expect(thumbUrl(withImages)).toContain('generated/derivatives/file-1-thumb.webp');
    expect(viewUrl(withImages)).toContain('generated/derivatives/file-1-view.webp');
    expect(hasThumbs([item(), withImages])).toBe(true);
  });

  /** Booklet and magazine pages carry Hebrew body text that 1600px cannot render. */
  test('prefers the reader tier over the view tier when a page has one', () => {
    const page = item({
      derivatives: {
        view: { path: 'generated/derivatives/file-1-view.webp', bytes: 180_000 },
        reader: { path: 'generated/derivatives/file-1-reader.webp', bytes: 350_000 },
      },
    });

    expect(viewUrl(page)).toContain('file-1-reader.webp');
  });

  test('resolves audio and poster renditions', () => {
    const track = item({
      kind: 'track',
      derivatives: { audio: { path: 'generated/derivatives/file-1.opus', bytes: 900_000 } },
    });
    const video = item({
      kind: 'video',
      derivatives: {
        poster: { path: 'generated/derivatives/file-1-poster.webp', bytes: 20_000 },
        durationMillis: 252_000,
      },
    });

    expect(audioUrl(track)).toContain('file-1.opus');
    expect(hasAudio([track])).toBe(true);
    expect(posterUrl(video)).toContain('file-1-poster.webp');
    expect(videoUrl(video)).toBeNull();
    expect(hasVideo([video])).toBe(false);
  });

  /**
   * The sources here are WMV, AVI, MPEG and VOB, and the pipeline transcodes them
   * to MP4. Resolving the rendition off the source mime type would hide the very
   * files the encode exists for, so a WMV with a derivative plays like anything else.
   */
  test('resolves a video rendition whatever the source format was', () => {
    const transcoded = item({
      kind: 'video',
      mimeType: 'video/x-ms-wmv',
      derivatives: {
        poster: { path: 'generated/derivatives/file-1-poster.webp', bytes: 20_000 },
        video: { path: 'generated/derivatives/file-1.mp4', bytes: 8_000_000 },
        durationMillis: 252_000,
      },
    });

    expect(videoUrl(transcoded)).toContain('generated/derivatives/file-1.mp4');
    expect(hasVideo([item({ kind: 'video' }), transcoded])).toBe(true);
  });

  test('only MP4 and WebM are treated as playable, whatever we host', () => {
    expect(playsInBrowser(item({ mimeType: 'video/mp4' }))).toBe(true);
    expect(playsInBrowser(item({ mimeType: 'video/webm' }))).toBe(true);
    for (const mimeType of ['video/x-ms-wmv', 'video/x-msvideo', 'video/mpeg', 'video/mp2p']) {
      expect(playsInBrowser(item({ mimeType })), mimeType).toBe(false);
    }
  });

  test('formats a duration and refuses a missing or nonsense one', () => {
    expect(formatDuration(252_000)).toBe('4:12');
    expect(formatDuration(59_000)).toBe('0:59');
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBeNull();
  });
});
