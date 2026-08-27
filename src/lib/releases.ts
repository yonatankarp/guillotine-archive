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
