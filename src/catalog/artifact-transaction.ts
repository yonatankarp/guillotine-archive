import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const MANIFEST_MAX_BYTES = 1024 * 1024;
const MANIFEST_MAX_ENTRIES = 2048;
const STALE_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_PID = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MANIFEST_TEMP_PATTERN =
  /^\.transaction-manifest-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const FIXED_ARTIFACTS = [
  'src/generated/catalog.json',
  'public/data/search-index.json',
  'reports/curator-report.json',
] as const;

export interface BuildFaultInjection {
  failPostCommitCleanup?: boolean;
  failPreCommitRollback?: boolean;
}

/** Test-only recovery interruption hooks. Production callers must omit this. */
export interface RecoveryFaultInjection {
  failStateTransition?: 'committed' | 'rolling-back';
  interruptAfterStateTransition?: 'committed' | 'rolling-back';
  interruptAfterMutation?: number;
}

export interface WriteArtifact {
  kind: 'write';
  target: string;
  data: string | Buffer;
}

export interface DeleteArtifact {
  kind: 'delete';
  target: string;
}

export interface ReplaceCaseArtifact {
  kind: 'replace-case';
  source: string;
  target: string;
  data: string | Buffer;
}

export type Artifact = WriteArtifact | DeleteArtifact | ReplaceCaseArtifact;
type FileState = 'file' | 'missing';

interface FileSnapshot {
  state: FileState;
  stats?: Stats;
}

interface StagedArtifact {
  artifact: Artifact;
  original: FileState;
  stagePath?: string;
  backupPath: string;
}

const nonemptyPathSchema = z.string().min(1);
const originalStateSchema = z.enum(['file', 'missing']);
const transactionEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('write'),
      target: nonemptyPathSchema,
      stage: nonemptyPathSchema,
      backup: nonemptyPathSchema,
      original: originalStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('replace-case'),
      source: nonemptyPathSchema,
      target: nonemptyPathSchema,
      stage: nonemptyPathSchema,
      backup: nonemptyPathSchema,
      original: originalStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('delete'),
      target: nonemptyPathSchema,
      backup: nonemptyPathSchema,
      original: originalStateSchema,
    })
    .strict(),
]);
const transactionManifestSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(['precommit', 'committed', 'rolling-back']),
    transactionId: z.string().regex(UUID_PATTERN),
    entries: z.array(transactionEntrySchema).min(1).max(MANIFEST_MAX_ENTRIES),
  })
  .strict();
type TransactionManifest = z.infer<typeof transactionManifestSchema>;
type SavedEntry = TransactionManifest['entries'][number];

const lockMetadataSchema = z
  .object({
    pid: z.number().int().positive().max(MAX_PID),
    hostname: z.string().min(1).max(255),
    createdAt: z.iso.datetime({ offset: true }),
    transactionId: z.string().regex(UUID_PATTERN),
  })
  .strict();
type LockMetadata = z.infer<typeof lockMetadataSchema>;

export class ArtifactTransactionFailure extends Error {}

function transactionFailure(message: string): ArtifactTransactionFailure {
  return new ArtifactTransactionFailure(message);
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertInsideRoot(root: string, path: string): void {
  const child = relative(root, resolve(path));
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
    return;
  }
  throw new Error('managed path escapes archive root');
}

async function ensureSafeDirectory(
  root: string,
  directory: string,
  create = true,
): Promise<boolean> {
  assertInsideRoot(root, directory);
  const child = relative(root, resolve(directory));
  let current = root;

  for (const component of child === '' ? [] : child.split(sep)) {
    current = join(current, component);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(current);
      status = await lstat(current);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error('managed directory is not a real directory');
    }
  }
  return true;
}

async function pathSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error('managed target is not a regular file');
    return { state: 'file', stats };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
}

async function managedSnapshot(
  root: string,
  target: string,
  createParent = true,
): Promise<FileSnapshot> {
  assertInsideRoot(root, target);
  if (!(await ensureSafeDirectory(root, dirname(target), createParent))) {
    return { state: 'missing' };
  }
  return pathSnapshot(target);
}

