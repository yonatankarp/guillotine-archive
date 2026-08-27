import type { Catalog, CuratorConfig } from './types';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  unclassifiedIds: string[];
}

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const reported = new Set<string>();
  const duplicates: string[] = [];

  for (const value of values) {
    if (seen.has(value) && !reported.has(value)) {
      reported.add(value);
      duplicates.push(value);
    }
    seen.add(value);
  }

  return duplicates;
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function selectorKey(match: string, value: string): string {
  return JSON.stringify([match, value]);
}

export function validateCatalog(
  catalog: Readonly<Catalog>,
  curator: Readonly<CuratorConfig>,
  previousCount = 0,
  minimumFileCount = curator.minimumFileCount ?? 1,
): ValidationReport {
  assertNonnegativeInteger(previousCount, 'previousCount');
  assertPositiveInteger(minimumFileCount, 'minimumFileCount');

  const errors: string[] = [];
  const fileCount = catalog.items.length;

  if (fileCount === 0) {
    errors.push('archive contains no files');
  } else if (fileCount < minimumFileCount) {
    errors.push(`archive contains ${fileCount} files; expected at least ${minimumFileCount}`);
  }

  if (previousCount >= 20 && fileCount < previousCount / 2) {
    errors.push(`archive shrank unexpectedly from ${previousCount} to ${fileCount} files`);
  }

  for (const id of duplicateValues(catalog.items.map(({ id }) => id))) {
    errors.push(`duplicate Drive item ID: ${id}`);
  }
  for (const slug of duplicateValues(curator.collections.map(({ slug }) => slug))) {
    errors.push(`duplicate curator collection slug: ${slug}`);
  }
  for (const slug of duplicateValues(catalog.collections.map(({ slug }) => slug))) {
    errors.push(`duplicate catalog collection slug: ${slug}`);
  }

  const collectionSlugs = new Set(catalog.collections.map(({ slug }) => slug));
  const itemIds = new Set(catalog.items.map(({ id }) => id));
  const coverIdsByPortableTarget = new Map<string, string>();

  for (const fileId of Object.keys(curator.files ?? {})) {
    if (!itemIds.has(fileId)) {
      errors.push(`file metadata override references missing Drive item ID: ${fileId}`);
    }
  }

  for (const item of catalog.items) {
    const relationshipsBySlug = new Map<string, Set<string>>();

    for (const link of item.collectionLinks) {
      if (!collectionSlugs.has(link.slug)) {
        errors.push(`item ${item.id} links to unknown collection: ${link.slug}`);
      }

      const relationships = relationshipsBySlug.get(link.slug) ?? new Set<string>();
      relationships.add(link.relationship);
      relationshipsBySlug.set(link.slug, relationships);
    }

    for (const [slug, relationships] of relationshipsBySlug) {
      if (relationships.size > 1) {
        errors.push(
          `item ${item.id} has contradictory relationships to collection ${slug}: ${[
            ...relationships,
          ]
            .sort()
            .join(', ')}`,
        );
      }
    }
  }

  for (const collection of catalog.collections) {
    for (const itemId of collection.itemIds) {
      if (!itemIds.has(itemId)) {
        errors.push(`collection ${collection.slug} references unknown item ID: ${itemId}`);
      }
    }
  }

  for (const slug of duplicateValues(catalog.releases.map(({ slug }) => slug))) {
    errors.push(`duplicate release slug: ${slug}`);
  }

  const releaseSlugs = new Set(catalog.releases.map(({ slug }) => slug));
  const owners = new Map<string, string>();

  for (const release of catalog.releases) {
    if (release.subjectSlug !== null && !collectionSlugs.has(release.subjectSlug)) {
      errors.push(`release ${release.slug} names an unknown subject: ${release.subjectSlug}`);
    }

    for (const itemId of release.itemIds) {
      if (!itemIds.has(itemId)) {
        errors.push(`release ${release.slug} references unknown item ID: ${itemId}`);
        continue;
      }

      const owner = owners.get(itemId);

      if (owner !== undefined) {
        errors.push(
          `item ${itemId} must belong to exactly one release, but belongs to ${owner} and ${release.slug}`,
        );
        continue;
      }
      owners.set(itemId, release.slug);
    }
  }

  for (const item of catalog.items) {
    if (!releaseSlugs.has(item.releaseSlug)) {
      errors.push(`item ${item.id} names an unknown release: ${item.releaseSlug}`);
      continue;
    }

    const owner = owners.get(item.id);

    if (owner === undefined) {
      errors.push(`item ${item.id} belongs to no release: ${item.path}`);
    } else if (owner !== item.releaseSlug) {
      errors.push(
        `item ${item.id} names release ${item.releaseSlug} but is listed under ${owner}`,
      );
    }
  }

  for (const release of catalog.releases) {
    if (release.coverFileId !== undefined && !itemIds.has(release.coverFileId)) {
      errors.push(`release ${release.slug} cover file is missing: ${release.coverFileId}`);
    }
    if (release.logoFileId !== undefined && !itemIds.has(release.logoFileId)) {
      errors.push(`release ${release.slug} logo file is missing: ${release.logoFileId}`);
    }
  }

  for (const collection of curator.collections) {
    const excludedSelectors = new Set(
      collection.exclude.map(({ match, value }) => selectorKey(match, value)),
    );
    const reportedContradictions = new Set<string>();
    for (const rule of collection.rules) {
      const key = selectorKey(rule.match, rule.value);
      if (!excludedSelectors.has(key) || reportedContradictions.has(key)) continue;
      reportedContradictions.add(key);
      errors.push(
        `collection ${collection.slug} has contradictory include/exclude selector: ${rule.match} ${rule.value}`,
      );
    }

    if (collection.coverFileId) {
      if (!/^[A-Za-z0-9_-]+$/u.test(collection.coverFileId)) {
        errors.push(
          `collection ${collection.slug} has invalid cover file ID: ${collection.coverFileId}`,
        );
      } else {
        const portableTarget = collection.coverFileId.normalize('NFC').toLowerCase();
        const existingCoverId = coverIdsByPortableTarget.get(portableTarget);
        if (existingCoverId && existingCoverId !== collection.coverFileId) {
          errors.push(
            `cover file IDs resolve to the same portable target: ${existingCoverId}, ${collection.coverFileId}`,
          );
        } else {
          coverIdsByPortableTarget.set(portableTarget, collection.coverFileId);
        }
        const cover = catalog.items.find(({ id }) => id === collection.coverFileId);
        if (!cover) {
          errors.push(
            `collection ${collection.slug} cover file is missing: ${collection.coverFileId}`,
          );
        } else if (!cover.mimeType.toLowerCase().startsWith('image/')) {
          errors.push(
            `collection ${collection.slug} cover file is not an image: ${collection.coverFileId}`,
          );
        }
      }
    }

    for (const [context, rules] of [
      ['rule', collection.rules],
      ['exclude', collection.exclude],
    ] as const) {
      const reported = new Set<string>();
      for (const rule of rules) {
        if (rule.match !== 'file-id' || itemIds.has(rule.value) || reported.has(rule.value)) {
          continue;
        }
        reported.add(rule.value);
        errors.push(
          `collection ${collection.slug} ${context} references missing file ID: ${rule.value}`,
        );
      }
    }
  }

  const unclassifiedIds = catalog.items
    .filter(({ collectionLinks }) => collectionLinks.length === 0)
    .map(({ id }) => id);
  const warnings =
    unclassifiedIds.length === 0
      ? []
      : [`${unclassifiedIds.length} files are not linked to a curated collection`];

  return {
    errors: uniqueValues(errors),
    warnings: uniqueValues(warnings),
    unclassifiedIds,
  };
}
