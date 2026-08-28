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
import {
  decodeWithImageMagick,
  extractText,
  imageTiersFor,
  isStreamableVideoContainer,
  isTextExtractable,
  needsExternalDecoder,
  opusBitrateFor,
  optimizeCover,
  optimizeLogo,
  remuxToStreamableMp4,
  resizeImage,
  resolveFfmpeg,
  resolveImageMagick,
  transcodeToMp4,
  transcodeToOpus,
} from './media';
import { resolveRelationships } from './relationships';
import { buildSearchIndex } from './search';
import type {
  Catalog,
  CatalogItem,
  CropRegion,
  CuratorConfig,
  Derivative,
  DriveFile,
  ItemDerivatives,
} from './types';
import { validateCatalog } from './validate';

const DEFAULT_MAX_EXTRACTED_TEXT_BYTES = 64 * 1024 * 1024;
/** One sync pulls roughly 1 GiB of derivative sources; the cap stops a runaway. */
const DEFAULT_MAX_DERIVATIVE_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const IMAGE_DERIVATIVE_KINDS = new Set([
  'cover',
  'scan',
  'booklet-page',
  'comic-page',
  'press-page',
  'sprite',
]);
const AUDIO_DERIVATIVE_KINDS = new Set(['track', 'sound']);
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;

/**
 * Video needs its own budgets because it is bounded at both ends, and neither
 * bound is the shared source budget.
 *
 * The source cap is not a choice: `MAX_DRIVE_DOWNLOAD_BYTES` in
 * `google-drive.ts` refuses any Drive response over 32 MiB, so a larger video
 * cannot be fetched at all and is skipped before a download is attempted. It is
 * restated rather than imported to keep `googleapis` out of the site's build
 * graph. Raising it is a change in that file, not this one.
 *
 * The output caps are the repository's, not Drive's. Every derivative is
 * committed and served from Pages, where a single blob over 100 MiB is rejected
 * outright and the published site is meant to stay under a gigabyte. Images and
 * audio already account for roughly 417 MB of that, so video gets the remaining
 * headroom and nothing beyond it.
 */
const MAX_VIDEO_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_VIDEO_DERIVATIVE_FILE_BYTES = 90 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_DERIVATIVE_BYTES = 400 * 1024 * 1024;

export type { BuildFaultInjection } from './artifact-transaction';

export interface BuildCatalogInput {
  files: readonly DriveFile[];
  curator: Readonly<CuratorConfig>;
  root: string;
  generatedAt: string;
  minimumFileCount?: number;
  previousFileCount?: number;
  maxExtractedTextBytes?: number;
  maxDerivativeSourceBytes?: number;
  /** Total bytes of video derivative the sync may commit. */
  maxVideoDerivativeBytes?: number;
  /** Pulling ~1 GiB of sources is opt-in, so a catalog-only sync stays cheap. */
  buildDerivatives?: boolean;
  /** Test seam for the external decoder and encoder. Production callers omit these. */
  externalTools?: { imageMagick?: string | null; ffmpeg?: string | null };
  /** Fetches a Drive-hosted thumbnail. Defaults to global fetch. */
  fetchThumbnail?(url: string): Promise<Buffer>;
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

const HEBREW_LETTER = /[\u0590-\u05FF]/u;

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

  // A charset mistake destroys Hebrew silently: every letter becomes U+FFFD and
  // the corpus reduces to its ASCII digits, which still looks like a successful
  // extraction. This is a Hebrew archive, so no Hebrew anywhere is a defect.
  const extracted = extractableItems.filter((item) => (item.extractedTextHe ?? '') !== '');
  if (extracted.length > 0 && !extracted.some((item) => HEBREW_LETTER.test(item.extractedTextHe!))) {
    report.warnings.push(
      `extracted text from ${extracted.length} files but found no Hebrew in any of them; suspect a character encoding fault`,
    );
  }
}

