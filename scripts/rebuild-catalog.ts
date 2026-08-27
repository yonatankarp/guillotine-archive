import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCurator } from '../src/catalog/curator';
import { resolveRelationships } from '../src/catalog/relationships';
import type { Catalog, CatalogItem, DriveFile } from '../src/catalog/types';

/**
 * Rebuilds the committed catalog from its own raw Drive fields.
 *
 * Curator edits and classification changes otherwise need a full Drive sync to
 * appear, which is ~30 minutes of CI and needs credentials this machine does not
 * have. Every derived field is a pure function of the raw fields plus the curator
 * config, so they can be recomputed offline: feeding `resolveRelationships`
 * nothing but the raw fields reproduces the committed catalog exactly.
 *
 * Extracted text, cover URLs and derivatives DO need Drive downloads, so they are
 * carried across by item id rather than recomputed. This is not a substitute for
 * a sync: it cannot see files added or removed in Drive.
 */

const repositoryRoot = resolve(import.meta.dirname, '..');

/**
 * Only the fields `scanDrive` produces. Everything else is derived.
 *
 * `thumbnailUrl` and `durationMillis` are optional on `DriveFile` and come from Drive
 * metadata, so they cannot be recomputed offline and must be forwarded here. Omitting
 * them silently stripped the thumbnail from 854 items on a rebuild, which a curator edit
 * would then have committed.
 */
function rawDriveFields(item: CatalogItem): DriveFile {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    modifiedTime: item.modifiedTime,
    path: item.path,
    viewUrl: item.viewUrl,
    downloadUrl: item.downloadUrl,
    ...(item.thumbnailUrl === undefined ? {} : { thumbnailUrl: item.thumbnailUrl }),
    ...(item.durationMillis === undefined ? {} : { durationMillis: item.durationMillis }),
  };
}

interface CarriedFields {
  extractedTextHe?: string;
  derivatives?: CatalogItem['derivatives'];
}

function carriedFields(item: CatalogItem): CarriedFields {
  return {
    ...(item.extractedTextHe === undefined ? {} : { extractedTextHe: item.extractedTextHe }),
    ...(item.derivatives === undefined ? {} : { derivatives: item.derivatives }),
  };
}

export interface RebuildResult {
  itemCount: number;
  releaseCount: number;
  carriedTextCount: number;
}

export async function rebuildCatalog(root = repositoryRoot): Promise<RebuildResult> {
  const catalogPath = resolve(root, 'src/generated/catalog.json');
  const previous = JSON.parse(await readFile(catalogPath, 'utf8')) as Catalog;
  const curator = await loadCurator(resolve(root, 'curator/collections.yml'));

  const carried = new Map(previous.items.map((item) => [item.id, carriedFields(item)]));
  const rebuilt = resolveRelationships(
    previous.items.map(rawDriveFields),
    curator,
    previous.generatedAt,
  );

  for (const item of rebuilt.items) {
    Object.assign(item, carried.get(item.id) ?? {});
  }

  // The collections carry cover and logo URLs that only a sync can produce.
  const urlsBySlug = new Map(
    previous.collections.map((collection) => [
      collection.slug,
      { coverUrl: collection.coverUrl, logoUrl: collection.logoUrl },
    ]),
  );
  for (const collection of rebuilt.collections) {
    const urls = urlsBySlug.get(collection.slug);
    if (urls === undefined) continue;
    collection.coverUrl = urls.coverUrl;
    if (urls.logoUrl !== undefined) collection.logoUrl = urls.logoUrl;
  }

  await writeFile(catalogPath, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8');

  return {
    itemCount: rebuilt.items.length,
    releaseCount: rebuilt.releases.length,
    carriedTextCount: rebuilt.items.filter((item) => (item.extractedTextHe ?? '') !== '').length,
  };
}

function isDirectInvocation(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(moduleUrl);
}

if (isDirectInvocation(import.meta.url)) {
  rebuildCatalog()
    .then(({ itemCount, releaseCount, carriedTextCount }) => {
      console.log(
        `catalog rebuilt: ${itemCount} items, ${releaseCount} releases, ${carriedTextCount} with extracted text`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'catalog rebuild failed');
      process.exitCode = 1;
    });
}
