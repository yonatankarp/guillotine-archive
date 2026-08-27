import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { CuratorConfig } from './types';

const relationshipKindSchema = z.enum(['part-of-release', 'about', 'inspired-by']);
const ruleMatchSchema = z.enum(['path-prefix', 'exact-path', 'file-id']);
const nonblankStringSchema = z.string().refine((value) => value.trim().length > 0);
const driveFileIdSchema = z
  .string()
  .regex(/^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9_-]+$/u);

const curatedFileMetadataSchema = z
  .object({
    titleHe: nonblankStringSchema.optional(),
    descriptionHe: nonblankStringSchema.optional(),
    aliasesHe: z.array(nonblankStringSchema).optional(),
    tagsHe: z.array(nonblankStringSchema).optional(),
  })
  .strict();

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

const releaseSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const releaseOverrideSchema = z
  .object({
    paths: z.array(nonblankStringSchema).min(1),
    slug: releaseSlugSchema.optional(),
    titleHe: nonblankStringSchema.optional(),
    type: z
      .enum(['game', 'demo', 'fan-disc', 'audio-cd', 'video', 'press', 'fan-game', 'other'])
      .optional(),
    subjectSlug: releaseSlugSchema.nullable().optional(),
    year: z.number().int().min(1980).max(2100).optional(),
    formatHe: nonblankStringSchema.optional(),
    coverFileId: driveFileIdSchema.optional(),
    logoFileId: driveFileIdSchema.optional(),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u).optional(),
  })
  .strict();

const curatorConfigSchema = z
  .object({
    minimumFileCount: z.number().int().positive().default(1),
    files: z.record(driveFileIdSchema, curatedFileMetadataSchema).default({}),
    collections: z.array(curatedCollectionSchema),
    releases: z.array(releaseOverrideSchema).optional(),
  })
  .strict();

export function parseCurator(source: string): CuratorConfig {
  const parsed: unknown = parse(source);
  // Check raw keys because object reconstruction can otherwise lose the special __proto__ key.
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'files' in parsed &&
    typeof parsed.files === 'object' &&
    parsed.files !== null
  ) {
    for (const fileId of Object.keys(parsed.files)) driveFileIdSchema.parse(fileId);
  }
  const config = curatorConfigSchema.parse(parsed);
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
