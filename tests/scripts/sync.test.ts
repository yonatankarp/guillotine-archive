import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import MiniSearch from 'minisearch';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCatalog as defaultBuildCatalog, type BuildCatalogInput } from '../../src/catalog/build';
import { loadCurator } from '../../src/catalog/curator';
import type { DriveGateway } from '../../src/catalog/drive-gateway';
import { resolveRelationships } from '../../src/catalog/relationships';
import { createSearchEngine, getSearchOptions, type SearchDocument } from '../../src/catalog/search';
import type { Catalog, CuratorConfig, DriveFile } from '../../src/catalog/types';
import { syncFixture } from '../../scripts/sync-fixture';
import {
  readArchiveBaseline,
  syncDrive,
  writeArchiveBaselineAtomically,
} from '../../scripts/sync-drive';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const curatorPath = join(repositoryRoot, 'curator/collections.yml');
const fixturePath = join(repositoryRoot, 'tests/fixtures/drive-tree.json');
const generatedCatalogPath = join(repositoryRoot, 'src/generated/catalog.json');
const catalogForCoverAudit = existsSync(generatedCatalogPath)
  ? (JSON.parse(readFileSync(generatedCatalogPath, 'utf8')) as Catalog)
  : null;
const realCatalogForCoverAudit =
  catalogForCoverAudit !== null && catalogForCoverAudit.items.length >= 1000
    ? catalogForCoverAudit
    : null;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guillotine-sync-'));
  temporaryDirectories.push(root);
  return root;
}

function driveFile(id: string): DriveFile {
  return {
    id,
    name: `${id}.bin`,
    mimeType: 'application/octet-stream',
    size: 10,
    modifiedTime: '2026-08-26T10:00:00.000Z',
    path: `משחקים מלאים/${id}.bin`,
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
  };
}

function emptyCatalog(items: DriveFile[] = []): Catalog {
  return {
    generatedAt: '2026-08-26T12:00:00.000Z',
    collections: [],
    items: items.map((file) => ({
      ...file,
      category: 'משחקים מלאים',
      kind: 'game-data' as const,
      releaseSlug: 'full-games',
      aliasesHe: [],
      tagsHe: [],
      collectionLinks: [],
    })),
    categories: items.length > 0 ? ['משחקים מלאים'] : [],
    releases:
      items.length > 0
        ? [
            {
              slug: 'full-games',
              titleHe: 'משחקים מלאים',
              type: 'other' as const,
              subjectSlug: null,
              itemIds: items.map(({ id }) => id),
              sourcePaths: ['משחקים מלאים'],
            },
          ]
        : [],
    releaseFacets: {
      types: items.length > 0 ? ['other' as const] : [],
      subjectSlugs: [],
      years: [],
    },
  };
}