export async function managedTargetStatus(root: string, target: string): Promise<FileState> {
  return (await managedSnapshot(root, target)).state;
}

export async function canonicalizeArtifactRoot(root: string): Promise<string> {
  const canonical = await realpath(resolve(root));
  const status = await lstat(canonical);
  if (!status.isDirectory()) throw new Error('archive root is not a directory');
  return canonical;
}

async function removeFile(path: string | undefined): Promise<void> {
  if (path) await rm(path, { force: true });
}

export async function writeDiagnosticReport(
  root: string,
  path: string,
  report: unknown,
): Promise<void> {
  await managedTargetStatus(root, path);
  const transactionId = randomUUID();
  const stagePath = join(dirname(path), `.${basename(path)}.${transactionId}.tmp`);
  const backupPath = join(dirname(path), `.${basename(path)}.${transactionId}.backup`);
  let backedUp = false;
  let installed = false;

  try {
    await managedTargetStatus(root, stagePath);
    if ((await managedTargetStatus(root, backupPath)) !== 'missing') {
      throw new Error('diagnostic backup path already exists');
    }
    await writeFile(stagePath, prettyJson(report), { flag: 'wx' });
    if ((await managedTargetStatus(root, path)) === 'file') {
      await rename(path, backupPath);
      backedUp = true;
    }
    await rename(stagePath, path);
    installed = true;
    await removeFile(backupPath);
    backedUp = false;
  } catch (error) {
    if (installed) await removeFile(path);
    if (backedUp) {
      await rename(backupPath, path);
      backedUp = false;
    }
    throw error;
  } finally {
    await removeFile(stagePath);
    if (!backedUp) await removeFile(backupPath);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new Error('unable to determine catalog build lock owner');
  }
}

function lockTimestampIsReasonable(createdAt: string, now: number): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp <= now + LOCK_CLOCK_SKEW_MS;
}

function lockIsStale(source: string, modifiedAt: number): boolean {
  const now = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return now - modifiedAt > STALE_LOCK_TTL_MS;
  }
  const result = lockMetadataSchema.safeParse(parsed);
  if (!result.success || !lockTimestampIsReasonable(result.data.createdAt, now)) {
    return now - modifiedAt > STALE_LOCK_TTL_MS;
  }
  if (result.data.hostname === hostname()) return !processIsAlive(result.data.pid);
  return now - Date.parse(result.data.createdAt) > STALE_LOCK_TTL_MS;
}

export async function acquireArtifactBuildLock(root: string): Promise<() => Promise<void>> {
  const lockParent = join(root, '.astro');
  const lockPath = join(lockParent, 'catalog-build.lock');
  await ensureSafeDirectory(root, lockParent);
  const transactionId = randomUUID();
  const metadata: LockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
    transactionId,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await managedTargetStatus(root, lockPath)) === 'missing') {
      try {
        await writeFile(lockPath, prettyJson(metadata), { flag: 'wx' });
        return async () => {
          await ensureSafeDirectory(root, lockParent);
          if ((await managedTargetStatus(root, lockPath)) !== 'file') return;
          const current = lockMetadataSchema.parse(
            JSON.parse(await readFile(lockPath, 'utf8')) as unknown,
          );
          if (current.transactionId === transactionId) await removeFile(lockPath);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }

    const lockStatus = await lstat(lockPath);
    if (!lockIsStale(await readFile(lockPath, 'utf8'), lockStatus.mtimeMs)) {
      throw transactionFailure('catalog build already in progress');
    }
    const stalePath = join(lockParent, `.catalog-lock-stale-${randomUUID()}`);
    await managedTargetStatus(root, stalePath);
    await rename(lockPath, stalePath);
    await removeFile(stalePath);
  }
  throw transactionFailure('catalog build already in progress');
}

export function portableTargetKey(path: string): string {
  return resolve(path).normalize('NFC').toLowerCase();
}

