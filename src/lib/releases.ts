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

/**
 * The games in the order they were released, as the curator gave it. Only פיפוש 1
 * carries a sourced year, so sorting by year listed one game and then guessed at
 * the rest; a stated sequence orders them without inventing five release dates.
 * A game absent from this list follows the named ones rather than disappearing.
 */
const GAME_ORDER: readonly string[] = [
  'betochhei-harating',
  'piposh-1',
  'piposh-2',
  'halom-shehitgashem',
  'vogimon',
  'piposh-revolution',
];

function byTitle(left: Release, right: Release): number {
  return left.titleHe.localeCompare(right.titleHe, 'he');
}

function releaseRank(release: Release): number {
  const index = GAME_ORDER.indexOf(release.slug);

  return index === -1 ? GAME_ORDER.length : index;
}

/** The six games, earliest release first. */
export const featuredReleases: readonly Release[] = releases
  .filter((release) => release.type === 'game')
  .sort((left, right) => releaseRank(left) - releaseRank(right) || byTitle(left, right));

/** Everything that is not a game, in editorial type order then by title. */
export const supportingReleases: readonly Release[] = releases
  .filter((release) => release.type !== 'game')
  .sort(
    (left, right) =>
      TYPE_ORDER.indexOf(left.type) - TYPE_ORDER.indexOf(right.type) || byTitle(left, right),
  );