async function prepareCovers(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  reportPath: string,
  sourceCache: Map<string, Buffer>,
): Promise<Map<string, Buffer>> {
  const coverBuffers = new Map<string, Buffer>();
  const coverCollections = new Map<string, { slug: string; crop?: CropRegion }>();
  for (const collection of catalog.collections) {
    if (collection.coverFileId && !coverCollections.has(collection.coverFileId)) {
      coverCollections.set(collection.coverFileId, {
        slug: collection.slug,
        ...(collection.coverCrop === undefined ? {} : { crop: collection.coverCrop }),
      });
    }
  }

  for (const [coverFileId, { slug, crop }] of coverCollections) {
    try {
      const source = await input.download(coverFileId);
      sourceCache.set(coverFileId, source);
      coverBuffers.set(coverFileId, await optimizeCover(source, crop));
    } catch {
      const message = `failed to process cover ${coverFileId} for collection ${slug}`;
      report.errors.push(message);
      await writeDiagnosticReport(input.root, reportPath, report);
      throw safeBuildFailure(message);
    }
  }
  return coverBuffers;
}

/**
 * Release titles are hand-drawn box lettering, so a logo is a second crop of the
 * same artwork. The file id lives on the release override; the rectangle lives
 * on the collection, because only that side is reachable from here.
 */
async function prepareLogos(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  sourceCache: Map<string, Buffer>,
): Promise<Map<string, Buffer>> {
  const logoBuffers = new Map<string, Buffer>();
  const logoFileIdBySlug = new Map<string, string>();
  for (const override of input.curator.releases ?? []) {
    if (override.logoFileId === undefined) continue;
    for (const path of override.paths) logoFileIdBySlug.set(path, override.logoFileId);
  }

  for (const collection of catalog.collections) {
    const logoFileId = logoFileIdBySlug.get(collection.slug);
    if (logoFileId === undefined || collection.logoCrop === undefined) continue;
    if (logoBuffers.has(logoFileId)) continue;

    try {
      const source = sourceCache.get(logoFileId) ?? (await input.download(logoFileId));
      sourceCache.set(logoFileId, source);
      logoBuffers.set(logoFileId, await optimizeLogo(source, collection.logoCrop));
      collection.logoUrl = `/generated/logos/${logoFileId}.webp`;
    } catch {
      // A missing logo degrades to the typeface title rather than failing the sync.
      report.warnings.push(`failed to process logo ${logoFileId} for release ${collection.slug}`);
    }
  }
  return logoBuffers;
}

interface DerivativeTools {
  imageMagick: string | null;
  ffmpeg: string | null;
}

interface DerivativePlan {
  artifacts: WriteArtifact[];
  bytes: number;
  /** Counted apart from `bytes`: that budget bounds what is downloaded, this bounds what is committed. */
  videoBytes: number;
}