export async function staleCoverArtifacts(
  root: string,
  coverDirectory: string,
  selectedCoverIds: ReadonlySet<string>,
): Promise<DeleteArtifact[]> {
  if (!(await ensureSafeDirectory(root, coverDirectory, false))) return [];
  let entries;
  try {
    entries = await readdir(coverDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.webp') &&
        !selectedCoverIds.has(entry.name.slice(0, -'.webp'.length)),
    )
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((entry) => ({
      kind: 'delete',
      target: join(coverDirectory, entry.name),
    }));
}

function transactionManifestPath(root: string): string {
  return join(root, '.astro/catalog-build-transaction.json');
}

function originalPath(artifact: Artifact | SavedEntry): string {
  return artifact.kind === 'replace-case' ? artifact.source : artifact.target;
}

function manifestFromEntries(
  root: string,
  state: TransactionManifest['state'],
  transactionId: string,
  entries: readonly StagedArtifact[],
): TransactionManifest {
  return {
    version: 1,
    state,
    transactionId,
    entries: entries.map((entry) => {
      const target = relative(root, entry.artifact.target);
      const backup = relative(root, entry.backupPath);
      if (entry.artifact.kind === 'replace-case') {
        return {
          kind: 'replace-case',
          source: relative(root, entry.artifact.source),
          target,
          stage: relative(root, entry.stagePath!),
          backup,
          original: entry.original,
        };
      }
      return entry.artifact.kind === 'write'
        ? {
            kind: 'write',
            target,
            stage: relative(root, entry.stagePath!),
            backup,
            original: entry.original,
          }
        : { kind: 'delete', target, backup, original: entry.original };
    }),
  };
}

async function writeTransactionManifest(
  root: string,
  manifest: TransactionManifest,
  failBeforeRename = false,
): Promise<void> {
  const path = transactionManifestPath(root);
  const source = prettyJson(transactionManifestSchema.parse(manifest));
  if (Buffer.byteLength(source) > MANIFEST_MAX_BYTES) {
    throw new Error('transaction manifest is too large');
  }
  await managedTargetStatus(root, path);
  const temporaryPath = join(root, `.astro/.transaction-manifest-${randomUUID()}.tmp`);
  try {
    await managedTargetStatus(root, temporaryPath);
    await writeFile(temporaryPath, source, { flag: 'wx' });
    if (failBeforeRename) throw new Error('injected transaction manifest write failure');
    await rename(temporaryPath, path);
  } finally {
    await removeFile(temporaryPath);
  }
}

function isManagedArtifactTarget(path: string): boolean {
  return (
    FIXED_ARTIFACTS.includes(path as (typeof FIXED_ARTIFACTS)[number]) ||
    /^public\/generated\/covers\/[A-Za-z0-9_-]+\.webp$/u.test(path)
  );
}

function parseTransactionManifest(root: string, source: string): TransactionManifest {
  const manifest = transactionManifestSchema.parse(JSON.parse(source) as unknown);
  const portableTargets = new Set<string>();
  if (manifest.entries.length < FIXED_ARTIFACTS.length)
    throw new Error('transaction manifest is incomplete');
  const coverEntries = manifest.entries.slice(0, -FIXED_ARTIFACTS.length);
  const tail = manifest.entries.slice(-FIXED_ARTIFACTS.length);
  if (
    tail.some(
      (entry, index) => entry.kind !== 'write' || entry.target !== FIXED_ARTIFACTS[index],
    ) ||
    coverEntries.some((entry) => !entry.target.startsWith('public/generated/covers/'))
  ) {
    throw new Error('invalid transaction artifact sequence');
  }
  let coverWritePhaseStarted = false;
  for (const entry of coverEntries) {
    if (entry.kind === 'delete') {
      if (coverWritePhaseStarted) throw new Error('invalid transaction cover phase order');
    } else {
      coverWritePhaseStarted = true;
    }
  }
  for (const [index, entry] of manifest.entries.entries()) {
    if (!isManagedArtifactTarget(entry.target)) throw new Error('invalid transaction target');
    if (entry.kind === 'replace-case' && entry.original !== 'file')
      throw new Error('case-replacement must journal an original file');
    const absoluteTarget = resolve(root, entry.target);
    assertInsideRoot(root, absoluteTarget);
    const portableTarget = portableTargetKey(absoluteTarget);
    if (portableTargets.has(portableTarget)) throw new Error('duplicate transaction target');
    portableTargets.add(portableTarget);
    if (
      entry.kind === 'replace-case' &&
      (!isManagedArtifactTarget(entry.source) ||
        entry.source === entry.target ||
        portableTargetKey(resolve(root, entry.source)) !== portableTarget)
    ) {
      throw new Error('invalid case-replacement source');
    }
    const suffix = `.catalog-transaction-${manifest.transactionId}-${index}`;
    const expectedBackup = relative(root, join(dirname(absoluteTarget), `${suffix}.backup`));
    if (entry.backup !== expectedBackup) throw new Error('invalid transaction backup path');
    if (entry.kind !== 'delete') {
      const expectedStage = relative(root, join(dirname(absoluteTarget), `${suffix}.stage`));
      if (entry.stage !== expectedStage) throw new Error('invalid transaction stage path');
    }
  }
  return manifest;
}

interface RecoverySnapshot {
  saved: SavedEntry;
  target: FileSnapshot;
  source: FileSnapshot;
  stage: FileSnapshot;
  backup: FileSnapshot;
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return Boolean(
    left.stats &&
    right.stats &&
    left.stats.dev === right.stats.dev &&
    left.stats.ino === right.stats.ino,
  );
}

function originalIsPresent(snapshot: RecoverySnapshot): boolean {
  if (snapshot.saved.kind !== 'replace-case') return snapshot.target.state === 'file';
  return (
    snapshot.source.state === 'file' &&
    (snapshot.target.state === 'missing' || sameFile(snapshot.source, snapshot.target))
  );
}

function originalIsMissing(snapshot: RecoverySnapshot): boolean {
  return snapshot.saved.kind === 'replace-case'
    ? snapshot.source.state === 'missing' && snapshot.target.state === 'missing'
    : snapshot.target.state === 'missing';
}

function matchesJournaledOriginal(snapshot: RecoverySnapshot): boolean {
  return snapshot.saved.original === 'file'
    ? originalIsPresent(snapshot)
    : originalIsMissing(snapshot);
}

function matchesStagingState(snapshot: RecoverySnapshot): boolean {
  return snapshot.backup.state === 'missing' && matchesJournaledOriginal(snapshot);
}

function matchesUnprocessedPromotion(snapshot: RecoverySnapshot): boolean {
  return (
    matchesStagingState(snapshot) &&
    (snapshot.saved.kind === 'delete' || snapshot.stage.state === 'file')
  );
}

function matchesInstalled(snapshot: RecoverySnapshot, requireBackup: boolean): boolean {
  const expectedBackup = snapshot.saved.original === 'file' && requireBackup ? 'file' : 'missing';
  if (snapshot.backup.state !== expectedBackup) return false;
  if (snapshot.saved.kind === 'delete') return snapshot.target.state === 'missing';
  if (snapshot.stage.state !== 'missing' || snapshot.target.state !== 'file') return false;
  return (
    snapshot.saved.kind !== 'replace-case' ||
    snapshot.source.state === 'missing' ||
    sameFile(snapshot.source, snapshot.target)
  );
}

function matchesMidPromotion(snapshot: RecoverySnapshot): boolean {
  return (
    snapshot.saved.kind !== 'delete' &&
    snapshot.saved.original === 'file' &&
    snapshot.backup.state === 'file' &&
    snapshot.stage.state === 'file' &&
    originalIsMissing(snapshot)
  );
}

interface RecoveryPlan {
  action: 'rollback' | 'commit';
  processed: ReadonlySet<number>;
  mid?: number;
}

function stagingPlan(snapshots: readonly RecoverySnapshot[]): RecoveryPlan | undefined {
  if (!snapshots.every(matchesStagingState)) return undefined;
  let missingWriteStageSeen = false;
  for (const snapshot of snapshots) {
    if (snapshot.saved.kind === 'delete') continue;
    if (snapshot.stage.state === 'missing') missingWriteStageSeen = true;
    else if (missingWriteStageSeen) return undefined;
  }
  return { action: 'rollback', processed: new Set() };
}

function promotionPlan(snapshots: readonly RecoverySnapshot[]): RecoveryPlan | undefined {
  for (let completed = snapshots.length; completed >= 0; completed -= 1) {
    const processed = new Set(Array.from({ length: completed }, (_, index) => index));
    if (
      snapshots.slice(0, completed).every((snapshot) => matchesInstalled(snapshot, true)) &&
      snapshots.slice(completed).every(matchesUnprocessedPromotion)
    ) {
      return {
        action: completed === snapshots.length ? 'commit' : 'rollback',
        processed,
      };
    }
    if (
      completed < snapshots.length &&
      snapshots.slice(0, completed).every((snapshot) => matchesInstalled(snapshot, true)) &&
      matchesMidPromotion(snapshots[completed]!) &&
      snapshots.slice(completed + 1).every(matchesUnprocessedPromotion)
    ) {
      return { action: 'rollback', processed, mid: completed };
    }
  }
  return undefined;
}

function matchesCommittedCleanup(snapshot: RecoverySnapshot): boolean {
  if (snapshot.saved.kind !== 'delete' && snapshot.stage.state !== 'missing') return false;
  if (snapshot.saved.original === 'missing' && snapshot.backup.state !== 'missing') return false;
  if (snapshot.saved.kind === 'delete') return snapshot.target.state === 'missing';
  if (snapshot.target.state !== 'file') return false;
  return (
    snapshot.saved.kind !== 'replace-case' ||
    snapshot.source.state === 'missing' ||
    sameFile(snapshot.source, snapshot.target)
  );
}

function committedCleanupIsValid(snapshots: readonly RecoverySnapshot[]): boolean {
  let presentBackupSeen = false;
  for (const snapshot of snapshots) {
    if (!matchesCommittedCleanup(snapshot)) return false;
    if (snapshot.saved.original === 'file') {
      if (snapshot.backup.state === 'file') presentBackupSeen = true;
      else if (presentBackupSeen) return false;
    }
  }
  return true;
}

function matchesRollingBack(snapshot: RecoverySnapshot): boolean {
  const { saved } = snapshot;
  if (saved.original === 'missing') {
    if (snapshot.backup.state !== 'missing') return false;
    if (saved.kind === 'delete') return snapshot.target.state === 'missing';
    return !(snapshot.target.state === 'file' && snapshot.stage.state === 'file');
  }

  if (snapshot.backup.state === 'missing') {
    return originalIsPresent(snapshot);
  }
  if (saved.kind === 'delete') return snapshot.target.state === 'missing';
  if (snapshot.target.state === 'file' && snapshot.stage.state === 'file') return false;
  if (saved.kind === 'replace-case' && snapshot.target.state === 'file') {
    return snapshot.source.state === 'missing' || sameFile(snapshot.source, snapshot.target);
  }
  return originalIsMissing(snapshot) || snapshot.target.state === 'file';
}

async function snapshotManifestEntries(
  root: string,
  manifest: TransactionManifest,
): Promise<RecoverySnapshot[]> {
  const snapshots: RecoverySnapshot[] = [];
  for (const saved of manifest.entries) {
    snapshots.push({
      saved,
      target: await managedSnapshot(root, resolve(root, saved.target), false),
      source:
        saved.kind === 'replace-case'
          ? await managedSnapshot(root, resolve(root, saved.source), false)
          : await managedSnapshot(root, resolve(root, saved.target), false),
      stage:
        saved.kind === 'delete'
          ? { state: 'missing' }
          : await managedSnapshot(root, resolve(root, saved.stage), false),
      backup: await managedSnapshot(root, resolve(root, saved.backup), false),
    });
  }
  return snapshots;
}

async function cleanupManifestTemps(root: string): Promise<void> {
  const lockDirectory = join(root, '.astro');
  if (!(await ensureSafeDirectory(root, lockDirectory, false))) return;
  for (const entry of await readdir(lockDirectory, { withFileTypes: true })) {
    if (entry.isFile() && MANIFEST_TEMP_PATTERN.test(entry.name))
      await removeFile(join(lockDirectory, entry.name));
  }
}

interface RecoveryRuntime {
  faultInjection?: RecoveryFaultInjection;
  mutations: number;
}

async function recordRecoveryMutation(runtime: RecoveryRuntime): Promise<void> {
  runtime.mutations += 1;
  if (runtime.faultInjection?.interruptAfterMutation === runtime.mutations) {
    throw new Error('injected recovery interruption');
  }
}

async function removeRecoveryFile(
  root: string,
  path: string,
  runtime: RecoveryRuntime,
): Promise<void> {
  if ((await managedSnapshot(root, path, false)).state === 'file') {
    await removeFile(path);
    await recordRecoveryMutation(runtime);
  }
}

async function renameRecoveryFile(
  source: string,
  target: string,
  runtime: RecoveryRuntime,
): Promise<void> {
  await rename(source, target);
  await recordRecoveryMutation(runtime);
}

async function applyCommittedCleanup(
  root: string,
  snapshots: readonly RecoverySnapshot[],
  runtime: RecoveryRuntime,
): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.saved.kind !== 'delete') {
      await removeRecoveryFile(root, resolve(root, snapshot.saved.stage), runtime);
    }
    await removeRecoveryFile(root, resolve(root, snapshot.saved.backup), runtime);
  }
}

