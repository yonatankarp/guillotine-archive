import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog } from '../catalog/types';

const nonblankString = z
  .string()
  .refine((value) => value.trim().length > 0);
const exactTrimmedNonblankString = nonblankString.refine((value) => value === value.trim());
const absoluteUrl = exactTrimmedNonblankString.pipe(z.url());
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
const catalogItem = z
  .object({
    id: nonblankString,
    name: nonblankString,
    mimeType: nonblankString,
    size: z.number().nonnegative().nullable(),
    modifiedTime: nonblankString.nullable(),
    path: nonblankString,
    parentIds: z.array(nonblankString),
    viewUrl: absoluteUrl,
    downloadUrl: absoluteUrl.nullable(),
    category: nonblankString,
    titleHe: nonblankString.optional(),
    descriptionHe: nonblankString.optional(),
    aliasesHe: z.array(nonblankString),
    tagsHe: z.array(nonblankString),
    extractedTextHe: z.string().optional(),
    collectionLinks: z.array(collectionLink),
  })
  .strict();
const catalogSchema = z
  .object({
    generatedAt: nonblankString,
    collections: z.array(curatedCollection),
    items: z.array(catalogItem),
    categories: z.array(nonblankString),
  })
  .strict();

export const emptyDevelopmentCatalog: Catalog = {
  generatedAt: '1970-01-01T00:00:00.000Z',
  collections: [],
  items: [],
  categories: [],
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
  import.meta.env.DEV || process.env.NODE_ENV === 'test',
);
export const games = catalog.collections.filter((collection) => collection.type === 'game');
export const itemById = new Map(catalog.items.map((item) => [item.id, item]));
