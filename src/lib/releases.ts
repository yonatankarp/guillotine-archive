import { catalog, itemById } from './catalog';
import type { Release, ReleaseType } from '../catalog/types';

export const releases: readonly Release[] = catalog.releases;
export const releaseFacets = catalog.releaseFacets;
export const releaseBySlug = new Map(releases.map((release) => [release.slug, release]));

export function releasesOfType(type: ReleaseType): Release[] {
  return releases.filter((release) => release.type === type);
}

export function releasesAbout(subjectSlug: string): Release[] {
  return releases.filter((release) => release.subjectSlug === subjectSlug);
}

export function releaseOfItem(itemId: string): Release | undefined {
  const item = itemById.get(itemId);

  return item && releaseBySlug.get(item.releaseSlug);
}

/**
 * Ordering. File count is an artifact of how a disc was ripped, not a measure of
 * interest, and sorting by it buried the six games below five coverless
 * directory dumps. Games lead because they are what people came for; everything
 * else follows in a fixed editorial order and then alphabetically.
 */
const TYPE_ORDER: readonly ReleaseType[] = [
  'game',
  'audio-cd',
  'video',
  'press',
  'fan-disc',
  'fan-game',
  'demo',
  'other',
];

function byTitle(left: Release, right: Release): number {
  return left.titleHe.localeCompare(right.titleHe, 'he');
}

/** The six games, oldest first, undated last. */
export const featuredReleases: readonly Release[] = releases
  .filter((release) => release.type === 'game')
  .sort((left, right) => (left.year ?? Number.MAX_SAFE_INTEGER) - (right.year ?? Number.MAX_SAFE_INTEGER) || byTitle(left, right));

/** Everything that is not a game, in editorial type order then by title. */
export const supportingReleases: readonly Release[] = releases
  .filter((release) => release.type !== 'game')
  .sort(
    (left, right) =>
      TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) || byTitle(left, right),
  );
