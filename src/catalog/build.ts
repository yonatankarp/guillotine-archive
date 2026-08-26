import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acquireArtifactBuildLock,
  ArtifactTransactionFailure,
  canonicalizeArtifactRoot,
  managedTargetStatus,
  portableTargetKey,
  promoteArtifactTransaction,
  recoverArtifactTransaction,
  staleCoverArtifacts,
  writeDiagnosticReport,
  type Artifact,
  type BuildFaultInjection,
  type ReplaceCaseArtifact,
  type WriteArtifact,
} from './artifact-transaction';
import { extractText, isTextExtractable, optimizeCover } from './media';
import { resolveRelationships } from './relationships';
import { buildSearchIndex } from './search';
import type { Catalog, CuratorConfig, DriveFile } from './types';
import { validateCatalog } from './validate';

const DEFAULT_MAX_EXTRACTED_TEXT_BYTES = 64 * 1024 * 1024;

export type { BuildFaultInjection } from './artifact-transaction';

export interface BuildCatalogInput {
  files: readonly DriveFile[];
  curator: Readonly<CuratorConfig>;
  root: string;
  generatedAt: string;
  minimumFileCount?: number;
  previousFileCount?: number;
  maxExtractedTextBytes?: number;
  /** Test-only filesystem fault injection. Production callers must omit this. */
  faultInjection?: BuildFaultInjection;
  download(fileId: string): Promise<Buffer>;
}

class SafeBuildFailure extends Error {}

function safeBuildFailure(message: string): SafeBuildFailure {
  return new SafeBuildFailure(message);
}

function sanitizeExportedFailure(error: unknown): Error {
  return new Error(
    error instanceof SafeBuildFailure || error instanceof ArtifactTransactionFailure
      ? error.message
      : 'catalog build failed',
  );
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertNonnegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw safeBuildFailure(`${name} must be a nonnegative integer`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw safeBuildFailure(`${name} must be a positive integer`);
  }
}

async function previousCatalogCount(root: string, path: string): Promise<number> {
  if ((await managedTargetStatus(root, path)) === 'missing') return 0;
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw safeBuildFailure('unable to read existing catalog');
  }

  try {
    const parsed: unknown = JSON.parse(source);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('items' in parsed) ||
      !Array.isArray(parsed.items)
    ) {
      throw new Error('items must be an array');
    }
    return parsed.items.length;
  } catch {
    throw safeBuildFailure('existing catalog is malformed');
  }
}

async function extractCatalogText(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  maxExtractedTextBytes: number,
): Promise<void> {
  const extractableItems = catalog.items.filter((item) =>
    isTextExtractable(item.mimeType, item.name, item.size),
  );
  let retainedTextBytes = 0;
  for (let index = 0; index < extractableItems.length; index += 1) {
    const item = extractableItems[index]!;
    try {
      const extractedText = await extractText(
        item.mimeType,
        item.name,
        await input.download(item.id),
      );
      const extractedBytes = Buffer.byteLength(extractedText, 'utf8');
      if (retainedTextBytes + extractedBytes > maxExtractedTextBytes) {
        for (const skipped of extractableItems.slice(index)) skipped.extractedTextHe = '';
        report.warnings.push(
          `${extractableItems.length - index} text files skipped because the extraction budget was exceeded`,
        );
        break;
      }
      item.extractedTextHe = extractedText;
      retainedTextBytes += extractedBytes;
    } catch {
      item.extractedTextHe = '';
      report.warnings.push(`failed to extract text for item ${item.id}`);
    }
  }
}

async function prepareCovers(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  reportPath: string,
): Promise<Map<string, Buffer>> {
  const coverBuffers = new Map<string, Buffer>();
  const coverCollections = new Map<string, string>();
  for (const collection of catalog.collections) {
    if (collection.coverFileId && !coverCollections.has(collection.coverFileId)) {
      coverCollections.set(collection.coverFileId, collection.slug);
    }
  }

  for (const [coverFileId, collectionSlug] of coverCollections) {
    try {
      coverBuffers.set(coverFileId, await optimizeCover(await input.download(coverFileId)));
    } catch {
      const message = `failed to process cover ${coverFileId} for collection ${collectionSlug}`;
      report.errors.push(message);
      await writeDiagnosticReport(input.root, reportPath, report);
      throw safeBuildFailure(message);
    }
  }
  return coverBuffers;
}