describe('production curator configuration', () => {
  test('defines exactly the six designed game collections and the production floor', async () => {
    const curator = await loadCurator(curatorPath);

    expect(curator.minimumFileCount).toBe(1000);
    expect(curator.collections.map(({ slug }) => slug)).toEqual([
      'piposh-1',
      'piposh-2',
      'halom-shehitgashem',
      'betochhei-harating',
      'vogimon',
      'piposh-revolution',
    ]);
    expect(new Set(curator.collections.map(({ slug }) => slug))).toHaveLength(6);
    expect(curator.collections.every(({ type }) => type === 'game')).toBe(true);
    expect(
      Object.fromEntries(curator.collections.map(({ slug, coverFileId }) => [slug, coverFileId])),
    ).toEqual({
      'piposh-1': '1JoYCVI1nah80Px76RYT85YdQr9rIPxNG',
      'piposh-2': '0Bwqx7RiWdM3YcnVNS09PUGR4aFk',
      'halom-shehitgashem': '0B2YRfkQTdJ96MnFNUnlRdlhkdjQ',
      'betochhei-harating': '0Bwqx7RiWdM3YVEVKUEFweVo0ZW8',
      vogimon: '0Bwqx7RiWdM3YY2tvazVOaDF4ZjQ',
      'piposh-revolution': undefined,
    });
    expect(curator.collections.some(({ summaryHe }) => summaryHe.includes('קיבינימאט'))).toBe(true);
    expect(curator.collections.find(({ slug }) => slug === 'vogimon')).toMatchObject({
      titleHe: 'ווג׳ימון',
      summaryHe:
        'המשחק המלא, הבטא, החוברת והעטיפה. כל מה שצריך כדי להיכנס לכדור קטן ולהתחרט מיד.',
      aliasesHe: expect.arrayContaining(['ווגימון', 'ווג_ימון']),
    });
    expect(curator.collections.find(({ slug }) => slug === 'betochhei-harating')?.summaryHe).toBe(
      'שלוש גרסאות, תיקונים, הוראות ופתרון. גם מאחורי הקלעים מישהו היה צריך לסדר את הקבצים.',
    );
    expect(curator.collections.find(({ slug }) => slug === 'piposh-revolution')?.summaryHe).toBe(
      'שלוש גרסאות, מפה, מוזיקה ופתרון. המהפכה אולי כאוטית; המדפים שלה לא.',
    );
  });

  test.skipIf(realCatalogForCoverAudit === null)(
    'audits selected cover IDs against their inspected real Drive paths when a generated catalog is present',
    async () => {
      const curator = await loadCurator(curatorPath);
      const inspectedSelections = [
        {
          slug: 'piposh-1',
          id: '1JoYCVI1nah80Px76RYT85YdQr9rIPxNG',
          path: 'משחקים מלאים/פיפוש 1/פיפוש 1 - אריזה/711419-piposh-hollywood-windows-front-cover.jpg',
        },
        {
          slug: 'piposh-2',
          id: '0Bwqx7RiWdM3YcnVNS09PUGR4aFk',
          path: 'משחקים מלאים/פיפוש 2/פיפוש 2 - עטיפה/Front.jpg',
        },
        {
          slug: 'halom-shehitgashem',
          id: '0B2YRfkQTdJ96MnFNUnlRdlhkdjQ',
          path: 'משחקים מלאים/חלום שהתגשם/אריזה/Front.jpg',
        },
        {
          slug: 'betochhei-harating',
          id: '0Bwqx7RiWdM3YVEVKUEFweVo0ZW8',
          path: 'משחקים מלאים/בתככי הרייטינג/תככי הרייטינג - עטיפה/Front(4).png',
        },
        {
          slug: 'vogimon',
          id: '0Bwqx7RiWdM3YY2tvazVOaDF4ZjQ',
          path: "משחקים מלאים/ווג'ימון/ווג'ימון - עטיפה/Scan.jpg",
        },
      ] as const;

      for (const expected of inspectedSelections) {
        expect(curator.collections.find(({ slug }) => slug === expected.slug)?.coverFileId).toBe(
          expected.id,
        );
        expect(realCatalogForCoverAudit?.items.find(({ id }) => id === expected.id)).toMatchObject({
          path: expected.path,
          mimeType: expect.stringMatching(/^image\//u),
        });
      }
      expect(
        curator.collections.find(({ slug }) => slug === 'piposh-revolution')?.coverFileId,
      ).toBeUndefined();
    },
  );

  test('keeps every curated rule official and leaves press and fan materials independent', async () => {
    const curator = await loadCurator(curatorPath);
    const rules = curator.collections.flatMap(({ rules }) => rules);

    expect(rules.every(({ relationship }) => relationship === 'part-of-release')).toBe(true);
    expect(rules.some(({ value }) => /עיתונות|מעריצים/u.test(value))).toBe(false);
    expect(rules.some(({ value }) => value.endsWith('.txt'))).toBe(false);
    expect(rules.some(({ value }) => value === 'פתרונות/פיפוש 1 - פתרון.docx')).toBe(true);
    expect(curator.collections.flatMap(({ exclude }) => exclude)).toEqual([
      {
        match: 'exact-path',
        value: 'משחקים מלאים/פיפוש 2/פיפוש 2 - עטיפה/.DS_Store',
        relationship: 'part-of-release',
      },
      {
        match: 'exact-path',
        value: 'דמואים/Vegimon_Beta1.0/Thumbs.db',
        relationship: 'part-of-release',
      },
    ]);
  });

  test('groups representative real paths without overlapping official groups', async () => {
    const curator = await loadCurator(curatorPath);
    const cases = [
      ['p1-he', 'משחקים מלאים/פיפוש 1/גרסה 2/piposh1.exe', 'piposh-1', 'גרסאות בעברית'],
      ['p1-en', 'משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe', 'piposh-1', 'מהדורות רשמיות בשפות זרות'],
      ['p1-ru', 'משחקים מלאים/פיפוש 1 - רוסית/piposh1-russian.exe', 'piposh-1', 'מהדורות רשמיות בשפות זרות'],
      ['p1-book', 'משחקים מלאים/פיפוש 1/פיפוש 1 - חוברת שירים/Scan_001.jpg', 'piposh-1', 'חוברות'],
      ['p1-package', 'משחקים מלאים/פיפוש 1/פיפוש 1 - אריזה/Front.jpg', 'piposh-1', 'אריזה'],
      ['p1-audio', 'שירים/דיסקים מלאים/פיפוש 1 - דיסק אודיו/דיסק אדיו.rar', 'piposh-1', 'דיסק אודיו'],
      ['p1-solution-native', 'פתרונות/פיפוש 1 - פתרון', 'piposh-1', 'פתרונות'],
      ['p1-solution-docx', 'פתרונות/פיפוש 1 - פתרון.docx', 'piposh-1', 'פתרונות'],
      ['p2-cover', 'משחקים מלאים/פיפוש 2/פיפוש 2 - עטיפה/Front.jpg', 'piposh-2', 'עטיפה וחוברת'],
      ['p2-song', 'שירים/פיפוש 2 שירים/שיר פתיחה.AIF', 'piposh-2', 'מוזיקה'],
      ['p2-solution-native', 'פתרונות/פיפוש 2 - פתרון', 'piposh-2', 'פתרונות'],
      ['p2-solution-docx', 'פתרונות/פיפוש 2 - פתרון.docx', 'piposh-2', 'פתרונות'],
      ['dream-pack', 'משחקים מלאים/חלום שהתגשם/אריזה/Back.jpg', 'halom-shehitgashem', 'אריזה'],
      ['dream-cheat', 'משחקים מלאים/חלום שהתגשם/ציטים/Piposh.rar', 'halom-shehitgashem', 'צ׳יטים'],
      ['rating-patch', 'משחקים מלאים/בתככי הרייטינג/קבצי תיקון/lua5.1.dll', 'betochhei-harating', 'קבצי תיקון'],
      ['rating-rosh1', 'משחקים מלאים/בתככי הרייטינג - ראש1/rating-rosh1.iso', 'betochhei-harating', 'גרסאות המשחק'],
      ['rating-help-native', 'משחקים מלאים/בתככי הרייטינג/הוראות!', 'betochhei-harating', 'הוראות'],
      ['rating-help', 'משחקים מלאים/בתככי הרייטינג/הוראות!.docx', 'betochhei-harating', 'הוראות'],
      ['rating-solution-native', 'פתרונות/תככי הרייטינג - פתרון', 'betochhei-harating', 'פתרונות'],
      ['rating-solution-docx', 'פתרונות/תככי הרייטינג - פתרון.docx', 'betochhei-harating', 'פתרונות'],
      ['vogimon', "משחקים מלאים/ווג'ימון/vegimonfull.exe", 'vogimon', 'המשחק המלא'],
      ['vogimon-book', "משחקים מלאים/ווג'ימון/ווג'ימון - חוברת/Scan_000.jpg", 'vogimon', 'חוברת'],
      ['vogimon-cover', "משחקים מלאים/ווג'ימון/ווג'ימון - עטיפה/Scan.jpg", 'vogimon', 'עטיפה'],
      ['vogimon-demo', 'דמואים/Vegimon_Beta1.0/SETUP.EXE', 'vogimon', 'דמו בטא רשמי'],
      ['revolution-v3', 'משחקים מלאים/פיפוש המהפכה/גרסה 3 - יונתן/piposh3d_cd1.iso', 'piposh-revolution', 'גרסאות המשחק'],
      ['revolution-map', 'משחקים מלאים/פיפוש המהפכה/פיפוש המהפכה - מפת משחק/מפה 11.jpg', 'piposh-revolution', 'מפת המשחק'],
      ['revolution-audio', 'שירים/דיסקים מלאים/פיפוש המהפכה - דיסק אודיו/01 Track 1.mp3', 'piposh-revolution', 'דיסק אודיו'],
      ['revolution-solution-native', 'פתרונות/פיפוש המהפכה - פתרון', 'piposh-revolution', 'פתרונות'],
      ['revolution-solution-docx', 'פתרונות/פיפוש המהפכה - פתרון.docx', 'piposh-revolution', 'פתרונות'],
    ] as const;
    const systemFiles = [
      {
        ...driveFile('p2-cover-system'),
        name: '.DS_Store',
        path: 'משחקים מלאים/פיפוש 2/פיפוש 2 - עטיפה/.DS_Store',
      },
      {
        ...driveFile('p2-root-system'),
        name: '.DS_Store',
        path: 'משחקים מלאים/פיפוש 2/.DS_Store',
      },
      {
        ...driveFile('vogimon-system'),
        name: 'Thumbs.db',
        path: 'דמואים/Vegimon_Beta1.0/Thumbs.db',
      },
    ];
    const files = [
      ...cases.map(([id, path]) => ({
        ...driveFile(id),
        name: path.split('/').at(-1)!,
        path,
      })),
      ...systemFiles,
      {
        ...driveFile('press'),
        name: 'ביקורת.jpg',
        path: 'עיתונות/פיפוש 1/ביקורת.jpg',
      },
      {
        ...driveFile('fan'),
        name: 'fan.zip',
        path: 'משחקי מעריצים/פיפוש 1/fan.zip',
      },
    ];
    const catalog = resolveRelationships(files, curator, '2026-08-26T12:00:00.000Z');

    for (const [id, , slug, groupHe] of cases) {
      const links = catalog.items.find((item) => item.id === id)?.collectionLinks;
      expect(links, id).toEqual([{ slug, titleHe: expect.any(String), relationship: 'part-of-release', groupHe }]);
    }
    for (const { id } of systemFiles) {
      expect(catalog.items.find((item) => item.id === id)?.collectionLinks, id).toEqual([]);
      expect(catalog.collections.some(({ itemIds }) => itemIds.includes(id)), id).toBe(false);
    }
    for (const id of ['press', 'fan']) {
      expect(catalog.items.find((item) => item.id === id)?.collectionLinks, id).toEqual([]);
      expect(catalog.collections.some(({ itemIds }) => itemIds.includes(id)), id).toBe(false);
    }
    for (const collection of catalog.collections) {
      expect(new Set(collection.itemIds).size, collection.slug).toBe(collection.itemIds.length);
    }
    for (const item of catalog.items) {
      const linkKeys = item.collectionLinks.map(({ slug, relationship, groupHe }) =>
        JSON.stringify([slug, relationship, groupHe ?? null]),
      );
      expect(new Set(linkKeys).size, item.id).toBe(linkKeys.length);
    }
  });
});

describe('fixture synchronization', () => {
  test('builds deterministic artifacts and exposes an English filename through Hebrew metadata', async () => {
    const root = await temporaryRoot();

    const catalog = await syncFixture({
      root,
      curatorPath,
      fixturePath,
      generatedAt: '2026-08-26T12:00:00.000Z',
      log: () => undefined,
    });

    expect(catalog.generatedAt).toBe('2026-08-26T12:00:00.000Z');
    expect(catalog.items.map(({ id }) => id)).toHaveLength(3);
    expect(catalog.collections.every(({ coverFileId }) => coverFileId === undefined)).toBe(true);
    expect(catalog.collections.every(({ coverUrl }) => coverUrl === null)).toBe(true);
    expect(catalog.items.map(({ path }) => path).sort()).toEqual(
      [
        'משחקים מלאים/פיפוש 1/גרסה 2/piposh1.exe',
        'משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe',
        'פתרונות/פיפוש 1 - פתרון.docx',
      ].sort(),
    );
    expect(catalog.items.find(({ id }) => id === 'piposh-solution')).toMatchObject({
      name: 'פיפוש 1 - פתרון.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 980,
      extractedTextHe: expect.stringContaining('פתרון מלא לפיפוש'),
    });
    const serializedSearch = await readFile(join(root, 'public/data/search-index.json'), 'utf8');
    const search = createSearchEngine(
      MiniSearch.loadJSON<SearchDocument>(serializedSearch, getSearchOptions()),
    );
    expect(search.search('אנגלית').map(({ id }) => id)).toContain('file:piposh-english');
    await expect(readFile(join(root, 'src/generated/catalog.json'), 'utf8')).resolves.toContain(
      'piposh-english',
    );
    const report = JSON.parse(
      await readFile(join(root, 'reports/curator-report.json'), 'utf8'),
    ) as { errors: string[]; warnings: string[] };
    expect(report).toMatchObject({ errors: [], warnings: [] });
  });

  test('overrides the production minimum only in the fixture build', async () => {
    const root = await temporaryRoot();
    let receivedInput: BuildCatalogInput | undefined;
    const build: typeof defaultBuildCatalog = vi.fn(async (input) => {
      receivedInput = input;
      return emptyCatalog([driveFile('one')]);
    });

    await syncFixture(
      { root, curatorPath, fixturePath, log: () => undefined },
      { buildCatalog: build },
    );

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ minimumFileCount: 1 }));
    expect(receivedInput?.curator.minimumFileCount).toBe(1000);
  });

  test('builds safely when the production curator has a file override outside the fixture', async () => {
    const root = await temporaryRoot();
    const sourceCurator: CuratorConfig = {
      ...(await loadCurator(curatorPath)),
      files: {
        'production-only-id': { titleHe: 'כותרת ייצור' },
      },
    };
    const sourceBefore = structuredClone(sourceCurator);

    await expect(
      syncFixture(
        { root, fixturePath, log: () => undefined },
        { loadCurator: vi.fn(async () => sourceCurator) },
      ),
    ).resolves.toMatchObject({ items: expect.any(Array) });
    expect(sourceCurator).toEqual(sourceBefore);
  });

  test('omits production covers and file overrides without mutating the loaded curator', async () => {
    const root = await temporaryRoot();
    const sourceCurator: CuratorConfig = {
      ...(await loadCurator(curatorPath)),
      files: {
        'production-only-id': {
          titleHe: 'כותרת ייצור',
          aliasesHe: ['שם ייצור'],
        },
      },
    };
    const sourceBefore = structuredClone(sourceCurator);
    let receivedInput: BuildCatalogInput | undefined;
    const build: typeof defaultBuildCatalog = vi.fn(async (input) => {
      receivedInput = input;
      return emptyCatalog();
    });

    await syncFixture(
      { root, curatorPath, fixturePath, log: () => undefined },
      {
        buildCatalog: build,
        loadCurator: vi.fn(async () => sourceCurator),
      },
    );

    const expectedFixtureCurator = structuredClone(sourceCurator);
    expectedFixtureCurator.files = {};
    for (const collection of expectedFixtureCurator.collections) {
      delete collection.coverFileId;
    }
    for (const override of expectedFixtureCurator.releases ?? []) {
      delete override.coverFileId;
      delete override.logoFileId;
    }
    expect(receivedInput?.curator).toEqual(expectedFixtureCurator);
    expect(sourceCurator).toEqual(sourceBefore);
    expect(
      sourceCurator.collections.filter(({ coverFileId }) => coverFileId !== undefined),
    ).toHaveLength(5);
  });

  test('uses a fixed default timestamp and writes byte-identical fixture artifacts', async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    const options = { curatorPath, fixturePath, log: () => undefined };

    const firstCatalog = await syncFixture({ ...options, root: firstRoot });
    const secondCatalog = await syncFixture({ ...options, root: secondRoot });

    expect(firstCatalog.generatedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(secondCatalog.generatedAt).toBe('2026-08-26T00:00:00.000Z');
    for (const artifact of [
      'src/generated/catalog.json',
      'public/data/search-index.json',
      'reports/curator-report.json',
    ]) {
      expect(await readFile(join(firstRoot, artifact)), artifact).toEqual(
        await readFile(join(secondRoot, artifact)),
      );
    }
  });
});

