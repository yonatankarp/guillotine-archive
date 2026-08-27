import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog } from '../catalog/types';

const nonblankString = z
  .string()
  .refine((value) => value.trim().length > 0);
const exactTrimmedNonblankString = nonblankString.refine((value) => value === value.trim());
const absoluteUrl = exactTrimmedNonblankString.pipe(z.url());
const driveUrl = absoluteUrl.refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com') &&
    url.username === '' &&
    url.password === ''
  );
});
function driveUrlReferencesItem(value: string, itemId: string): boolean {
  const url = new URL(value);
  const pathId = url.pathname.match(/\/d\/([^/]+)/u)?.[1];
  const referencedId =
    pathId === undefined ? url.searchParams.get('id') : decodeURIComponent(pathId);
  return referencedId === itemId;
}
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const relationshipKind = z.enum(['part-of-release', 'about', 'inspired-by']);
const curatorRule = z
  .object({
    match: z.enum(['path-prefix', 'exact-path', 'file-id']),
    value: nonblankString,
    relationship: relationshipKind,
    groupHe: nonblankString.optional(),
  })
  .strict();
const curatedCollection = z
  .object({
    slug,
    titleHe: nonblankString,
    type: z.enum(['game', 'music', 'press', 'fan', 'archive']),
    year: z.number().int().optional(),
    summaryHe: nonblankString,
    descriptionHe: nonblankString.optional(),
    coverFileId: nonblankString.optional(),
    aliasesHe: z.array(nonblankString),
    tagsHe: z.array(nonblankString),
    rules: z.array(curatorRule),
    exclude: z.array(curatorRule),
    coverUrl: exactTrimmedNonblankString.nullable(),
    itemIds: z.array(nonblankString),
  })
  .strict();
const collectionLink = z
  .object({
    slug,
    titleHe: nonblankString,
    relationship: relationshipKind,
    groupHe: nonblankString.optional(),
  })
  .strict();
const itemKind = z.enum([
  'video',
  'track',
  'sound',
  'booklet-page',
  'press-page',
  'comic-page',
  'cover',
  'sprite',
  'scan',
  'build',
  'document',
  'game-data',
  'noise',
  'other',
]);
const releaseType = z.enum([
  'game',
  'demo',
  'fan-disc',
  'audio-cd',
  'video',
  'press',
  'fan-game',
  'other',
]);
const release = z
  .object({
    slug,
    titleHe: nonblankString,
    type: releaseType,
    subjectSlug: slug.nullable(),
    year: z.number().int().optional(),
    formatHe: nonblankString.optional(),
    itemIds: z.array(nonblankString),
    coverFileId: nonblankString.optional(),
    logoFileId: nonblankString.optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
    sourcePaths: z.array(nonblankString),
  })
  .strict();
const releaseFacets = z
  .object({
    types: z.array(releaseType),
    subjectSlugs: z.array(slug),
    years: z.array(z.number().int()),
  })
  .strict();
const catalogItem = z
  .object({
    id: nonblankString,
    name: nonblankString,
    mimeType: nonblankString,
    size: z.number().nonnegative().nullable(),
    modifiedTime: nonblankString.nullable(),
    path: nonblankString,
    viewUrl: driveUrl,
    downloadUrl: driveUrl.nullable(),
    category: nonblankString,
    kind: itemKind,
    releaseSlug: slug,
    titleHe: nonblankString.optional(),
    descriptionHe: nonblankString.optional(),
    aliasesHe: z.array(nonblankString),
    tagsHe: z.array(nonblankString),
    extractedTextHe: z.string().optional(),
    collectionLinks: z.array(collectionLink),
  })
  .strict()
  .refine(
    (item) =>
      driveUrlReferencesItem(item.viewUrl, item.id) &&
      (item.downloadUrl === null || driveUrlReferencesItem(item.downloadUrl, item.id)),
  );
const catalogSchema = z
  .object({
    generatedAt: nonblankString,
    collections: z.array(curatedCollection),
    items: z.array(catalogItem),
    categories: z.array(nonblankString),
    releases: z.array(release),
    releaseFacets: releaseFacets,
  })
  .strict();

export const emptyDevelopmentCatalog: Catalog = {
  generatedAt: '1970-01-01T00:00:00.000Z',
  collections: [],
  items: [],
  categories: [],
  releases: [],
  releaseFacets: { types: [], subjectSlugs: [], years: [] },
};

export function parseCatalog(source: string): Catalog {
  try {
    return catalogSchema.parse(JSON.parse(source));
  } catch {
    throw new Error('generated catalog is invalid');
  }
}

export function loadCatalog(path: string, allowMissing = true): Catalog {
  try {
    return parseCatalog(readFileSync(path, 'utf8'));
  } catch (error) {
    if (
      allowMissing &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return emptyDevelopmentCatalog;
    }
    throw error;
  }
}

export const catalog = loadCatalog(
  resolve('src/generated/catalog.json'),
  import.meta.env?.DEV === true || process.env.NODE_ENV === 'test',
);
export const games = catalog.collections.filter((collection) => collection.type === 'game');
export const itemById = new Map(catalog.items.map((item) => [item.id, item]));
