import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  promoteArtifactTransaction,
  recoverArtifactTransaction,
} from '../../src/catalog/artifact-transaction';

const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const MANIFEST_MAX_ENTRIES = 8192;

/**
 * A real sync with image and audio derivatives promoted 2809 entries and was
 * rejected by a 2048 cap after 31 minutes of work. Keep headroom above the
 * measured requirement.
 */
const MEASURED_FULL_SYNC_ENTRIES = 2809;
const TRANSACTION_ID = '123e4567-e89b-42d3-a456-426614174000';
const temporaryDirectories: string[] = [];

type OriginalState = 'file' | 'missing';

interface SavedWrite {
  kind: 'write';
  target: string;
  stage: string;
  backup: string;
  original: OriginalState;
}

interface SavedDelete {
  kind: 'delete';
  target: string;
  backup: string;
  original: OriginalState;
}

interface SavedReplaceCase {
  kind: 'replace-case';
  source: string;
  target: string;
  stage: string;
  backup: string;
  original: OriginalState;
}

type SavedEntry = SavedWrite | SavedDelete | SavedReplaceCase;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guillotine-transaction-'));
  temporaryDirectories.push(root);
  return root;
}

function derivedPath(target: string, index: number, suffix: 'stage' | 'backup'): string {
  return join(dirname(target), `.catalog-transaction-${TRANSACTION_ID}-${index}.${suffix}`);
}

function writeEntry(target: string, index: number, original: OriginalState = 'file'): SavedWrite {
  return {
    kind: 'write',
    target,
    stage: derivedPath(target, index, 'stage'),
    backup: derivedPath(target, index, 'backup'),
    original,
  };
}

function deleteEntry(target: string, index: number, original: OriginalState = 'file'): SavedDelete {
  return {
    kind: 'delete',
    target,
    backup: derivedPath(target, index, 'backup'),
    original,
  };
}

function replaceCaseEntry(
  source: string,
  target: string,
  index: number,
  original: OriginalState = 'file',
): SavedReplaceCase {
  return {
    kind: 'replace-case',
    source,
    target,
    stage: derivedPath(target, index, 'stage'),
    backup: derivedPath(target, index, 'backup'),
    original,
  };
}

function fixedEntries(offset = 0, original: OriginalState = 'file'): SavedWrite[] {
  return [
    writeEntry('src/generated/catalog.json', offset, original),
    writeEntry('public/data/search-index.json', offset + 1, original),
    writeEntry('reports/curator-report.json', offset + 2, original),
  ];
}

async function writeRelative(root: string, path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents, 'utf8');
}

async function writeManifest(
  root: string,
  entries: SavedEntry[],
  state: 'precommit' | 'committed' = 'precommit',
  exactBytes?: number,
): Promise<void> {
  const manifest = JSON.stringify({
    version: 1,
    state,
    transactionId: TRANSACTION_ID,
    entries,
  });
  if (exactBytes !== undefined && Buffer.byteLength(manifest) > exactBytes) {
    throw new Error('manifest fixture exceeds requested size');
  }
  const source = exactBytes === undefined ? manifest : manifest.padEnd(exactBytes, ' ');
  await writeRelative(root, '.astro/catalog-build-transaction.json', source);
}