describe('archive baseline', () => {
  test('returns zero when missing and reads a strict valid baseline', async () => {
    const root = await temporaryRoot();

    await expect(readArchiveBaseline(root)).resolves.toBe(0);
    await mkdir(join(root, '.astro'));
    await writeFile(join(root, '.astro/archive-baseline.json'), '{"version":1,"fileCount":1453}\n');
    await expect(readArchiveBaseline(root)).resolves.toBe(1453);
  });

  test.each([
    ['{"version":1,"fileCount":-1}', 'negative'],
    ['{"version":1,"fileCount":1.5}', 'fractional'],
    [`{"version":1,"fileCount":${Number.MAX_SAFE_INTEGER + 1}}`, 'unsafe'],
    ['{"version":2,"fileCount":1}', 'wrong version'],
    ['{"version":1,"fileCount":1,"extra":true}', 'extra field'],
    ['[]', 'wrong shape'],
  ])('rejects a malformed baseline without exposing its %s contents', async (source) => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.astro'));
    await writeFile(join(root, '.astro/archive-baseline.json'), source);

    await expect(readArchiveBaseline(root)).rejects.toThrow(/^archive baseline is invalid$/);
  });

  test('rejects oversized, symlinked, and non-regular baselines', async () => {
    const oversizedRoot = await temporaryRoot();
    await mkdir(join(oversizedRoot, '.astro'));
    await writeFile(join(oversizedRoot, '.astro/archive-baseline.json'), 'x'.repeat(5000));
    await expect(readArchiveBaseline(oversizedRoot)).rejects.toThrow('archive baseline is invalid');

    const symlinkRoot = await temporaryRoot();
    await mkdir(join(symlinkRoot, '.astro'));
    await writeFile(join(symlinkRoot, 'outside.json'), '{"version":1,"fileCount":7}');
    await symlink(join(symlinkRoot, 'outside.json'), join(symlinkRoot, '.astro/archive-baseline.json'));
    await expect(readArchiveBaseline(symlinkRoot)).rejects.toThrow('archive baseline is invalid');

    const directoryRoot = await temporaryRoot();
    await mkdir(join(directoryRoot, '.astro/archive-baseline.json'), { recursive: true });
    await expect(readArchiveBaseline(directoryRoot)).rejects.toThrow('archive baseline is invalid');
  });

  test('writes atomically and cleans its unique temporary file when writing or renaming fails', async () => {
    const root = await temporaryRoot();
    await writeArchiveBaselineAtomically(root, 10);
    const baselinePath = join(root, '.astro/archive-baseline.json');
    const original = await readFile(baselinePath, 'utf8');

    await expect(
      writeArchiveBaselineAtomically(root, 11, {
        beforeWrite: () => {
          throw new Error('simulated secret write failure');
        },
      }),
    ).rejects.toThrow(/^unable to update archive baseline$/);
    expect(await readFile(baselinePath, 'utf8')).toBe(original);

    await expect(
      writeArchiveBaselineAtomically(root, 12, {
        beforeRename: () => {
          throw new Error('simulated secret rename failure');
        },
      }),
    ).rejects.toThrow(/^unable to update archive baseline$/);
    expect(await readFile(baselinePath, 'utf8')).toBe(original);
    expect((await readdir(dirname(baselinePath))).sort()).toEqual(['archive-baseline.json']);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe file counts before touching disk: %s',
    async (fileCount) => {
      const root = await temporaryRoot();

      await expect(writeArchiveBaselineAtomically(root, fileCount)).rejects.toThrow(
        'fileCount must be a nonnegative safe integer',
      );
      await expect(readFile(join(root, '.astro/archive-baseline.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  test('rejects a symlinked baseline directory without changing its target', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, join(root, '.astro'));

    await expect(writeArchiveBaselineAtomically(root, 4)).rejects.toThrow(
      'unable to update archive baseline',
    );
    expect(await readdir(outside)).toEqual([]);
  });
});

describe('production Drive synchronization', () => {
  test.each([
    [{ GOOGLE_DRIVE_FOLDER_ID: 'root' }, 'GOOGLE_SERVICE_ACCOUNT_JSON is required'],
    [{ GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }, 'GOOGLE_DRIVE_FOLDER_ID is required'],
  ])('reports missing environment without creating a gateway', async (env, message) => {
    const createGateway = vi.fn();

    await expect(
      syncDrive({ root: repositoryRoot, env, log: () => undefined }, { createGateway }),
    ).rejects.toThrow(message);
    expect(createGateway).not.toHaveBeenCalled();
  });

  test('restores the baseline for the build and saves the validated count only after success', async () => {
    const root = await temporaryRoot();
    await writeArchiveBaselineAtomically(root, 9);
    const files = [driveFile('one'), driveFile('two')];
    const gateway: DriveGateway = {
      listChildren: vi.fn(),
      download: vi.fn(async () => Buffer.alloc(0)),
    };
    const buildCatalog = vi.fn(async (input) => {
      expect(input.previousFileCount).toBe(9);
      expect(input.files).toEqual(files);
      expect(input.download).toBe(gateway.download);
      expect(await readArchiveBaseline(root)).toBe(9);
      return emptyCatalog(files);
    });

    const catalog = await syncDrive(
      {
        root,
        env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', GOOGLE_DRIVE_FOLDER_ID: 'root' },
        generatedAt: '2026-08-26T12:00:00.000Z',
        log: () => undefined,
      },
      {
        createGateway: () => gateway,
        scanDrive: async () => files,
        loadCurator: async () => ({ minimumFileCount: 1000, collections: [] }),
        buildCatalog,
      },
    );

    expect(catalog.items).toHaveLength(2);
    expect(await readArchiveBaseline(root)).toBe(2);
  });

  test.each(['scan', 'build'] as const)('%s failure preserves the previous baseline', async (stage) => {
    const root = await temporaryRoot();
    await writeArchiveBaselineAtomically(root, 17);
    const gateway: DriveGateway = {
      listChildren: vi.fn(),
      download: vi.fn(async () => Buffer.alloc(0)),
    };
    const failure = new Error(`private ${stage} details`);

    await expect(
      syncDrive(
        {
          root,
          env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{}', GOOGLE_DRIVE_FOLDER_ID: 'root' },
          log: () => undefined,
        },
        {
          createGateway: () => gateway,
          scanDrive: async () => {
            if (stage === 'scan') throw failure;
            return [driveFile('one')];
          },
          loadCurator: async () => ({ collections: [] }),
          buildCatalog: async () => {
            throw failure;
          },
        },
      ),
    ).rejects.toThrow(failure);
    expect(await readArchiveBaseline(root)).toBe(17);
  });
});