async function applyRollingBack(
  root: string,
  snapshots: readonly RecoverySnapshot[],
  runtime: RecoveryRuntime,
): Promise<void> {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index]!;
    if (snapshot.saved.original === 'file' && snapshot.backup.state === 'file') {
      if (snapshot.saved.kind !== 'delete') {
        await removeRecoveryFile(root, resolve(root, snapshot.saved.target), runtime);
      }
      await renameRecoveryFile(
        resolve(root, snapshot.saved.backup),
        resolve(root, originalPath(snapshot.saved)),
        runtime,
      );
    } else if (snapshot.saved.original === 'missing' && snapshot.saved.kind !== 'delete') {
      await removeRecoveryFile(root, resolve(root, snapshot.saved.target), runtime);
    }
    if (snapshot.saved.kind !== 'delete') {
      await removeRecoveryFile(root, resolve(root, snapshot.saved.stage), runtime);
    }
  }
}

async function readBoundedManifest(root: string, path: string): Promise<string | undefined> {
  const snapshot = await managedSnapshot(root, path, false);
  if (snapshot.state === 'missing') return undefined;
  if (!snapshot.stats || snapshot.stats.size > MANIFEST_MAX_BYTES)
    throw new Error('transaction manifest is too large');
  return readFile(path, 'utf8');
}