async function createOriginals(root: string, entries: readonly SavedEntry[]): Promise<void> {
  for (const entry of entries) {
    const originalPath = entry.kind === 'replace-case' ? entry.source : entry.target;
    if (entry.original === 'file') {
      await writeRelative(root, originalPath, `OLD ${originalPath}`);
    }
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function snapshotRelativeFiles(
  root: string,
  paths: readonly string[],
): Promise<Map<string, string | undefined>> {
  return new Map(
    await Promise.all(
      paths.map(async (path) => {
        try {
          return [path, await readFile(join(root, path), 'utf8')] as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [path, undefined] as const;
          }
          throw error;
        }
      }),
    ),
  );
}

async function expectRelativeFiles(
  root: string,
  snapshot: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  for (const [path, contents] of snapshot) {
    if (contents === undefined) await expectMissing(join(root, path));
    else expect(await readFile(join(root, path), 'utf8')).toBe(contents);
  }
}

function entryPaths(entries: readonly SavedEntry[]): string[] {
  return entries.flatMap((entry) => [
    entry.target,
    entry.backup,
    ...(entry.kind === 'delete' ? [] : [entry.stage]),
  ]);
}

describe('artifact transaction recovery', () => {
  test('journals every original state before staging artifacts', async () => {
    const root = await temporaryRoot();
    const targets = [
      'src/generated/catalog.json',
      'public/data/search-index.json',
      'reports/curator-report.json',
    ];
    await writeRelative(root, targets[0]!, 'OLD CATALOG');

    await promoteArtifactTransaction(
      root,
      targets.map((target) => ({
        kind: 'write' as const,
        target: join(root, target),
        data: 'NEW',
      })),
      { failPostCommitCleanup: true },
    );

    const manifest = JSON.parse(
      await readFile(join(root, '.astro/catalog-build-transaction.json'), 'utf8'),
    ) as { entries: Array<{ original: OriginalState }> };
    expect(manifest.entries.map(({ original }) => original)).toEqual([
      'file',
      'missing',
      'missing',
    ]);
  });

  test('recovers an interrupted sequential staging pass without touching originals', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    await writeRelative(root, entries[0]!.stage, 'NEW CATALOG');
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`OLD ${entry.target}`);
      await expectMissing(join(root, entry.stage));
    }
    await expectMissing(join(root, '.astro/catalog-build-transaction.json'));
  });

  test('fails closed when a later stage exists without the earlier sequential stages', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    await writeRelative(root, entries[2]!.stage, 'NEW REPORT');
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).rejects.toThrow();

    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`OLD ${entry.target}`);
    }
    expect(await readFile(join(root, entries[2]!.stage), 'utf8')).toBe('NEW REPORT');
  });

  test('recovers a crash after backup and before installation', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await writeRelative(root, entry.stage, `NEW ${entry.target}`);
    }
    await rename(join(root, entries[0]!.target), join(root, entries[0]!.backup));
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`OLD ${entry.target}`);
      await expectMissing(join(root, entry.stage));
      await expectMissing(join(root, entry.backup));
    }
  });

  test('rolls back a valid partial sequential promotion', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await writeRelative(root, entry.stage, `NEW ${entry.target}`);
    }
    await rename(join(root, entries[0]!.target), join(root, entries[0]!.backup));
    await rename(join(root, entries[0]!.stage), join(root, entries[0]!.target));
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`OLD ${entry.target}`);
      await expectMissing(join(root, entry.stage));
      await expectMissing(join(root, entry.backup));
    }
  });

  test('removes a no-backup target only when sequential state proves it was installed', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries(0, 'missing');
    await writeRelative(root, entries[0]!.target, 'NEW CATALOG');
    await writeRelative(root, entries[1]!.stage, 'NEW SEARCH');
    await writeRelative(root, entries[2]!.stage, 'NEW REPORT');
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    for (const entry of entries) {
      await expectMissing(join(root, entry.target));
      await expectMissing(join(root, entry.stage));
    }
  });

  test('treats an all-installed precommit journal as committed', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await rename(join(root, entry.target), join(root, entry.backup));
      await writeRelative(root, entry.target, `NEW ${entry.target}`);
    }
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`NEW ${entry.target}`);
      await expectMissing(join(root, entry.backup));
    }
  });

  test('resumes inferred-commit cleanup after every interrupted mutation', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await rename(join(root, entry.target), join(root, entry.backup));
      await writeRelative(root, entry.target, `NEW ${entry.target}`);
    }
    await writeManifest(root, entries);

    let interruptions = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await recoverArtifactTransaction(root, { interruptAfterMutation: 1 });
        break;
      } catch {
        interruptions += 1;
      }
    }
    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    expect(interruptions).toBe(entries.length + 1);
    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`NEW ${entry.target}`);
      await expectMissing(join(root, entry.backup));
    }
    await expectMissing(join(root, '.astro/catalog-build-transaction.json'));
  });

  test('rejects a committed journal with a surviving write stage before cleanup', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await rename(join(root, entry.target), join(root, entry.backup));
      await writeRelative(root, entry.target, `NEW ${entry.target}`);
    }
    await writeRelative(root, entries[1]!.stage, 'IMPOSSIBLE STAGE');
    await writeManifest(root, entries, 'committed');
    const before = await snapshotRelativeFiles(root, entryPaths(entries));

    await expect(recoverArtifactTransaction(root)).rejects.toThrow();

    await expectRelativeFiles(root, before);
  });

  test('rejects non-prefix committed backup cleanup across mixed original states', async () => {
    const root = await temporaryRoot();
    const entries = [
      writeEntry('src/generated/catalog.json', 0, 'file'),
      writeEntry('public/data/search-index.json', 1, 'missing'),
      writeEntry('reports/curator-report.json', 2, 'file'),
    ];
    await createOriginals(root, entries);
    for (const entry of entries) {
      if (entry.original === 'file') {
        await rename(join(root, entry.target), join(root, entry.backup));
      }
      await writeRelative(root, entry.target, `NEW ${entry.target}`);
    }
    await rm(join(root, entries[2]!.backup));
    await writeManifest(root, entries, 'committed');
    const before = await snapshotRelativeFiles(root, entryPaths(entries));

    await expect(recoverArtifactTransaction(root)).rejects.toThrow();

    await expectRelativeFiles(root, before);
  });

  test.each([0, 1, 2])(
    'accepts a committed backup cleanup prefix of %s original files',
    async (removedBackups) => {
      const root = await temporaryRoot();
      const entries = [
        writeEntry('src/generated/catalog.json', 0, 'file'),
        writeEntry('public/data/search-index.json', 1, 'missing'),
        writeEntry('reports/curator-report.json', 2, 'file'),
      ];
      await createOriginals(root, entries);
      const originalEntries = entries.filter((entry) => entry.original === 'file');
      for (const entry of entries) {
        if (entry.original === 'file') {
          await rename(join(root, entry.target), join(root, entry.backup));
        }
        await writeRelative(root, entry.target, `NEW ${entry.target}`);
      }
      for (const entry of originalEntries.slice(0, removedBackups)) {
        await rm(join(root, entry.backup));
      }
      await writeManifest(root, entries, 'committed');

      await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

      for (const entry of entries) {
        expect(await readFile(join(root, entry.target), 'utf8')).toBe(`NEW ${entry.target}`);
        await expectMissing(join(root, entry.backup));
      }
    },
  );

  test('rejects committed write and delete targets with the wrong presence', async () => {
    const cases = ['missing-write', 'present-delete'] as const;
    for (const kind of cases) {
      const root = await temporaryRoot();
      const cover = deleteEntry('public/generated/covers/stale.webp', 0, 'file');
      const entries: SavedEntry[] = [cover, ...fixedEntries(1)];
      await createOriginals(root, entries);
      await rename(join(root, cover.target), join(root, cover.backup));
      for (const entry of entries.slice(1) as SavedWrite[]) {
        await rename(join(root, entry.target), join(root, entry.backup));
        await writeRelative(root, entry.target, `NEW ${entry.target}`);
      }
      if (kind === 'missing-write') {
        await rm(join(root, entries[2]!.target));
      } else {
        await writeRelative(root, cover.target, 'IMPOSSIBLE DELETE TARGET');
      }
      await writeManifest(root, entries, 'committed');
      const before = await snapshotRelativeFiles(root, entryPaths(entries));

      await expect(recoverArtifactTransaction(root)).rejects.toThrow();

      await expectRelativeFiles(root, before);
    }
  });

  test('resumes multi-entry rollback after every interrupted reverse mutation', async () => {
    const root = await temporaryRoot();
    const entries = fixedEntries();
    await createOriginals(root, entries);
    for (const entry of entries) {
      await writeRelative(root, entry.stage, `NEW ${entry.target}`);
    }
    await rename(join(root, entries[0]!.target), join(root, entries[0]!.backup));
    await rename(join(root, entries[0]!.stage), join(root, entries[0]!.target));
    await rename(join(root, entries[1]!.target), join(root, entries[1]!.backup));
    await writeManifest(root, entries);

    let interruptions = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await recoverArtifactTransaction(root, { interruptAfterMutation: 1 });
        break;
      } catch {
        interruptions += 1;
      }
    }
    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    expect(interruptions).toBe(6);
    for (const entry of entries) {
      expect(await readFile(join(root, entry.target), 'utf8')).toBe(`OLD ${entry.target}`);
      await expectMissing(join(root, entry.stage));
      await expectMissing(join(root, entry.backup));
    }
    await expectMissing(join(root, '.astro/catalog-build-transaction.json'));
  });

  test.each(['committed', 'rolling-back'] as const)(
    'does not touch artifacts when the %s transition write fails',
    async (phase) => {
      const root = await temporaryRoot();
      const entries = fixedEntries();
      await createOriginals(root, entries);
      for (const entry of entries) {
        await writeRelative(root, entry.stage, `NEW ${entry.target}`);
      }
      if (phase === 'committed') {
        for (const entry of entries) {
          await rename(join(root, entry.target), join(root, entry.backup));
          await rename(join(root, entry.stage), join(root, entry.target));
        }
      } else {
        await rename(join(root, entries[0]!.target), join(root, entries[0]!.backup));
        await rename(join(root, entries[0]!.stage), join(root, entries[0]!.target));
      }
      await writeManifest(root, entries);
      const before = await Promise.all(
        entries.flatMap((entry) =>
          [entry.target, entry.stage, entry.backup].map(async (path) => {
            try {
              return [path, await readFile(join(root, path), 'utf8')] as const;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return [path, undefined] as const;
              }
              throw error;
            }
          }),
        ),
      );

      await expect(
        recoverArtifactTransaction(root, { failStateTransition: phase }),
      ).rejects.toThrow();

      for (const [path, contents] of before) {
        if (contents === undefined) await expectMissing(join(root, path));
        else expect(await readFile(join(root, path), 'utf8')).toBe(contents);
      }
      expect(
        JSON.parse(await readFile(join(root, '.astro/catalog-build-transaction.json'), 'utf8')),
      ).toMatchObject({ state: 'precommit' });
      expect(await readdir(join(root, '.astro'))).toEqual(['catalog-build-transaction.json']);
    },
  );

  test('rolls back replace-case and delete entries using their journaled originals', async () => {
    const root = await temporaryRoot();
    const coverDirectory = 'public/generated/covers';
    const deletion = deleteEntry(`${coverDirectory}/stale.webp`, 0);
    const replace = replaceCaseEntry(`${coverDirectory}/ABC.webp`, `${coverDirectory}/abc.webp`, 1);
    const entries: SavedEntry[] = [deletion, replace, ...fixedEntries(2)];
    await createOriginals(root, entries);
    for (const entry of entries) {
      if (entry.kind !== 'delete') {
        await writeRelative(root, entry.stage, `NEW ${entry.target}`);
      }
    }
    await rename(join(root, deletion.target), join(root, deletion.backup));
    await rename(join(root, replace.source), join(root, replace.backup));
    await rename(join(root, replace.stage), join(root, replace.target));
    await writeManifest(root, entries);

    await expect(recoverArtifactTransaction(root)).resolves.toBeUndefined();

    expect(await readFile(join(root, replace.source), 'utf8')).toBe(`OLD ${replace.source}`);
    expect(await readdir(join(root, coverDirectory))).toContain('ABC.webp');
    expect(await readdir(join(root, coverDirectory))).not.toContain('abc.webp');
    expect(await readFile(join(root, deletion.target), 'utf8')).toBe(`OLD ${deletion.target}`);
  });

  test.each([
    ['missing original with a forged target and stage', 'missing', true, true, false],
    ['file original missing without its backup', 'file', false, false, false],
    ['missing original with a forged backup', 'missing', false, false, true],
  ] as const)(
    'rejects impossible physical state: %s',
    async (_label, original, targetExists, stageExists, backupExists) => {
      const root = await temporaryRoot();
      const entries = fixedEntries(0, 'missing');
      entries[0] = writeEntry(entries[0]!.target, 0, original);
      if (targetExists) await writeRelative(root, entries[0]!.target, 'TARGET');
      if (stageExists) await writeRelative(root, entries[0]!.stage, 'STAGE');
      if (backupExists) await writeRelative(root, entries[0]!.backup, 'BACKUP');
      await writeManifest(root, entries);

      await expect(recoverArtifactTransaction(root)).rejects.toThrow();

      if (targetExists)
        expect(await readFile(join(root, entries[0]!.target), 'utf8')).toBe('TARGET');
      if (stageExists) expect(await readFile(join(root, entries[0]!.stage), 'utf8')).toBe('STAGE');
      if (backupExists)
        expect(await readFile(join(root, entries[0]!.backup), 'utf8')).toBe('BACKUP');
    },
  );

  test('accepts the manifest byte limit and rejects one byte beyond it before mutation', async () => {
    const acceptedRoot = await temporaryRoot();
    const rejectedRoot = await temporaryRoot();
    const entries = fixedEntries(0, 'missing');
    await writeManifest(acceptedRoot, entries, 'precommit', MANIFEST_MAX_BYTES);
    await writeManifest(rejectedRoot, entries, 'precommit', MANIFEST_MAX_BYTES + 1);

    await expect(recoverArtifactTransaction(acceptedRoot)).resolves.toBeUndefined();
    await expect(recoverArtifactTransaction(rejectedRoot)).rejects.toThrow();
    expect((await stat(join(rejectedRoot, '.astro/catalog-build-transaction.json'))).size).toBe(
      MANIFEST_MAX_BYTES + 1,
    );
  });

  test('accepts the manifest entry limit and rejects one entry beyond it', async () => {
    const createEntries = (count: number): SavedEntry[] => {
      const coverCount = count - 3;
      return [
        ...Array.from({ length: coverCount }, (_, index) =>
          deleteEntry(`public/generated/covers/c${index}.webp`, index, 'missing'),
        ),
        ...fixedEntries(coverCount, 'missing'),
      ];
    };
    const acceptedRoot = await temporaryRoot();
    const rejectedRoot = await temporaryRoot();
    await writeManifest(acceptedRoot, createEntries(MANIFEST_MAX_ENTRIES));
    await writeManifest(rejectedRoot, createEntries(MANIFEST_MAX_ENTRIES + 1));
    expect(MANIFEST_MAX_ENTRIES).toBeGreaterThan(MEASURED_FULL_SYNC_ENTRIES);

    await expect(recoverArtifactTransaction(acceptedRoot)).resolves.toBeUndefined();
    await expect(recoverArtifactTransaction(rejectedRoot)).rejects.toThrow();
    expect(
      await readFile(join(rejectedRoot, '.astro/catalog-build-transaction.json'), 'utf8'),
    ).toContain(`c${MANIFEST_MAX_ENTRIES - 3}.webp`);
  });
});
