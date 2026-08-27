import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog as defaultBuildCatalog } from '../src/catalog/build';
import { loadCurator as defaultLoadCurator } from '../src/catalog/curator';
import { scanDrive as defaultScanDrive, type DriveGateway } from '../src/catalog/drive-gateway';
import { createGoogleDriveGateway } from '../src/catalog/google-drive';
import type { Catalog } from '../src/catalog/types';

const BASELINE_DIRECTORY = '.astro';
const BASELINE_FILENAME = 'archive-baseline.json';
const MAX_BASELINE_BYTES = 4096;
const repositoryRoot = resolve(import.meta.dirname, '..');

interface BaselineDocument {
  version: 1;
  fileCount: number;
}

export interface ArchiveBaselineFaultInjection {
  beforeWrite?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
}

export interface SyncDriveOptions {
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
  generatedAt?: string;
  log?: (message: string) => void;
}

export interface SyncDriveDependencies {
  createGateway?: (credentialsJson: string) => DriveGateway;
  scanDrive?: typeof defaultScanDrive;
  loadCurator?: typeof defaultLoadCurator;
  buildCatalog?: typeof defaultBuildCatalog;
  readBaseline?: typeof readArchiveBaseline;
  writeBaseline?: typeof writeArchiveBaselineAtomically;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function assertSafeFileCount(fileCount: number): void {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new Error('fileCount must be a nonnegative safe integer');
  }
}

async function baselineDirectory(root: string, create: boolean): Promise<string | null> {
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, BASELINE_DIRECTORY);
  let status;
  try {
    status = await lstat(directory);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    if (!create) return null;
    await mkdir(directory, { mode: 0o700 });
    status = await lstat(directory);
  }

  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe directory');
  if ((await realpath(directory)) !== directory) throw new Error('unsafe directory');
  return directory;
}

function parseBaseline(source: string): BaselineDocument {
  const parsed: unknown = JSON.parse(source);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('fileCount' in parsed) ||
    typeof parsed.fileCount !== 'number' ||
    !Number.isSafeInteger(parsed.fileCount) ||
    parsed.fileCount < 0
  ) {
    throw new Error('invalid baseline');
  }
  return { version: 1, fileCount: parsed.fileCount };
}

export async function readArchiveBaseline(root: string): Promise<number> {
  try {
    const directory = await baselineDirectory(root, false);
    if (directory === null) return 0;
    const path = join(directory, BASELINE_FILENAME);
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return 0;
      throw error;
    }
    if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_BASELINE_BYTES) {
      throw new Error('invalid baseline');
    }

    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStatus = await handle.stat();
      if (!openedStatus.isFile() || openedStatus.size > MAX_BASELINE_BYTES) {
        throw new Error('invalid baseline');
      }
      const source = await handle.readFile('utf8');
      return parseBaseline(source).fileCount;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error('archive baseline is invalid');
  }
}

async function assertReplaceableBaseline(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error('unsafe baseline');
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

export async function writeArchiveBaselineAtomically(
  root: string,
  fileCount: number,
  faultInjection: ArchiveBaselineFaultInjection = {},
): Promise<void> {
  assertSafeFileCount(fileCount);
  let temporaryPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    const directory = await baselineDirectory(root, true);
    if (directory === null) throw new Error('unable to create baseline directory');
    const target = join(directory, BASELINE_FILENAME);
    await assertReplaceableBaseline(target);
    temporaryPath = join(
      directory,
      `.archive-baseline.${process.pid}.${randomUUID()}.tmp`,
    );
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await faultInjection.beforeWrite?.();
    await handle.writeFile(`${JSON.stringify({ version: 1, fileCount })}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await faultInjection.beforeRename?.();
    await assertReplaceableBaseline(target);
    await rename(temporaryPath, target);
    temporaryPath = undefined;
  } catch {
    throw new Error('unable to update archive baseline');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The public failure is intentionally generic; cleanup continues below.
      }
    }
    if (temporaryPath) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The target baseline remains untouched even if best-effort temp cleanup fails.
      }
    }
  }
}

export async function syncDrive(
  options: SyncDriveOptions = {},
  dependencies: SyncDriveDependencies = {},
): Promise<Catalog> {
  const env = options.env ?? process.env;
  const credentialsJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const rootFolderId = env.GOOGLE_DRIVE_FOLDER_ID;
  if (!credentialsJson?.trim()) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  if (!rootFolderId?.trim()) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required');

  const root = options.root ?? repositoryRoot;
  const createGateway = dependencies.createGateway ?? createGoogleDriveGateway;
  const scanDrive = dependencies.scanDrive ?? defaultScanDrive;
  const loadCurator = dependencies.loadCurator ?? defaultLoadCurator;
  const buildCatalog = dependencies.buildCatalog ?? defaultBuildCatalog;
  const readBaseline = dependencies.readBaseline ?? readArchiveBaseline;
  const writeBaseline = dependencies.writeBaseline ?? writeArchiveBaselineAtomically;
  const gateway = createGateway(credentialsJson);
  const files = await scanDrive(rootFolderId, gateway);
  const curator = await loadCurator(resolve(root, 'curator/collections.yml'));
  const previousFileCount = await readBaseline(root);
  const catalog = await buildCatalog({
    files,
    curator,
    root,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    previousFileCount,
    // A real Drive sync is the only place worth pulling derivative sources.
    buildDerivatives: true,
    download: gateway.download,
  });
  await writeBaseline(root, catalog.items.length);

  (options.log ?? console.log)(`Drive sync complete: ${catalog.items.length} files`);
  return catalog;
}

function isDirectInvocation(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(moduleUrl);
}

export async function main(): Promise<void> {
  await syncDrive();
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Drive sync failed');
    process.exitCode = 1;
  });
}