async function transitionRecoveryState(
  root: string,
  manifest: TransactionManifest,
  state: 'committed' | 'rolling-back',
  faultInjection?: RecoveryFaultInjection,
): Promise<TransactionManifest> {
  const transitioned = { ...manifest, state } satisfies TransactionManifest;
  await writeTransactionManifest(root, transitioned, faultInjection?.failStateTransition === state);
  if (faultInjection?.interruptAfterStateTransition === state) {
    throw new Error('injected recovery interruption after state transition');
  }
  return transitioned;
}

export async function recoverArtifactTransaction(
  root: string,
  faultInjection?: RecoveryFaultInjection,
): Promise<void> {
  const manifestPath = transactionManifestPath(root);
  const source = await readBoundedManifest(root, manifestPath);
  if (source === undefined) {
    await cleanupManifestTemps(root);
    return;
  }
  let manifest = parseTransactionManifest(root, source);
  const snapshots = await snapshotManifestEntries(root, manifest);
  if (manifest.state === 'precommit') {
    const plan = stagingPlan(snapshots) ?? promotionPlan(snapshots);
    if (!plan) throw new Error('transaction journal does not match physical state');
    manifest = await transitionRecoveryState(
      root,
      manifest,
      plan.action === 'commit' ? 'committed' : 'rolling-back',
      faultInjection,
    );
  }

  if (
    manifest.state === 'committed'
      ? !committedCleanupIsValid(snapshots)
      : !snapshots.every(matchesRollingBack)
  ) {
    throw new Error('transaction journal does not match physical state');
  }

  await cleanupManifestTemps(root);
  const runtime: RecoveryRuntime = { faultInjection, mutations: 0 };
  if (manifest.state === 'committed') {
    await applyCommittedCleanup(root, snapshots, runtime);
  } else {
    await applyRollingBack(root, snapshots, runtime);
  }
  await removeRecoveryFile(root, manifestPath, runtime);
}