function coverWriteArtifacts(
  coverDirectory: string,
  coverBuffers: ReadonlyMap<string, Buffer>,
  remainingStaleCovers: Artifact[],
): Array<WriteArtifact | ReplaceCaseArtifact> {
  return [...coverBuffers].map(([coverFileId, data]) => {
    const target = join(coverDirectory, `${coverFileId}.webp`);
    const portableTarget = portableTargetKey(target);
    const aliasIndexes = remainingStaleCovers.flatMap((candidate, index) =>
      portableTargetKey(candidate.target) === portableTarget ? [index] : [],
    );
    if (aliasIndexes.length === 0) return { kind: 'write', target, data };
    if (aliasIndexes.length > 1) {
      throw new Error('multiple stale covers resolve to one portable target');
    }
    const [alias] = remainingStaleCovers.splice(aliasIndexes[0]!, 1);
    return { kind: 'replace-case', source: alias!.target, target, data };
  });
}

async function buildCatalogWithLock(input: BuildCatalogInput): Promise<Catalog> {
  const catalogPath = join(input.root, 'src/generated/catalog.json');
  const searchPath = join(input.root, 'public/data/search-index.json');
  const reportPath = join(input.root, 'reports/curator-report.json');
  const coverDirectory = join(input.root, 'public/generated/covers');
  await recoverArtifactTransaction(input.root);
  const localPreviousCount = await previousCatalogCount(input.root, catalogPath);
  const persistedPreviousCount = input.previousFileCount ?? 0;
  const maxExtractedTextBytes = input.maxExtractedTextBytes ?? DEFAULT_MAX_EXTRACTED_TEXT_BYTES;
  assertNonnegativeInteger(persistedPreviousCount, 'previousFileCount');
  assertPositiveInteger(maxExtractedTextBytes, 'maxExtractedTextBytes');
  const minimumFileCount = input.minimumFileCount ?? input.curator.minimumFileCount ?? 1;
  assertPositiveInteger(minimumFileCount, 'minimumFileCount');
  const previousCount = Math.max(localPreviousCount, persistedPreviousCount);
  const catalog = resolveRelationships(input.files, input.curator, input.generatedAt);
  const report = validateCatalog(catalog, input.curator, previousCount, minimumFileCount);

  if (report.errors.length > 0) {
    await writeDiagnosticReport(input.root, reportPath, report);
    throw safeBuildFailure(report.errors.join('\n'));
  }

  await extractCatalogText(catalog, report, input, maxExtractedTextBytes);
  const coverBuffers = await prepareCovers(catalog, report, input, reportPath);

  let serializedSearch: string;
  try {
    serializedSearch = buildSearchIndex(catalog);
  } catch {
    const message = 'failed to build search index';
    report.errors.push(message);
    await writeDiagnosticReport(input.root, reportPath, report);
    throw safeBuildFailure(message);
  }

  try {
    const staleCovers = await staleCoverArtifacts(
      input.root,
      coverDirectory,
      new Set(coverBuffers.keys()),
    );
    const remainingStaleCovers: Artifact[] = [...staleCovers];
    const coverArtifacts = coverWriteArtifacts(coverDirectory, coverBuffers, remainingStaleCovers);
    const artifacts: Artifact[] = [
      ...remainingStaleCovers,
      ...coverArtifacts,
      { kind: 'write', target: catalogPath, data: prettyJson(catalog) },
      { kind: 'write', target: searchPath, data: serializedSearch },
      { kind: 'write', target: reportPath, data: prettyJson(report) },
    ];
    await promoteArtifactTransaction(input.root, artifacts, input.faultInjection);
  } catch {
    const message = 'failed to promote archive artifacts';
    report.errors.push(message);
    try {
      await writeDiagnosticReport(input.root, reportPath, report);
    } catch {
      // The deployable transaction is already rolled back; diagnostics are best-effort.
    }
    throw safeBuildFailure(message);
  }

  return catalog;
}

export async function buildCatalog(input: BuildCatalogInput): Promise<Catalog> {
  let releaseLock: (() => Promise<void>) | undefined;
  let buildFailed = false;

  try {
    const root = await canonicalizeArtifactRoot(input.root);
    releaseLock = await acquireArtifactBuildLock(root);
    return await buildCatalogWithLock({ ...input, root });
  } catch (error) {
    buildFailed = true;
    throw sanitizeExportedFailure(error);
  } finally {
    if (releaseLock) {
      try {
        await releaseLock();
      } catch {
        if (!buildFailed) throw new Error('failed to release catalog build lock');
      }
    }
  }
}
