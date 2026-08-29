import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * Which narrower renditions of a cover are actually on `public/`, read once at build time.
 *
 * The catalog says which cover a release has; it does not say how many widths of it were
 * written, and a catalog committed before the srcset tiers existed never will. The directory
 * that Pages serves is the only thing that knows, and it is right on both sides of the sync
 * that first writes the tiers: today it lists none and every tile renders exactly the markup
 * it renders now, and after the sync it lists them and the same code emits the candidates.
 * That is the whole reason this is a disk read and not a catalog field — a srcset naming a
 * file that is not there yet is a broken image, and there is no version of that worth risking
 * to save a build-time readdir.
 */
const COVER_ROOT = 'public';

/**
 * Restated from src/catalog/media.ts, which is what writes these files, rather than imported
 * from it: that module pulls in sharp, mammoth and yauzl, and none of the sync pipeline
 * belongs in the graph the site is built from.
 */
const BASE_WIDTH = 720;
const NARROW_WIDTHS: readonly number[] = [480];

export interface CoverRendition {
  /** Site-relative, still to be passed through `sitePath()` by the caller. */
  path: string;
  width: number;
}

const listings = new Map<string, ReadonlySet<string>>();

function filesIn(directory: string): ReadonlySet<string> {
  const cached = listings.get(directory);
  if (cached) return cached;

  let names: string[];
  try {
    names = readdirSync(join(process.cwd(), COVER_ROOT, directory));
  } catch {
    // A missing directory is a site with no synced covers, not an error: the caller falls
    // back to the single `src` rendition, which is what it renders without this module.
    names = [];
  }
  const listing = new Set(names);
  listings.set(directory, listing);
  return listing;
}

/**
 * The `srcset` candidates for one cover, or an empty list when there is nothing to choose
 * between and the plain `src` should stand alone.
 *
 * A tier file only exists when the base rendition reached the full 720 (see
 * `optimizeCoverVariants`), so the presence of one is also the proof that 720 is the right
 * descriptor for the base. That is what makes the pair safe to describe without measuring the
 * image here: a cover too small for a tier — פיפוש המהפכה's 118px art, or any small scan a
 * future sync picks up — produces no tier file, so it gets no srcset and keeps rendering at
 * its true size on the mat rather than being blown up to fill `sizes`.
 */
export function coverRenditions(cover: string): CoverRendition[] {
  const directory = posix.dirname(cover);
  const file = posix.basename(cover);
  const stem = file.endsWith('.webp') ? file.slice(0, -'.webp'.length) : null;
  if (stem === null) return [];

  const available = filesIn(directory);
  const narrower = NARROW_WIDTHS.flatMap((width) =>
    available.has(`${stem}-${width}.webp`)
      ? [{ path: posix.join(directory, `${stem}-${width}.webp`), width }]
      : [],
  );

  return narrower.length === 0 ? [] : [...narrower, { path: cover, width: BASE_WIDTH }];
}
