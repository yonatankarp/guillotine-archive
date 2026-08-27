import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import MiniSearch from 'minisearch';
import sharp from 'sharp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildCatalog } from '../../src/catalog/build';
import { createSearchEngine, getSearchOptions, type SearchDocument } from '../../src/catalog/search';
import type {
  Catalog,
  CatalogCollection,
  CatalogItem,
  CuratedCollection,
  CuratorConfig,
  DriveFile,
} from '../../src/catalog/types';
import { validateCatalog } from '../../src/catalog/validate';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guillotine-build-'));
  temporaryDirectories.push(root);
  return root;
}

function driveFile(id: string, overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name: `${id}.bin`,
    mimeType: 'application/octet-stream',
    size: 10,
    modifiedTime: '2026-08-26T10:00:00.000Z',
    path: `ארכיון/${id}.bin`,
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
    ...overrides,
  };
}

function curatedCollection(
  overrides: Partial<CuratedCollection> = {},
): CuratedCollection {
  return {
    slug: 'piposh-1',
    titleHe: 'פיפוש 1',
    type: 'game',
    summaryHe: 'המשחק המקורי',
    aliasesHe: [],
    tagsHe: [],
    rules: [],
    exclude: [],
    ...overrides,
  };
}

function curator(
  overrides: Partial<CuratorConfig> = {},
): CuratorConfig {
  return {
    collections: [curatedCollection()],
    ...overrides,
  };
}

function catalogItem(id: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    ...driveFile(id),
    category: 'ארכיון',
    aliasesHe: [],
    tagsHe: [],
    collectionLinks: [],
    ...overrides,
  };
}

function catalogCollection(
  overrides: Partial<CatalogCollection> = {},
): CatalogCollection {
  return {
    ...curatedCollection(),
    coverUrl: null,
    itemIds: [],
    ...overrides,
  };
}

function catalog(
  items: CatalogItem[],
  overrides: Partial<Catalog> = {},
): Catalog {
  return {
    generatedAt: '2026-08-26T12:00:00.000Z',
    collections: [catalogCollection()],
    items,
    categories: ['ארכיון'],
    ...overrides,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function recursiveNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })).map(String).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

