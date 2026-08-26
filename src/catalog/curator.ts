import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { CuratorConfig } from './types';

const relationshipKindSchema = z.enum(['part-of-release', 'about', 'inspired-by']);
const ruleMatchSchema = z.enum(['path-prefix', 'exact-path', 'file-id']);
const nonblankStringSchema = z.string().refine((value) => value.trim().length > 0);

const curatorRuleSchema = z
  .object({
    match: ruleMatchSchema,
    value: nonblankStringSchema,
    relationship: relationshipKindSchema,
    groupHe: nonblankStringSchema.optional(),
  })
  .strict();

const curatedCollectionSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    titleHe: nonblankStringSchema,
    type: z.enum(['game', 'music', 'press', 'fan', 'archive']),
    year: z.number().int().min(1980).max(2100).optional(),
    summaryHe: nonblankStringSchema,
    descriptionHe: nonblankStringSchema.optional(),
    coverFileId: nonblankStringSchema.optional(),
    aliasesHe: z.array(nonblankStringSchema).default([]),
    tagsHe: z.array(nonblankStringSchema).default([]),
    rules: z.array(curatorRuleSchema).default([]),
    exclude: z.array(curatorRuleSchema).default([]),
  })
  .strict();

const curatorConfigSchema = z
  .object({
    minimumFileCount: z.number().int().positive().default(1),
    collections: z.array(curatedCollectionSchema),
  })
  .strict();

export function parseCurator(source: string): CuratorConfig {
  const config = curatorConfigSchema.parse(parse(source));
  const slugs = new Set<string>();

  for (const collection of config.collections) {
    if (slugs.has(collection.slug)) {
      throw new Error(`duplicate collection slug: ${collection.slug}`);
    }
    slugs.add(collection.slug);
  }

  return config;
}

export async function loadCurator(path: string | URL): Promise<CuratorConfig> {
  return parseCurator(await readFile(path, 'utf8'));
}