async function preflightEntries(
  root: string,
  entries: readonly Omit<StagedArtifact, 'original'>[],
): Promise<FileState[]> {
  const originals: FileState[] = [];
  for (const entry of entries) {
    const original = await managedSnapshot(root, originalPath(entry.artifact), false);
    const target = await managedSnapshot(root, entry.artifact.target, false);
    const backup = await managedSnapshot(root, entry.backupPath, false);
    const stage = entry.stagePath
      ? await managedSnapshot(root, entry.stagePath, false)
      : { state: 'missing' as const };
    if (backup.state !== 'missing' || stage.state !== 'missing')
      throw new Error('transaction workspace is not empty');
    if (
      entry.artifact.kind === 'replace-case' &&
      (original.state !== 'file' || (target.state === 'file' && !sameFile(original, target)))
    ) {
      throw new Error('case-replacement source is ambiguous');
    }
    originals.push(original.state);
  }
  return originals;
}

async function ensureEntryDirectories(
  root: string,
  entries: readonly Omit<StagedArtifact, 'original'>[],
): Promise<void> {
  const directories = new Set<string>();
  for (const entry of entries) {
    directories.add(dirname(entry.artifact.target));
    directories.add(dirname(entry.backupPath));
    if (entry.stagePath) directories.add(dirname(entry.stagePath));
    if (entry.artifact.kind === 'replace-case') directories.add(dirname(entry.artifact.source));
  }
  for (const directory of directories) await ensureSafeDirectory(root, directory);
}