describe('validateCatalog', () => {
  test('reports an empty archive without also reporting the minimum threshold', () => {
    expect(validateCatalog(catalog([]), curator(), 0, 4).errors).toEqual([
      'archive contains no files',
    ]);
  });

  test('enforces minimum count only below the boundary', () => {
    expect(validateCatalog(catalog([catalogItem('one')]), curator(), 0, 2).errors).toEqual([
      'archive contains 1 files; expected at least 2',
    ]);
    expect(
      validateCatalog(catalog([catalogItem('one'), catalogItem('two')]), curator(), 0, 2)
        .errors,
    ).toEqual([]);
  });

  test.each([
    [-1, 1, /previousCount must be a nonnegative integer/],
    [1.5, 1, /previousCount must be a nonnegative integer/],
    [0, 0, /minimumFileCount must be a positive integer/],
    [0, 1.5, /minimumFileCount must be a positive integer/],
  ])('rejects invalid count inputs (%s, %s)', (previousCount, minimum, message) => {
    expect(() => validateCatalog(catalog([catalogItem('one')]), curator(), previousCount, minimum))
      .toThrow(message);
  });

  test('reports shrinkage only below half of a previous archive of at least twenty files', () => {
    const nine = Array.from({ length: 9 }, (_, index) => catalogItem(`item-${index}`));
    const ten = [...nine, catalogItem('item-9')];

    expect(validateCatalog(catalog(nine), curator(), 20, 1).errors).toContain(
      'archive shrank unexpectedly from 20 to 9 files',
    );
    expect(validateCatalog(catalog(ten), curator(), 20, 1).errors).not.toContain(
      'archive shrank unexpectedly from 20 to 10 files',
    );
    expect(validateCatalog(catalog(nine), curator(), 19, 1).errors).not.toContain(
      'archive shrank unexpectedly from 19 to 9 files',
    );
  });

  test('reports duplicate Drive IDs and duplicate curator and catalog slugs deterministically', () => {
    const source = catalog([catalogItem('same'), catalogItem('same')], {
      collections: [catalogCollection(), catalogCollection()],
    });
    const config = curator({ collections: [curatedCollection(), curatedCollection()] });

    expect(validateCatalog(source, config).errors).toEqual([
      'duplicate Drive item ID: same',
      'duplicate curator collection slug: piposh-1',
      'duplicate catalog collection slug: piposh-1',
    ]);
  });

  test('distinguishes contradictory relationship kinds from same-kind duplicate links', () => {
    const sameKind = catalogItem('same-kind', {
      collectionLinks: [
        { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'about' },
        { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'about', groupHe: 'עיתונות' },
      ],
    });
    const contradictory = catalogItem('contradictory', {
      collectionLinks: [
        { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'about' },
        { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'part-of-release' },
      ],
    });

    expect(validateCatalog(catalog([sameKind]), curator()).errors).toEqual([]);
    expect(validateCatalog(catalog([contradictory]), curator()).errors).toEqual([
      'item contradictory has contradictory relationships to collection piposh-1: about, part-of-release',
    ]);
  });

  test('reports unknown collection links and unknown collection item IDs', () => {
    const source = catalog(
      [
        catalogItem('known', {
          collectionLinks: [
            { slug: 'missing', titleHe: 'חסר', relationship: 'about' },
          ],
        }),
      ],
      { collections: [catalogCollection({ itemIds: ['known', 'missing-file'] })] },
    );

    expect(validateCatalog(source, curator()).errors).toEqual([
      'item known links to unknown collection: missing',
      'collection piposh-1 references unknown item ID: missing-file',
    ]);
  });

  test('deduplicates identical diagnostics globally while preserving first occurrence', () => {
    const source = catalog(
      [
        catalogItem('known', {
          collectionLinks: [
            { slug: 'missing', titleHe: 'חסר', relationship: 'about' },
            { slug: 'missing', titleHe: 'חסר', relationship: 'about' },
          ],
        }),
      ],
      {
        collections: [catalogCollection({ itemIds: ['missing-file', 'missing-file'] })],
      },
    );
    const repeatedCurator = curator({
      collections: [
        curatedCollection({
          rules: [
            { match: 'file-id', value: 'missing-rule', relationship: 'about' },
            { match: 'file-id', value: 'missing-rule', relationship: 'about' },
          ],
        }),
        curatedCollection({
          rules: [{ match: 'file-id', value: 'missing-rule', relationship: 'about' }],
        }),
      ],
    });

    expect(validateCatalog(source, repeatedCurator).errors).toEqual([
      'duplicate curator collection slug: piposh-1',
      'item known links to unknown collection: missing',
      'collection piposh-1 references unknown item ID: missing-file',
      'collection piposh-1 rule references missing file ID: missing-rule',
    ]);
  });

  test('requires cover IDs to resolve to image items', () => {
    const missingConfig = curator({
      collections: [curatedCollection({ coverFileId: 'missing-cover' })],
    });
    const wrongTypeConfig = curator({
      collections: [curatedCollection({ coverFileId: 'document' })],
    });

    expect(validateCatalog(catalog([catalogItem('document')]), missingConfig).errors).toEqual([
      'collection piposh-1 cover file is missing: missing-cover',
    ]);
    expect(validateCatalog(catalog([catalogItem('document')]), wrongTypeConfig).errors).toEqual([
      'collection piposh-1 cover file is not an image: document',
    ]);
  });

  test('rejects distinct cover IDs that resolve to the same portable target', () => {
    const config = curator({
      collections: [
        curatedCollection({ coverFileId: 'ABC' }),
        curatedCollection({ slug: 'piposh-2', titleHe: 'פיפוש 2', coverFileId: 'abc' }),
      ],
    });
    const source = catalog([
      catalogItem('ABC', { name: 'ABC.png', mimeType: 'image/png' }),
      catalogItem('abc', { name: 'abc.png', mimeType: 'image/png' }),
    ]);

    expect(validateCatalog(source, config).errors).toContain(
      'cover file IDs resolve to the same portable target: ABC, abc',
    );
  });

  test.each(['../../../outside', 'folder/cover', 'folder\\cover', '.', '..', 'cover.png'])(
    'rejects unsafe cover file IDs before path construction: %s',
    (coverFileId) => {
      const config = curator({
        collections: [curatedCollection({ coverFileId })],
      });

      expect(
        validateCatalog(
          catalog([
            catalogItem(coverFileId, { name: 'cover.png', mimeType: 'image/png' }),
          ]),
          config,
        ).errors,
      ).toContain(`collection piposh-1 has invalid cover file ID: ${coverFileId}`);
    },
  );

  test('reports missing positive and exclude file-id references once per context', () => {
    const config = curator({
      collections: [
        curatedCollection({
          rules: [
            { match: 'file-id', value: 'positive', relationship: 'about' },
            { match: 'file-id', value: 'positive', relationship: 'about' },
          ],
          exclude: [
            { match: 'file-id', value: 'excluded', relationship: 'about' },
            { match: 'file-id', value: 'excluded', relationship: 'inspired-by' },
          ],
        }),
      ],
    });

    expect(validateCatalog(catalog([catalogItem('known')]), config).errors).toEqual([
      'collection piposh-1 rule references missing file ID: positive',
      'collection piposh-1 exclude references missing file ID: excluded',
    ]);
  });

  test('reports missing file metadata override references', () => {
    const config = curator({
      files: {
        missing: { titleHe: 'כותרת חסרה' },
      },
    });

    expect(validateCatalog(catalog([catalogItem('known')]), config).errors).toEqual([
      'file metadata override references missing Drive item ID: missing',
    ]);
  });

  test('rejects identical include and exclude selectors but permits narrower exclusions', () => {
    const contradictory = curator({
      collections: [
        curatedCollection({
          rules: [
            { match: 'exact-path', value: 'חומר/file.bin', relationship: 'part-of-release' },
          ],
          exclude: [
            { match: 'exact-path', value: 'חומר/file.bin', relationship: 'about' },
          ],
        }),
      ],
    });
    const narrowerExclusion = curator({
      collections: [
        curatedCollection({
          rules: [
            { match: 'path-prefix', value: 'חומר', relationship: 'part-of-release' },
          ],
          exclude: [
            { match: 'exact-path', value: 'חומר/skip.bin', relationship: 'part-of-release' },
          ],
        }),
      ],
    });

    expect(validateCatalog(catalog([catalogItem('known')]), contradictory).errors).toEqual([
      'collection piposh-1 has contradictory include/exclude selector: exact-path חומר/file.bin',
    ]);
    expect(validateCatalog(catalog([catalogItem('known')]), narrowerExclusion).errors).toEqual([]);
  });

  test('reports unclassified IDs in item order with one deterministic warning', () => {
    const source = catalog([
      catalogItem('second'),
      catalogItem('linked', {
        collectionLinks: [
          { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'about' },
        ],
      }),
      catalogItem('first'),
    ]);

    expect(validateCatalog(source, curator())).toEqual({
      errors: [],
      warnings: ['2 files are not linked to a curated collection'],
      unclassifiedIds: ['second', 'first'],
    });
  });
});

