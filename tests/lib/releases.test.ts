import { describe, expect, test } from 'vitest';
import { featuredReleases, releases, supportingReleases } from '../../src/lib/releases';

/**
 * The home page leads with these, so the sequence is editorial data and not an
 * implementation detail. Equality rather than a subset check is deliberate: a
 * seventh game added to the curator file must fail here until someone says where
 * in the release order it belongs, instead of drifting to the end unnoticed.
 */
const RELEASE_ORDER = [
  'betochhei-harating',
  'piposh-1',
  'piposh-2',
  'halom-shehitgashem',
  'vogimon',
  'piposh-revolution',
];

describe('featuredReleases', () => {
  test('lists every game in release order', () => {
    expect(featuredReleases.map(({ slug }) => slug)).toEqual(RELEASE_ORDER);
  });

  test('holds the games and nothing else', () => {
    expect(featuredReleases.map(({ type }) => type)).toEqual(RELEASE_ORDER.map(() => 'game'));
    expect(featuredReleases.length + supportingReleases.length).toBe(releases.length);
  });

  test('orders by the stated sequence rather than by year', () => {
    const dated = featuredReleases.filter(({ year }) => year !== undefined);

    expect(dated.map(({ slug }) => slug)).toEqual(['piposh-1']);
    expect(featuredReleases[0]!.slug).not.toBe('piposh-1');
  });
});