function derivativeOf(path: string, data: Buffer, width?: number, height?: number): Derivative {
  return {
    path,
    bytes: data.length,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

async function decodeImageSource(
  item: CatalogItem,
  data: Buffer,
  tools: DerivativeTools,
): Promise<Buffer | null> {
  if (!needsExternalDecoder(item.mimeType)) return data;
  if (tools.imageMagick === null) return null;
  return decodeWithImageMagick(data, tools.imageMagick);
}

async function imageDerivatives(
  item: CatalogItem,
  data: Buffer,
  tools: DerivativeTools,
  directory: string,
  plan: DerivativePlan,
): Promise<ItemDerivatives | null> {
  const decoded = await decodeImageSource(item, data, tools);
  if (decoded === null) return null;

  const derivatives: ItemDerivatives = {};
  for (const tier of imageTiersFor(item.kind)) {
    const resized = await resizeImage(decoded, tier.edge);
    const relative = `generated/derivatives/${item.id}-${tier.name}.webp`;
    plan.artifacts.push({
      kind: 'write',
      target: join(directory, `${item.id}-${tier.name}.webp`),
      data: resized.data,
    });
    derivatives[tier.name] = derivativeOf(
      `/${relative}`,
      resized.data,
      resized.width,
      resized.height,
    );
  }
  return derivatives;
}

async function audioDerivative(
  item: CatalogItem,
  data: Buffer,
  tools: DerivativeTools,
  directory: string,
  plan: DerivativePlan,
): Promise<ItemDerivatives | null> {
  if (tools.ffmpeg === null) return null;

  const opus = await transcodeToOpus(data, tools.ffmpeg, opusBitrateFor(item.kind));
  const relative = `generated/derivatives/${item.id}.opus`;
  plan.artifacts.push({ kind: 'write', target: join(directory, `${item.id}.opus`), data: opus });
  return { audio: derivativeOf(`/${relative}`, opus) };
}

/**
 * A video derivative is either kept whole or reported, never quietly truncated,
 * so the size verdict is a value rather than a null the caller has to guess at.
 */
type VideoOutcome =
  | { status: 'built'; derivatives: ItemDerivatives }
  | { status: 'no-encoder' }
  | { status: 'oversized' }
  | { status: 'budget' };

/**
 * An MP4 source is remuxed rather than re-encoded: the frames are already
 * browser-playable and only the index has to move to the front, which costs a
 * file copy instead of minutes of x264. Everything else in this archive is WMV,
 * AVI, MPEG or VOB, which no browser decodes at any size, so it is transcoded.
 *
 * The output is measured after the fact because neither cost is predictable
 * from the source: a long, heavily compressed WMV can grow, and a short one
 * shrinks. An encode that overshoots is discarded rather than committed.
 */
async function videoDerivative(
  item: CatalogItem,
  data: Buffer,
  tools: DerivativeTools,
  directory: string,
  plan: DerivativePlan,
  videoBudget: number,
): Promise<VideoOutcome> {
  if (tools.ffmpeg === null) return { status: 'no-encoder' };

  const mp4 = isStreamableVideoContainer(item.mimeType)
    ? await remuxToStreamableMp4(data, tools.ffmpeg)
    : await transcodeToMp4(data, tools.ffmpeg);

  if (mp4.length > MAX_VIDEO_DERIVATIVE_FILE_BYTES) return { status: 'oversized' };
  if (plan.videoBytes + mp4.length > videoBudget) return { status: 'budget' };

  const relative = `generated/derivatives/${item.id}.mp4`;
  plan.artifacts.push({ kind: 'write', target: join(directory, `${item.id}.mp4`), data: mp4 });
  plan.videoBytes += mp4.length;
  return { status: 'built', derivatives: { video: derivativeOf(`/${relative}`, mp4) } };
}

async function defaultFetchThumbnail(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`thumbnail request failed with ${String(response.status)}`);

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_THUMBNAIL_BYTES) throw new Error('thumbnail too large');
  return data;
}

/**
 * A poster must never cost the 6.4 GB of video bytes. Drive already renders a
 * thumbnail for every video it can decode, so that is the only source used; a
 * video without one keeps its duration and goes posterless.
 */
async function preparePosters(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  directory: string,
): Promise<WriteArtifact[]> {
  if (input.buildDerivatives !== true) return [];

  const fetchThumbnail = input.fetchThumbnail ?? defaultFetchThumbnail;
  const artifacts: WriteArtifact[] = [];
  let missingThumbnail = 0;
  let failed = 0;

  for (const item of catalog.items) {
    if (item.kind !== 'video') continue;

    const durationMillis = item.durationMillis;
    if (durationMillis !== null && durationMillis !== undefined) {
      item.derivatives = { ...item.derivatives, durationMillis };
    }

    if (!item.thumbnailUrl) {
      missingThumbnail += 1;
      continue;
    }

    try {
      const source = await fetchThumbnail(item.thumbnailUrl);
      const resized = await resizeImage(source, 1600);
      const relative = `generated/derivatives/${item.id}-poster.webp`;
      artifacts.push({
        kind: 'write',
        target: join(directory, `${item.id}-poster.webp`),
        data: resized.data,
      });
      item.derivatives = {
        ...item.derivatives,
        poster: derivativeOf(`/${relative}`, resized.data, resized.width, resized.height),
      };
    } catch {
      failed += 1;
    }
  }

  if (missingThumbnail > 0) {
    report.warnings.push(
      `${missingThumbnail} videos have no poster because Drive supplied no thumbnail and video bytes are never downloaded`,
    );
  }
  if (failed > 0) {
    report.warnings.push(`failed to build posters for ${failed} videos`);
  }

  return artifacts;
}