describe('buildCatalog', () => {
  test('fails validation before downloads when a file metadata override target is missing', async () => {
    const root = await temporaryRoot();
    const download = vi.fn<(fileId: string) => Promise<Buffer>>();

    await expect(
      buildCatalog({
        files: [driveFile('known')],
        curator: curator({ files: { missing: { tagsHe: ['חסר'] } } }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download,
      }),
    ).rejects.toThrow(/file metadata override references missing Drive item ID: missing/);
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      errors: ['file metadata override references missing Drive item ID: missing'],
    });
    expect(download).not.toHaveBeenCalled();
  });

  test('sanitizes every exported failure object and diagnostic report recursively', async () => {
    const secretValues = [
      'Bearer eyJhbGciOiJIUzI1NiJ9.recursive-secret',
      '-----BEGIN PRIVATE KEY-----recursive-private-key',
      'api_key=recursive-api-key',
      'X-Goog-Signature=recursive-signed-value',
    ];
    const secretPayload = secretValues.join(' ');
    const failures: Array<{ error: unknown; expectedMessage: RegExp; report?: string }> = [];
    const capture = async (
      promise: Promise<unknown>,
      expectedMessage: RegExp,
      reportPath?: string,
    ) => {
      try {
        await promise;
        throw new Error('expected build to fail');
      } catch (error) {
        failures.push({
          error,
          expectedMessage,
          ...(reportPath ? { report: await readFile(reportPath, 'utf8') } : {}),
        });
      }
    };

    const malformedRoot = await temporaryRoot();
    await mkdir(join(malformedRoot, 'src/generated'), { recursive: true });
    await writeFile(join(malformedRoot, 'src/generated/catalog.json'), secretPayload, 'utf8');
    await capture(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root: malformedRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
      /^existing catalog is malformed$/,
    );

    const coverRoot = await temporaryRoot();
    await capture(
      buildCatalog({
        files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({ collections: [curatedCollection({ coverFileId: 'cover' })] }),
        root: coverRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => {
          throw new Error(secretPayload, { cause: new Error(secretPayload) });
        },
      }),
      /^failed to process cover cover for collection piposh-1$/,
      join(coverRoot, 'reports/curator-report.json'),
    );

    const searchRoot = await temporaryRoot();
    const hostileDownloadUrl = {
      toJSON: () => {
        throw new Error(secretPayload, { cause: new AggregateError([secretPayload]) });
      },
    } as unknown as string;
    await capture(
      buildCatalog({
        files: [driveFile('one', { downloadUrl: hostileDownloadUrl })],
        curator: curator(),
        root: searchRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
      /^failed to build search index$/,
      join(searchRoot, 'reports/curator-report.json'),
    );

    const promotionBase = await temporaryRoot();
    const promotionRoot = join(promotionBase, secretPayload);
    await mkdir(join(promotionRoot, 'reports/curator-report.json'), { recursive: true });
    await capture(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root: promotionRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
      /^failed to promote archive artifacts$/,
    );

    expect(failures).toHaveLength(4);
    for (const { error, expectedMessage, report = '' } of failures) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(expectedMessage);
      const exposed = `${inspect(error, { depth: null })}\n${report}`;
      for (const secret of secretValues) {
        expect(exposed).not.toContain(secret);
      }
    }
  });

  test('warns when extraction yields text but no Hebrew, the shape of a charset fault', async () => {
    const root = await temporaryRoot();
    const files = [
      driveFile('solution', {
        name: 'פתרון.txt',
        mimeType: 'text/plain',
        path: 'פתרונות/פתרון.txt',
      }),
    ];
    const config = curator({
      collections: [
        curatedCollection({
          rules: [{ match: 'file-id', value: 'solution', relationship: 'part-of-release' }],
        }),
      ],
    });

    // What a Windows-1255 file decoded as UTF-8 leaves behind: the digits only.
    const result = await buildCatalog({
      files,
      curator: config,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.from('2002 12 61'),
    });

    expect(result.items[0]?.extractedTextHe).toBe('2002 12 61');
    expect((await readJson(join(root, 'reports/curator-report.json'))) as { warnings: string[] })
      .toMatchObject({
        warnings: [
          'extracted text from 1 files but found no Hebrew in any of them; suspect a character encoding fault',
        ],
      });
  });

  test('stays quiet when extracted text actually contains Hebrew', async () => {
    const root = await temporaryRoot();
    const files = [
      driveFile('solution', {
        name: 'פתרון.txt',
        mimeType: 'text/plain',
        path: 'פתרונות/פתרון.txt',
      }),
    ];
    const config = curator({
      collections: [
        curatedCollection({
          rules: [{ match: 'file-id', value: 'solution', relationship: 'part-of-release' }],
        }),
      ],
    });

    await buildCatalog({
      files,
      curator: config,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.from('קיבינימאט 2002'),
    });

    expect((await readJson(join(root, 'reports/curator-report.json'))) as { warnings: string[] })
      .toMatchObject({ warnings: [] });
  });

  test('builds nested deterministic artifacts and reloadable Hebrew search data', async () => {
    const root = await temporaryRoot();
    const files = [
      driveFile('solution', {
        name: 'פתרון.txt',
        mimeType: 'text/plain',
        path: 'פתרונות/פתרון.txt',
      }),
    ];
    const config = curator({
      collections: [
        curatedCollection({
          rules: [
            { match: 'file-id', value: 'solution', relationship: 'part-of-release' },
          ],
        }),
      ],
    });

    const result = await buildCatalog({
      files,
      curator: config,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.from('  קיבינימאט, הנה הפתרון.  '),
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.extractedTextHe).toBe('קיבינימאט, הנה הפתרון.');
    expect(await readJson(join(root, 'src/generated/catalog.json'))).toEqual(result);
    expect(await readJson(join(root, 'reports/curator-report.json'))).toEqual({
      errors: [],
      warnings: [],
      unclassifiedIds: [],
    });
    const searchJson = await readFile(join(root, 'public/data/search-index.json'), 'utf8');
    expect(searchJson.endsWith('\n')).toBe(false);
    const loaded = MiniSearch.loadJSON<SearchDocument>(searchJson, getSearchOptions());
    expect(createSearchEngine(loaded).search('פיפוש').map(({ id }) => id)).toContain(
      'collection:piposh-1',
    );
    expect((await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).endsWith('\n')).toBe(
      true,
    );
  });

  test('rejects empty archives before creating deployable data', async () => {
    const root = await temporaryRoot();
    const download = vi.fn<(fileId: string) => Promise<Buffer>>();

    await expect(
      buildCatalog({
        files: [],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download,
      }),
    ).rejects.toThrow(/archive contains no files/);
    await expect(readFile(join(root, 'src/generated/catalog.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(download).not.toHaveBeenCalled();
  });

  test('uses the configured minimum and accepts its exact boundary', async () => {
    const root = await temporaryRoot();
    const files = [driveFile('one')];

    await expect(
      buildCatalog({
        files,
        curator: curator({ minimumFileCount: 2 }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive contains 1 files; expected at least 2/);

    await expect(
      buildCatalog({
        files,
        curator: curator({ minimumFileCount: 2 }),
        minimumFileCount: 1,
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).resolves.toMatchObject({ items: [{ id: 'one' }] });
  });

  test('treats only a missing prior catalog as zero and rejects malformed prior catalogs', async () => {
    const missingRoot = await temporaryRoot();
    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root: missingRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).resolves.toBeDefined();

    const malformedRoot = await temporaryRoot();
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(malformedRoot, 'src/generated'), { recursive: true }),
    );
    await writeFile(join(malformedRoot, 'src/generated/catalog.json'), '{oops', 'utf8');
    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root: malformedRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/existing catalog is malformed/);

    const wrongShapeRoot = await temporaryRoot();
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(join(wrongShapeRoot, 'src/generated'), { recursive: true }),
    );
    await writeFile(join(wrongShapeRoot, 'src/generated/catalog.json'), '{"items":{}}', 'utf8');
    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root: wrongShapeRoot,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/existing catalog is malformed/);
  });

  test('uses a valid previous item count for shrink protection', async () => {
    const root = await temporaryRoot();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await writeFile(
      join(root, 'src/generated/catalog.json'),
      JSON.stringify({ items: Array.from({ length: 20 }, () => ({})) }),
      'utf8',
    );

    await expect(
      buildCatalog({
        files: Array.from({ length: 9 }, (_, index) => driveFile(`item-${index}`)),
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive shrank unexpectedly from 20 to 9 files/);
  });

  test('uses an explicit persisted baseline in a fresh root', async () => {
    const root = await temporaryRoot();

    await expect(
      buildCatalog({
        files: Array.from({ length: 9 }, (_, index) => driveFile(`item-${index}`)),
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        previousFileCount: 20,
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive shrank unexpectedly from 20 to 9 files/);
  });

  test('cannot use an explicit baseline to weaken a larger local baseline', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await writeFile(
      join(root, 'src/generated/catalog.json'),
      JSON.stringify({ items: Array.from({ length: 30 }, () => ({})) }),
      'utf8',
    );

    await expect(
      buildCatalog({
        files: Array.from({ length: 14 }, (_, index) => driveFile(`item-${index}`)),
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        previousFileCount: 20,
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive shrank unexpectedly from 30 to 14 files/);
  });

  test.each([-1, 1.5, Number.NaN])(
    'rejects an invalid persisted baseline: %s',
    async (previousFileCount) => {
      const root = await temporaryRoot();

      await expect(
        buildCatalog({
          files: [driveFile('one')],
          curator: curator(),
          root,
          generatedAt: '2026-08-26T12:00:00.000Z',
          previousFileCount,
          download: async () => Buffer.alloc(0),
        }),
      ).rejects.toThrow(/previousFileCount must be a nonnegative integer/);
    },
  );

  test('keeps extraction failures nonblocking and skips binary and oversized nullable text downloads', async () => {
    const root = await temporaryRoot();
    const files = [
      driveFile('broken-text', { name: 'broken.txt', mimeType: 'text/plain' }),
      driveFile('binary'),
      driveFile('nullable-text', { name: 'unknown.txt', mimeType: 'text/plain', size: null }),
      driveFile('large-text', { name: 'large.txt', mimeType: 'text/plain', size: 11 * 1024 * 1024 }),
    ];
    const download = vi.fn(async (id: string) => {
      if (id === 'broken-text') {
        throw new Error('Drive\n  unavailable');
      }
      return Buffer.from('טקסט לא ידוע');
    });

    const result = await buildCatalog({
      files,
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download,
    });

    expect(result.items.find(({ id }) => id === 'broken-text')?.extractedTextHe).toBe('');
    expect(result.items.find(({ id }) => id === 'nullable-text')?.extractedTextHe).toBe(
      'טקסט לא ידוע',
    );
    expect(download.mock.calls.map(([id]) => id)).toEqual(['broken-text', 'nullable-text']);
    expect(await readJson(join(root, 'reports/curator-report.json'))).toEqual({
      errors: [],
      warnings: [
        '4 files are not linked to a curated collection',
        'failed to extract text for item broken-text',
      ],
      unclassifiedIds: ['broken-text', 'binary', 'nullable-text', 'large-text'],
    });
  });

  test('never serializes upstream secrets from extraction failures', async () => {
    const root = await temporaryRoot();
    const secrets = [
      'Bearer eyJhbGciOiJIUzI1NiJ9.secret',
      '-----BEGIN PRIVATE KEY-----\\nprivate-material\\n-----END PRIVATE KEY-----',
      '{"private_key":"credential-json","client_email":"service@example.test"}',
      'api_key=AIza-secret-key',
      'https://example.test/file?X-Goog-Signature=signed-secret&token=private-token',
    ];

    await buildCatalog({
      files: [driveFile('text', { name: 'text.txt', mimeType: 'text/plain' })],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => {
        throw new Error(secrets.join(' '));
      },
    });

    const serializedArtifacts = (
      await Promise.all([
        readFile(join(root, 'src/generated/catalog.json'), 'utf8'),
        readFile(join(root, 'public/data/search-index.json'), 'utf8'),
        readFile(join(root, 'reports/curator-report.json'), 'utf8'),
      ])
    ).join('\n');
    for (const secret of secrets) {
      expect(serializedArtifacts).not.toContain(secret);
    }
    expect(serializedArtifacts).toContain('failed to extract text for item text');
  });

  test('enforces the aggregate extracted-text byte budget at its exact boundary', async () => {
    const root = await temporaryRoot();
    const files = ['first', 'second', 'third'].map((id) =>
      driveFile(id, { name: `${id}.txt`, mimeType: 'text/plain', size: null }),
    );
    const download = vi.fn(async (id: string) =>
      Buffer.from(id === 'first' ? 'אב' : id === 'second' ? 'ג' : 'ד'),
    );

    const result = await buildCatalog({
      files,
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      maxExtractedTextBytes: 4,
      download,
    });

    expect(result.items.map(({ extractedTextHe }) => extractedTextHe)).toEqual(['אב', '', '']);
    expect(download.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      warnings: [
        '3 files are not linked to a curated collection',
        '2 text files skipped because the extraction budget was exceeded',
      ],
    });
  });

  test.each([0, -1, 1.5, Number.NaN])(
    'rejects an invalid aggregate extraction budget: %s',
    async (maxExtractedTextBytes) => {
      const root = await temporaryRoot();
      await expect(
        buildCatalog({
          files: [driveFile('text', { name: 'text.txt', mimeType: 'text/plain' })],
          curator: curator(),
          root,
          generatedAt: '2026-08-26T12:00:00.000Z',
          maxExtractedTextBytes,
          download: async () => Buffer.from('טקסט'),
        }),
      ).rejects.toThrow(/maxExtractedTextBytes must be a positive integer/);
    },
  );

  test('writes a validation report while preserving deployable sentinels and doing no downloads', async () => {
    const root = await temporaryRoot();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    const previousCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    await writeFile(join(root, 'src/generated/catalog.json'), previousCatalog, 'utf8');
    await writeFile(join(root, 'public/data/search-index.json'), 'SEARCH SENTINEL', 'utf8');
    const download = vi.fn<(fileId: string) => Promise<Buffer>>();

    await expect(
      buildCatalog({
        files: [],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download,
      }),
    ).rejects.toThrow(/archive contains no files/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(previousCatalog);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toBe(
      'SEARCH SENTINEL',
    );
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      errors: ['archive contains no files'],
    });
    expect(download).not.toHaveBeenCalled();
  });

  test('optimizes only selected covers and deduplicates shared cover work', async () => {
    const root = await temporaryRoot();
    const png = await sharp({
      create: { width: 1000, height: 1200, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const files = [
      driveFile('cover', { name: 'cover.png', mimeType: 'image/png', size: png.length }),
      driveFile('unused', { name: 'unused.png', mimeType: 'image/png', size: png.length }),
    ];
    const config = curator({
      collections: [
        curatedCollection({ coverFileId: 'cover' }),
        curatedCollection({ slug: 'piposh-2', titleHe: 'פיפוש 2', coverFileId: 'cover' }),
      ],
    });
    const download = vi.fn(async (_fileId: string) => png);

    await buildCatalog({
      files,
      curator: config,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download,
    });

    expect(download.mock.calls.map(([id]) => id)).toEqual(['cover']);
    const output = await readFile(join(root, 'public/generated/covers/cover.webp'));
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBeLessThanOrEqual(720);
    expect(metadata.height).toBeLessThanOrEqual(960);
    await expect(readFile(join(root, 'public/generated/covers/unused.webp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('safely replaces a case-only stale cover alias on this filesystem', async () => {
    const root = await temporaryRoot();
    const coverDirectory = join(root, 'public/generated/covers');
    await mkdir(coverDirectory, { recursive: true });
    await writeFile(join(coverDirectory, 'ABC.webp'), 'STALE', 'utf8');
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();

    const result = await buildCatalog({
      files: [driveFile('abc', { name: 'cover.png', mimeType: 'image/png' })],
      curator: curator({ collections: [curatedCollection({ coverFileId: 'abc' })] }),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => png,
      faultInjection: { failPostCommitCleanup: true },
    });

    expect((await readdir(coverDirectory)).filter((name) => name.endsWith('.webp'))).toEqual([
      'abc.webp',
    ]);
    expect(await sharp(join(coverDirectory, 'abc.webp')).metadata()).toMatchObject({
      format: 'webp',
    });
    expect(result.collections[0]?.coverUrl).toBe('/generated/covers/abc.webp');

    await expect(
      buildCatalog({
        files: [driveFile('abc', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({ collections: [curatedCollection({ coverFileId: 'abc' })] }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => png,
      }),
    ).resolves.toBeDefined();
    expect((await readdir(coverDirectory)).filter((name) => name.endsWith('.webp'))).toEqual([
      'abc.webp',
    ]);
  });

  test('rejects portable selected-cover collisions before downloading', async () => {
    const root = await temporaryRoot();
    const download = vi.fn<(fileId: string) => Promise<Buffer>>();

    await expect(
      buildCatalog({
        files: [
          driveFile('ABC', { name: 'ABC.png', mimeType: 'image/png' }),
          driveFile('abc', { name: 'abc.png', mimeType: 'image/png' }),
        ],
        curator: curator({
          collections: [
            curatedCollection({ coverFileId: 'ABC' }),
            curatedCollection({ slug: 'two', titleHe: 'שתיים', coverFileId: 'abc' }),
          ],
        }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download,
      }),
    ).rejects.toThrow(/cover file IDs resolve to the same portable target: ABC, abc/);
    expect(download).not.toHaveBeenCalled();
  });

  test('reports cover failure context without overwriting catalog or search', async () => {
    const root = await temporaryRoot();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    const oldCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    await writeFile(join(root, 'src/generated/catalog.json'), oldCatalog, 'utf8');
    await writeFile(join(root, 'public/data/search-index.json'), 'OLD SEARCH', 'utf8');

    await expect(
      buildCatalog({
        files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({
          collections: [curatedCollection({ coverFileId: 'cover' })],
        }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.from('not an image'),
      }),
    ).rejects.toThrow(/^failed to process cover cover for collection piposh-1$/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(oldCatalog);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toBe('OLD SEARCH');
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      errors: ['failed to process cover cover for collection piposh-1'],
    });
  });

  test('never serializes upstream secrets from cover download failures', async () => {
    const root = await temporaryRoot();
    const secrets = [
      'Bearer cover-token',
      '-----BEGIN PRIVATE KEY-----',
      '{"private_key":"cover-credential"}',
      'api_key=cover-api-key',
      'https://example.test/file?signature=signed-value&token=secret',
    ];

    await expect(
      buildCatalog({
        files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({ collections: [curatedCollection({ coverFileId: 'cover' })] }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => {
          throw new Error(secrets.join(' '));
        },
      }),
    ).rejects.toThrow(/^failed to process cover cover for collection piposh-1$/);

    const report = await readFile(join(root, 'reports/curator-report.json'), 'utf8');
    for (const secret of secrets) {
      expect(report).not.toContain(secret);
    }
  });

  test.each(['../../../outside', 'folder/cover', 'folder\\cover', '.', '..', 'cover.png'])(
    'blocks unsafe cover paths without writing outside the cover directory: %s',
    async (coverFileId) => {
      const root = await temporaryRoot();
      const sentinelPath = join(root, 'outside.webp');
      await writeFile(sentinelPath, 'OUTSIDE SENTINEL', 'utf8');

      await expect(
        buildCatalog({
          files: [
            driveFile(coverFileId, { name: 'cover.png', mimeType: 'image/png' }),
          ],
          curator: curator({
            collections: [curatedCollection({ coverFileId })],
          }),
          root,
          generatedAt: '2026-08-26T12:00:00.000Z',
          download: async () => Buffer.from('should not download'),
        }),
      ).rejects.toThrow(/has invalid cover file ID/);

      expect(await readFile(sentinelPath, 'utf8')).toBe('OUTSIDE SENTINEL');
      expect((await recursiveNames(root)).filter((name) => name.endsWith('.webp'))).toEqual([
        'outside.webp',
      ]);
    },
  );

  test('preserves catalog and search if an optimized cover cannot be written', async () => {
    const root = await temporaryRoot();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    await mkdir(join(root, 'public/generated'), { recursive: true });
    const oldCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    await writeFile(join(root, 'src/generated/catalog.json'), oldCatalog, 'utf8');
    await writeFile(join(root, 'public/data/search-index.json'), 'OLD SEARCH', 'utf8');
    await writeFile(join(root, 'public/generated/covers'), 'not a directory', 'utf8');
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();

    await expect(
      buildCatalog({
        files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({
          collections: [curatedCollection({ coverFileId: 'cover' })],
        }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => png,
      }),
    ).rejects.toThrow(/failed to promote archive artifacts/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(oldCatalog);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toBe('OLD SEARCH');
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      errors: ['failed to promote archive artifacts'],
    });
  });

  test('rolls back promoted artifacts and stale-cover deletion after a later promotion failure', async () => {
    const root = await temporaryRoot();
    const oldCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    const oldSearch = 'OLD SEARCH';
    const oldCover = Buffer.from('OLD COVER');
    const staleCover = Buffer.from('STALE COVER');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    await mkdir(join(root, 'public/generated/covers'), { recursive: true });
    await mkdir(join(root, 'reports/curator-report.json'), { recursive: true });
    await writeFile(join(root, 'src/generated/catalog.json'), oldCatalog, 'utf8');
    await writeFile(join(root, 'public/data/search-index.json'), oldSearch, 'utf8');
    await writeFile(join(root, 'public/generated/covers/cover.webp'), oldCover);
    await writeFile(join(root, 'public/generated/covers/stale.webp'), staleCover);
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();

    await expect(
      buildCatalog({
        files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
        curator: curator({ collections: [curatedCollection({ coverFileId: 'cover' })] }),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => png,
      }),
    ).rejects.toThrow(/failed to promote archive artifacts/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(oldCatalog);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toBe(oldSearch);
    expect(await readFile(join(root, 'public/generated/covers/cover.webp'))).toEqual(oldCover);
    expect(await readFile(join(root, 'public/generated/covers/stale.webp'))).toEqual(staleCover);
    expect(
      (await recursiveNames(root)).filter((name) => /\.(?:stage|backup|tmp)(?:\.|$)/u.test(name)),
    ).toEqual([]);
  });

  test('removes only stale top-level WebP covers after a successful transaction', async () => {
    const root = await temporaryRoot();
    const coverDirectory = join(root, 'public/generated/covers');
    await mkdir(join(coverDirectory, 'nested'), { recursive: true });
    await writeFile(join(coverDirectory, 'stale.webp'), 'STALE', 'utf8');
    await writeFile(join(coverDirectory, 'keep.txt'), 'KEEP', 'utf8');
    await writeFile(join(coverDirectory, 'nested/nested.webp'), 'NESTED', 'utf8');

    await buildCatalog({
      files: [driveFile('one')],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.alloc(0),
    });

    expect(await recursiveNames(coverDirectory)).toEqual([
      'keep.txt',
      'nested',
      join('nested', 'nested.webp'),
    ]);
  });

  test('uses an exclusive per-root lock and releases it after success and failure', async () => {
    const root = await temporaryRoot();
    let releaseDownload!: () => void;
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const downloadReleased = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const input = {
      files: [driveFile('text', { name: 'text.txt', mimeType: 'text/plain' })],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => {
        markDownloadStarted();
        await downloadReleased;
        return Buffer.from('טקסט');
      },
    };
    const firstBuild = buildCatalog(input);
    await downloadStarted;

    await expect(buildCatalog(input)).rejects.toThrow(/catalog build already in progress/);
    releaseDownload();
    await expect(firstBuild).resolves.toBeDefined();
    await expect(buildCatalog(input)).resolves.toBeDefined();

    await expect(
      buildCatalog({ ...input, files: [] }),
    ).rejects.toThrow(/archive contains no files/);
    await expect(buildCatalog(input)).resolves.toBeDefined();
  });

  test('recovers a lock owned by a dead same-host process', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.astro'), { recursive: true });
    await writeFile(
      join(root, '.astro/catalog-build.lock'),
      JSON.stringify({
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: '2026-08-25T00:00:00.000Z',
        transactionId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      'utf8',
    );

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).resolves.toBeDefined();
    expect(await recursiveNames(join(root, '.astro'))).not.toContain('catalog-build.lock');
  });

  test.each([
    ['recent foreign', 'foreign.example', process.pid, new Date().toISOString(), false],
    ['ancient foreign', 'foreign.example', process.pid, '2020-01-01T00:00:00.000Z', true],
    ['old live same-host', hostname(), process.pid, '2020-01-01T00:00:00.000Z', false],
    ['future foreign', 'foreign.example', process.pid, '2999-01-01T00:00:00.000Z', false],
    ['invalid-date foreign', 'foreign.example', process.pid, 'not-a-date', false],
  ] as const)(
    'applies conservative ownership rules to a %s lock',
    async (_label, ownerHost, pid, createdAt, shouldRecover) => {
      const root = await temporaryRoot();
      await mkdir(join(root, '.astro'), { recursive: true });
      await writeFile(
        join(root, '.astro/catalog-build.lock'),
        JSON.stringify({
          pid,
          hostname: ownerHost,
          createdAt,
          transactionId: '123e4567-e89b-42d3-a456-426614174000',
        }),
        'utf8',
      );
      const build = buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      });

      if (shouldRecover) {
        await expect(build).resolves.toBeDefined();
      } else {
        await expect(build).rejects.toThrow(/catalog build already in progress/);
      }
    },
  );

  test('uses file age only for malformed lock metadata', async () => {
    const recentRoot = await temporaryRoot();
    const oldRoot = await temporaryRoot();
    for (const root of [recentRoot, oldRoot]) {
      await mkdir(join(root, '.astro'), { recursive: true });
      await writeFile(join(root, '.astro/catalog-build.lock'), '{malformed', 'utf8');
    }
    await utimes(
      join(oldRoot, '.astro/catalog-build.lock'),
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z'),
    );
    const input = (root: string) => ({
      files: [driveFile('one')],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.alloc(0),
    });

    await expect(buildCatalog(input(recentRoot))).rejects.toThrow(
      /catalog build already in progress/,
    );
    await expect(buildCatalog(input(oldRoot))).resolves.toBeDefined();
  });

  test.each([
    ['invalid timestamp', { createdAt: 'not-a-date' }],
    ['far-future timestamp', { createdAt: '2999-01-01T00:00:00.000Z' }],
    ['unsafe pid', { pid: Number.MAX_SAFE_INTEGER }],
    ['extra field', { extra: 'not-allowed' }],
  ] as const)('falls back to an old lock mtime for %s metadata', async (_label, override) => {
    const root = await temporaryRoot();
    const lockPath = join(root, '.astro/catalog-build.lock');
    await mkdir(join(root, '.astro'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: '2026-08-26T12:00:00.000Z',
        transactionId: '123e4567-e89b-42d3-a456-426614174000',
        ...override,
      }),
      'utf8',
    );
    await utimes(
      lockPath,
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2020-01-01T00:00:00.000Z'),
    );

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).resolves.toBeDefined();
  });

  test('does not steal a recent lock with an unsafe pid', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.astro'), { recursive: true });
    await writeFile(
      join(root, '.astro/catalog-build.lock'),
      JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        transactionId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      'utf8',
    );

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/catalog build already in progress/);
  });

  test('fails safely when process liveness cannot be determined', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.astro'), { recursive: true });
    await writeFile(
      join(root, '.astro/catalog-build.lock'),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
        transactionId: '123e4567-e89b-42d3-a456-426614174000',
      }),
      'utf8',
    );
    const failure = Object.assign(new Error('sensitive process detail'), { code: 'EIO' });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw failure;
    });

    try {
      await expect(
        buildCatalog({
          files: [driveFile('one')],
          curator: curator(),
          root,
          generatedAt: '2026-08-26T12:00:00.000Z',
          download: async () => Buffer.alloc(0),
        }),
      ).rejects.toThrow(/^catalog build failed$/);
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
    } finally {
      kill.mockRestore();
    }
  });

  test('rejects hostile transaction manifests before touching referenced files', async () => {
    const transactionId = '123e4567-e89b-42d3-a456-426614174000';
    const baseEntry = {
      kind: 'write',
      target: 'src/generated/catalog.json',
      stage: `src/generated/.catalog-transaction-${transactionId}-0.stage`,
      backup: `src/generated/.catalog-transaction-${transactionId}-0.backup`,
    };
    const hostileManifests: unknown[] = [
      { version: 1, state: 'committed', transactionId, entries: [] },
      { version: 2, state: 'committed', transactionId, entries: [] },
      { version: 1, state: 'unknown', transactionId, entries: [] },
      { version: 1, state: 'committed', transactionId: 'not-a-uuid', entries: [] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, extra: true }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, target: 'keep.txt' }] },
      { version: 1, state: 'precommit', transactionId, entries: [{ ...baseEntry, target: 'keep.txt' }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, target: '../outside.txt' }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, target: '/tmp/outside.txt' }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, backup: 'keep.txt' }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, stage: 'keep.txt' }] },
      { version: 1, state: 'committed', transactionId, entries: [{ ...baseEntry, kind: 'delete' }] },
      { version: 1, state: 'committed', transactionId, entries: [baseEntry, baseEntry] },
      {
        version: 1,
        state: 'committed',
        transactionId,
        entries: [
          {
            kind: 'delete',
            target: 'public/generated/covers/ABC.webp',
            backup: `public/generated/covers/.catalog-transaction-${transactionId}-0.backup`,
          },
          {
            kind: 'write',
            target: 'public/generated/covers/abc.webp',
            stage: `public/generated/covers/.catalog-transaction-${transactionId}-1.stage`,
            backup: `public/generated/covers/.catalog-transaction-${transactionId}-1.backup`,
          },
        ],
      },
      { version: 1, state: 'committed', transactionId, entries: 'secret-manifest-content' },
    ];

    for (const [index, manifest] of hostileManifests.entries()) {
      const root = await temporaryRoot();
      const external = await temporaryRoot();
      const sentinel = join(root, 'keep.txt');
      const externalSentinel = join(external, 'outside.txt');
      await writeFile(sentinel, 'KEEP', 'utf8');
      await writeFile(externalSentinel, 'EXTERNAL', 'utf8');
      await mkdir(join(root, '.astro'), { recursive: true });
      await writeFile(
        join(root, '.astro/catalog-build-transaction.json'),
        JSON.stringify(manifest),
        'utf8',
      );

      let failure: unknown;
      try {
        await buildCatalog({
          files: [driveFile(`one-${index}`)],
          curator: curator(),
          root,
          generatedAt: '2026-08-26T12:00:00.000Z',
          download: async () => Buffer.alloc(0),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('catalog build failed');
      expect(inspect(failure, { depth: null })).not.toContain('secret-manifest-content');
      expect(await readFile(sentinel, 'utf8')).toBe('KEEP');
      expect(await readFile(externalSentinel, 'utf8')).toBe('EXTERNAL');
    }
  });

  test('rejects a genuine-shaped manifest with a cover deletion after a cover write', async () => {
    const root = await temporaryRoot();
    const transactionId = '123e4567-e89b-42d3-a456-426614174000';
    const coverDirectory = join(root, 'public/generated/covers');
    const selectedCover = join(coverDirectory, 'new.webp');
    const staleCover = join(coverDirectory, 'stale.webp');
    await mkdir(join(root, '.astro'), { recursive: true });
    await mkdir(coverDirectory, { recursive: true });
    await writeFile(selectedCover, 'SELECTED SENTINEL', 'utf8');
    await writeFile(staleCover, 'STALE SENTINEL', 'utf8');
    await writeFile(
      join(root, '.astro/catalog-build-transaction.json'),
      JSON.stringify({
        version: 1,
        state: 'precommit',
        transactionId,
        entries: [
          {
            kind: 'write',
            target: 'public/generated/covers/new.webp',
            stage: `public/generated/covers/.catalog-transaction-${transactionId}-0.stage`,
            backup: `public/generated/covers/.catalog-transaction-${transactionId}-0.backup`,
            original: 'file',
          },
          {
            kind: 'delete',
            target: 'public/generated/covers/stale.webp',
            backup: `public/generated/covers/.catalog-transaction-${transactionId}-1.backup`,
            original: 'file',
          },
          {
            kind: 'write',
            target: 'src/generated/catalog.json',
            stage: `src/generated/.catalog-transaction-${transactionId}-2.stage`,
            backup: `src/generated/.catalog-transaction-${transactionId}-2.backup`,
            original: 'missing',
          },
          {
            kind: 'write',
            target: 'public/data/search-index.json',
            stage: `public/data/.catalog-transaction-${transactionId}-3.stage`,
            backup: `public/data/.catalog-transaction-${transactionId}-3.backup`,
            original: 'missing',
          },
          {
            kind: 'write',
            target: 'reports/curator-report.json',
            stage: `reports/.catalog-transaction-${transactionId}-4.stage`,
            backup: `reports/.catalog-transaction-${transactionId}-4.backup`,
            original: 'missing',
          },
        ],
      }),
      'utf8',
    );

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow('catalog build failed');
    expect(await readFile(selectedCover, 'utf8')).toBe('SELECTED SENTINEL');
    expect(await readFile(staleCover, 'utf8')).toBe('STALE SENTINEL');
  });

  test('removes only exact builder-owned orphan manifest temp names', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, '.astro'), { recursive: true });
    const validOrphan = '.transaction-manifest-123e4567-e89b-42d3-a456-426614174000.tmp';
    const unrelated = '.transaction-manifest-not-a-uuid.tmp';
    await writeFile(join(root, '.astro', validOrphan), 'ORPHAN', 'utf8');
    await writeFile(join(root, '.astro', unrelated), 'KEEP', 'utf8');

    await buildCatalog({
      files: [driveFile('one')],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.alloc(0),
    });

    expect(await recursiveNames(join(root, '.astro'))).toContain(unrelated);
    expect(await recursiveNames(join(root, '.astro'))).not.toContain(validOrphan);
  });

  test.each([
    'reports',
    '.astro',
    'src/generated',
    'public/data',
    'public/generated/covers',
  ])('never follows a symlinked managed parent: %s', async (relativeParent) => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const sentinel = join(external, 'sentinel.txt');
    await writeFile(sentinel, 'EXTERNAL', 'utf8');
    const parentPath = join(root, relativeParent);
    await mkdir(join(parentPath, '..'), { recursive: true });
    await symlink(external, parentPath, 'dir');
    const before = await recursiveNames(external);

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/catalog build failed|failed to promote archive artifacts/);

    expect(await readFile(sentinel, 'utf8')).toBe('EXTERNAL');
    expect(await recursiveNames(external)).toEqual(before);
  });

  test('never follows a managed final-file symlink', async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const sentinel = join(external, 'catalog.json');
    await writeFile(sentinel, JSON.stringify({ items: [] }), 'utf8');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await symlink(sentinel, join(root, 'src/generated/catalog.json'));

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/catalog build failed/);
    expect(await readFile(sentinel, 'utf8')).toBe(JSON.stringify({ items: [] }));
  });

  test('reports sanitized promotion failure after restoring deployable bytes', async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const externalSearch = join(external, 'search.json');
    await writeFile(externalSearch, 'EXTERNAL SEARCH', 'utf8');
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    const oldCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    await writeFile(join(root, 'src/generated/catalog.json'), oldCatalog, 'utf8');
    await symlink(externalSearch, join(root, 'public/data/search-index.json'));

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/^failed to promote archive artifacts$/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(oldCatalog);
    expect(await readFile(externalSearch, 'utf8')).toBe('EXTERNAL SEARCH');
    expect(await readJson(join(root, 'reports/curator-report.json'))).toMatchObject({
      errors: ['failed to promote archive artifacts'],
    });
  });

  test('returns success after post-commit cleanup failure and recovers it next run', async () => {
    const root = await temporaryRoot();
    const input = {
      files: [driveFile('one')],
      curator: curator(),
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => Buffer.alloc(0),
    };

    await expect(
      buildCatalog({
        ...input,
        faultInjection: { failPostCommitCleanup: true },
      }),
    ).resolves.toBeDefined();
    expect(await readJson(join(root, 'src/generated/catalog.json'))).toMatchObject({
      items: [{ id: 'one' }],
    });
    expect((await recursiveNames(join(root, '.astro'))).some((name) => name.includes('transaction'))).toBe(
      true,
    );

    await expect(buildCatalog(input)).resolves.toBeDefined();
    expect((await recursiveNames(root)).filter((name) => /\.(?:stage|backup)$/u.test(name))).toEqual(
      [],
    );
    expect((await recursiveNames(join(root, '.astro'))).some((name) => name.includes('transaction'))).toBe(
      false,
    );
  });

  test('recovers an interrupted pre-commit rollback before the next build', async () => {
    const root = await temporaryRoot();
    const oldCatalog = JSON.stringify({ items: [{ id: 'old' }] });
    const oldSearch = 'OLD SEARCH';
    await mkdir(join(root, 'src/generated'), { recursive: true });
    await mkdir(join(root, 'public/data'), { recursive: true });
    await mkdir(join(root, 'reports/curator-report.json'), { recursive: true });
    await writeFile(join(root, 'src/generated/catalog.json'), oldCatalog, 'utf8');
    await writeFile(join(root, 'public/data/search-index.json'), oldSearch, 'utf8');

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
        faultInjection: { failPreCommitRollback: true },
      }),
    ).rejects.toThrow(/^failed to promote archive artifacts$/);

    const { rm } = await import('node:fs/promises');
    await rm(join(root, 'reports/curator-report.json'), { recursive: true });
    await expect(
      buildCatalog({
        files: [],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/archive contains no files/);

    expect(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).toBe(oldCatalog);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toBe(oldSearch);
    expect((await recursiveNames(root)).filter((name) => /\.(?:stage|backup)$/u.test(name))).toEqual(
      [],
    );
  });

  test('rejects a lock-file symlink without touching its external target', async () => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    const sentinel = join(external, 'lock.txt');
    await writeFile(sentinel, 'LOCK SENTINEL', 'utf8');
    await mkdir(join(root, '.astro'), { recursive: true });
    await symlink(sentinel, join(root, '.astro/catalog-build.lock'));

    await expect(
      buildCatalog({
        files: [driveFile('one')],
        curator: curator(),
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.alloc(0),
      }),
    ).rejects.toThrow(/catalog build failed/);
    expect(await readFile(sentinel, 'utf8')).toBe('LOCK SENTINEL');
  });

  test('is byte-deterministic for fixed input and time and does not mutate inputs', async () => {
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    const files = [
      driveFile('solution', {
        name: 'פתרון.txt',
        mimeType: 'text/plain',
        path: 'פתרונות/פתרון.txt',
      }),
    ];
    const config = curator({
      collections: [
        curatedCollection({
          aliasesHe: ['המקור'],
          rules: [{ match: 'file-id', value: 'solution', relationship: 'about' }],
        }),
      ],
    });
    const beforeFiles = structuredClone(files);
    const beforeConfig = structuredClone(config);
    const build = (root: string) =>
      buildCatalog({
        files,
        curator: config,
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        download: async () => Buffer.from('פתרון'),
      });

    await build(firstRoot);
    await build(secondRoot);

    for (const relativePath of [
      'src/generated/catalog.json',
      'public/data/search-index.json',
      'reports/curator-report.json',
    ]) {
      expect(await readFile(join(firstRoot, relativePath))).toEqual(
        await readFile(join(secondRoot, relativePath)),
      );
    }
    expect(files).toEqual(beforeFiles);
    expect(config).toEqual(beforeConfig);
  });
});