export async function promoteArtifactTransaction(
  root: string,
  artifacts: readonly Artifact[],
  faultInjection?: BuildFaultInjection,
): Promise<void> {
  const transactionId = randomUUID();
  const artifactKeys = new Set<string>();
  for (const artifact of artifacts) {
    const key = portableTargetKey(artifact.target);
    if (artifactKeys.has(key)) throw new Error('portable artifact target collision');
    artifactKeys.add(key);
  }
  const prepared = artifacts.map((artifact, index) => {
    const suffix = `.catalog-transaction-${transactionId}-${index}`;
    return {
      artifact,
      ...(artifact.kind !== 'delete'
        ? { stagePath: join(dirname(artifact.target), `${suffix}.stage`) }
        : {}),
      backupPath: join(dirname(artifact.target), `${suffix}.backup`),
    };
  });
  const initialOriginals = await preflightEntries(root, prepared);
  await ensureEntryDirectories(root, prepared);
  const confirmedOriginals = await preflightEntries(root, prepared);
  if (initialOriginals.some((state, index) => state !== confirmedOriginals[index]))
    throw new Error('artifact state changed during transaction preflight');
  const entries: StagedArtifact[] = prepared.map((entry, index) => ({
    ...entry,
    original: confirmedOriginals[index]!,
  }));
  await writeTransactionManifest(
    root,
    manifestFromEntries(root, 'precommit', transactionId, entries),
  );

  try {
    for (const entry of entries) {
      if (entry.artifact.kind !== 'delete')
        await writeFile(entry.stagePath!, entry.artifact.data, { flag: 'wx' });
    }
    for (const entry of entries) {
      if (entry.original === 'file') {
        await rename(originalPath(entry.artifact), entry.backupPath);
      }
      if (entry.artifact.kind !== 'delete') {
        await rename(entry.stagePath!, entry.artifact.target);
      }
    }
  } catch (error) {
    try {
      await recoverArtifactTransaction(
        root,
        faultInjection?.failPreCommitRollback
          ? { interruptAfterStateTransition: 'rolling-back' }
          : undefined,
      );
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'artifact promotion and rollback failed');
    }
    throw error;
  }

  try {
    await writeTransactionManifest(
      root,
      manifestFromEntries(root, 'committed', transactionId, entries),
    );
  } catch {
    return;
  }
  if (faultInjection?.failPostCommitCleanup) return;
  try {
    await recoverArtifactTransaction(root);
  } catch {
    // Installation is the commit point; the committed journal supports later cleanup.
  }
}