/**
 * Derivatives are additive: every failure degrades one item to its Drive link
 * rather than failing the sync, because the committed site must keep rendering
 * when a tool or a source file is unavailable.
 */
async function prepareDerivatives(
  catalog: Catalog,
  report: ReturnType<typeof validateCatalog>,
  input: BuildCatalogInput,
  directory: string,
  sourceCache: ReadonlyMap<string, Buffer>,
): Promise<WriteArtifact[]> {
  if (input.buildDerivatives !== true) return [];

  const configured = input.externalTools;
  const tools: DerivativeTools = {
    imageMagick:
      configured && 'imageMagick' in configured
        ? (configured.imageMagick ?? null)
        : resolveImageMagick(),
    ffmpeg:
      configured && 'ffmpeg' in configured ? (configured.ffmpeg ?? null) : resolveFfmpeg(),
  };
  const budget = input.maxDerivativeSourceBytes ?? DEFAULT_MAX_DERIVATIVE_SOURCE_BYTES;
  const videoBudget = input.maxVideoDerivativeBytes ?? DEFAULT_MAX_VIDEO_DERIVATIVE_BYTES;
  const plan: DerivativePlan = { artifacts: [], bytes: 0, videoBytes: 0 };
  let skippedForDecoder = 0;
  let skippedForEncoder = 0;
  let failed = 0;
  let exhausted = 0;
  let skippedVideoForEncoder = 0;
  let unreachableVideo = 0;
  let oversizedVideo = 0;
  let exhaustedVideo = 0;

  for (const item of catalog.items) {
    const isImage = IMAGE_DERIVATIVE_KINDS.has(item.kind);
    const isAudio = AUDIO_DERIVATIVE_KINDS.has(item.kind);
    const isVideo = item.kind === 'video';
    if (!isImage && !isAudio && !isVideo) continue;

    if (isImage && needsExternalDecoder(item.mimeType) && tools.imageMagick === null) {
      skippedForDecoder += 1;
      continue;
    }
    if (isAudio && tools.ffmpeg === null) {
      skippedForEncoder += 1;
      continue;
    }
    if (isVideo && tools.ffmpeg === null) {
      skippedVideoForEncoder += 1;
      continue;
    }

    const sourceBytes = item.size ?? 0;
    // Checked before the download, because the download is what would fail.
    if (isVideo && sourceBytes > MAX_VIDEO_SOURCE_BYTES) {
      unreachableVideo += 1;
      continue;
    }
    if (isVideo && plan.videoBytes >= videoBudget) {
      exhaustedVideo += 1;
      continue;
    }
    if (plan.bytes + sourceBytes > budget) {
      exhausted += 1;
      continue;
    }

    try {
      plan.bytes += sourceBytes;
      const data = sourceCache.get(item.id) ?? (await input.download(item.id));
      if (isVideo) {
        const outcome = await videoDerivative(item, data, tools, directory, plan, videoBudget);
        if (outcome.status === 'oversized') oversizedVideo += 1;
        else if (outcome.status === 'budget') exhaustedVideo += 1;
        else if (outcome.status === 'no-encoder') skippedVideoForEncoder += 1;
        else item.derivatives = { ...item.derivatives, ...outcome.derivatives };
        continue;
      }

      const derivatives = isImage
        ? await imageDerivatives(item, data, tools, directory, plan)
        : await audioDerivative(item, data, tools, directory, plan);
      if (derivatives === null) {
        skippedForDecoder += 1;
        continue;
      }
      item.derivatives = derivatives;
    } catch {
      failed += 1;
    }
  }

  if (skippedForDecoder > 0) {
    report.warnings.push(
      `${skippedForDecoder} images have no derivatives because no ImageMagick binary was available to decode them`,
    );
  }
  if (skippedForEncoder > 0) {
    report.warnings.push(
      `${skippedForEncoder} audio files have no derivatives because no ffmpeg binary was available`,
    );
  }
  if (skippedVideoForEncoder > 0) {
    report.warnings.push(
      `${skippedVideoForEncoder} videos have no playable derivative because no ffmpeg binary was available`,
    );
  }
  // Four different reasons a video can go without a derivative, and four
  // different fixes: install ffmpeg, raise the Drive ceiling in
  // google-drive.ts, re-encode that one file by hand, or raise the budget here.
  // Collapsing them into one count would hide which one is actually biting.
  if (unreachableVideo > 0) {
    report.warnings.push(
      `${unreachableVideo} videos skipped because they exceed the ${String(MAX_VIDEO_SOURCE_BYTES / (1024 * 1024))} MiB Drive download ceiling`,
    );
  }
  if (oversizedVideo > 0) {
    report.warnings.push(
      `${oversizedVideo} videos skipped because their derivative exceeded the ${String(MAX_VIDEO_DERIVATIVE_FILE_BYTES / (1024 * 1024))} MiB per-file limit`,
    );
  }
  if (exhaustedVideo > 0) {
    report.warnings.push(
      `${exhaustedVideo} videos skipped because the video derivative budget was exceeded`,
    );
  }
  if (exhausted > 0) {
    report.warnings.push(`${exhausted} files skipped because the derivative source budget was exceeded`);
  }
  if (failed > 0) {
    report.warnings.push(`failed to build derivatives for ${failed} files`);
  }

  return plan.artifacts;
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
  const logoDirectory = join(input.root, 'public/generated/logos');
  const derivativeDirectory = join(input.root, 'public/generated/derivatives');
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
  const sourceCache = new Map<string, Buffer>();
  const coverBuffers = await prepareCovers(catalog, report, input, reportPath, sourceCache);
  const logoBuffers = await prepareLogos(catalog, report, input, sourceCache);
  const derivativeArtifacts = await prepareDerivatives(
    catalog,
    report,
    input,
    derivativeDirectory,
    sourceCache,
  );
  const posterArtifacts = await preparePosters(catalog, report, input, derivativeDirectory);

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
    // Logos and derivatives get no stale sweep on purpose: an empty selected set
    // would delete every one of them, which is exactly how the covers were lost.
    const logoArtifacts: WriteArtifact[] = [...logoBuffers].map(([logoFileId, data]) => ({
      kind: 'write',
      target: join(logoDirectory, `${logoFileId}.webp`),
      data,
    }));
    const artifacts: Artifact[] = [
      ...remainingStaleCovers,
      ...coverArtifacts,
      ...logoArtifacts,
      ...derivativeArtifacts,
      ...posterArtifacts,
      { kind: 'write', target: catalogPath, data: prettyJson(catalog) },
      { kind: 'write', target: searchPath, data: serializedSearch },
      { kind: 'write', target: reportPath, data: prettyJson(report) },
    ];
    // Scale is the first thing worth knowing when a promote fails: with audio and
    // image derivatives every artifact is buffered here before any of it lands.
    const artifactBytes = artifacts.reduce(
      (sum, artifact) => sum + (artifact.kind === 'delete' ? 0 : artifact.data.length),
      0,
    );
    console.log(
      `promoting ${artifacts.length} artifacts, ${(artifactBytes / 1e6).toFixed(1)} MB buffered`,
    );
    await promoteArtifactTransaction(input.root, artifacts, input.faultInjection);
  } catch (error) {
    const message = 'failed to promote archive artifacts';
    report.errors.push(message);
    // The report stays sanitized on purpose: it is uploaded as a downloadable
    // artifact. But this catch used to discard the cause entirely, so run
    // 33060693260 spent 31 minutes to report nothing diagnosable. Send the real
    // cause to the run log, which only repository collaborators can read.
    console.error(
      `promote failure cause: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
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
