import type { CatalogItem } from '../catalog/types';
import { sitePath } from '../lib/url';

/**
 * Resolves generated renditions to site URLs.
 *
 * Every one of these returns null until a sync has produced the derivative, and
 * the components fall back to a plain file row when it does. That fallback is the
 * whole point: the pages must render before the pipeline has ever run, and they
 * must improve without a template change once it has.
 */

function url(path: string | undefined): string | null {
  return path === undefined ? null : sitePath(path);
}

/** Grid-sized image, about 400px. */
export function thumbUrl(item: CatalogItem): string | null {
  return url(item.derivatives?.thumb?.path);
}

/** Full-view image, about 1600px, or the reader tier where one exists. */
export function viewUrl(item: CatalogItem): string | null {
  return url(item.derivatives?.reader?.path ?? item.derivatives?.view?.path);
}

export function audioUrl(item: CatalogItem): string | null {
  return url(item.derivatives?.audio?.path);
}

export function posterUrl(item: CatalogItem): string | null {
  return url(item.derivatives?.poster?.path);
}

export function hasThumbs(items: readonly CatalogItem[]): boolean {
  return items.some((item) => item.derivatives?.thumb !== undefined);
}

export function hasAudio(items: readonly CatalogItem[]): boolean {
  return items.some((item) => item.derivatives?.audio !== undefined);
}

/**
 * Only these play from a hosted derivative or directly. Everything else in the
 * archive is WMV, AVI, MPEG or VOB, which no browser decodes whatever we host.
 */
const BROWSER_VIDEO = new Set(['video/mp4', 'video/webm']);

export function playsInBrowser(item: CatalogItem): boolean {
  return BROWSER_VIDEO.has(item.mimeType.toLowerCase());
}

export function formatDuration(millis: number | undefined): string | null {
  if (millis === undefined || millis <= 0) return null;

  const total = Math.round(millis / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
