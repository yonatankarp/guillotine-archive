import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  loadCatalog,
  loadMissingList,
  parseCatalog,
  parseMissingList,
} from '../../src/lib/catalog';

const validCatalog = {
  generatedAt: '2026-08-26T00:00:00.000Z',
  collections: [],
  items: [],
  categories: [],
  releases: [],
  releaseFacets: { types: [], subjectSlugs: [], years: [] },
};

const validItem = {
  id: 'one',
  name: 'one.zip',
  mimeType: 'application/zip',
  size: 12,
  modifiedTime: '2026-08-26T00:00:00.000Z',
  path: 'משחקים מלאים/one.zip',
  viewUrl: 'https://drive.google.com/file/d/one/view',
  downloadUrl: 'https://drive.google.com/uc?id=one',
  category: 'משחקים מלאים',
  kind: 'build',
  releaseSlug: 'full-games',
  aliasesHe: [],
  tagsHe: [],
  collectionLinks: [],
};

describe('parseCatalog', () => {
  test('accepts a valid generated catalog', () => {
    expect(parseCatalog(JSON.stringify(validCatalog))).toEqual(validCatalog);
  });

  /* The pipeline that writes derivatives (src/catalog/build.ts) and the schema that reads
     them are separate modules, and this schema is strict — so a rendition kind added to the
     writer and not here rejects the entire catalog. That failure surfaces only on a real
     credentialed sync, thirty minutes in, long after the change that caused it. Enumerating
     every field of ItemDerivatives here turns that into a unit-test failure instead. */
  test('accepts every rendition the derivative pipeline can produce', () => {
    const rendition = { path: 'generated/derivatives/one.bin', bytes: 1 };
    const withEveryDerivative = {
      ...validCatalog,
      items: [
        {
          ...validItem,
          derivatives: {
            thumb: { ...rendition, width: 400, height: 300 },
            view: { ...rendition, width: 1600, height: 1200 },
            reader: { ...rendition, width: 2400, height: 1800 },
            audio: rendition,
            video: rendition,
            poster: { ...rendition, width: 640, height: 360 },
            durationMillis: 1000,
          },
        },
      ],
    };

    expect(() => parseCatalog(JSON.stringify(withEveryDerivative))).not.toThrow();
  });

  test('says what failed rather than only that something did', () => {
    const bad = { ...validCatalog, items: [{ ...validItem, kind: 'not-a-kind' }] };

    expect(() => parseCatalog(JSON.stringify(bad))).toThrow(/items\.0\.kind/u);
  });

  test('rejects malformed generated data instead of presenting an empty archive', () => {
    expect(() => parseCatalog('{"generatedAt":42,"collections":[]}')).toThrow(
      'generated catalog is invalid',
    );
  });

  test.each([
    { ...validCatalog, generatedAt: ' ' },
    { ...validCatalog, categories: [' '] },
    { ...validCatalog, items: [{ ...validItem, name: ' ' }] },
  ])('rejects whitespace-only required strings', (candidate) => {
    expect(() => parseCatalog(JSON.stringify(candidate))).toThrow('generated catalog is invalid');
  });

  test('preserves nonblank Drive names and paths byte-for-byte', () => {
    const item = {
      ...validItem,
      name: ' one.zip ',
      path: ' משחקים מלאים/one.zip ',
      extractedTextHe: ' טקסט מן הארכיון ',
    };
    const candidate = {
      ...validCatalog,
      categories: [' משחקים  מלאים '],
      items: [item],
    };

    const parsed = parseCatalog(JSON.stringify(candidate));
    expect(parsed.categories).toEqual(candidate.categories);
    expect(parsed.items[0]).toMatchObject({
      name: item.name,
      path: item.path,
      extractedTextHe: item.extractedTextHe,
    });
  });

  test('rejects an absolute URL that the platform URL parser would trim', () => {
    const candidate = {
      ...validCatalog,
      items: [{ ...validItem, viewUrl: ` ${validItem.viewUrl}` }],
    };

    expect(() => parseCatalog(JSON.stringify(candidate))).toThrow('generated catalog is invalid');
  });

  describe.each([
    ['javascript URL', 'javascript:alert(1)'],
    ['data URL', 'data:text/html,unsafe'],
    ['FTP URL', 'ftp://drive.google.com/file/d/one/view'],
    ['HTTP URL', 'http://drive.google.com/file/d/one/view'],
    ['credential-bearing URL', 'https://user:password@drive.google.com/file/d/one/view'],
    ['unrelated host', 'https://example.com/file/d/one/view'],
    ['lookalike host', 'https://drive.google.com.example.com/file/d/one/view'],
  ])('with an unsafe %s', (_description, url) => {
    test.each(['viewUrl', 'downloadUrl'] as const)('rejects it as %s', (field) => {
      const candidate = {
        ...validCatalog,
        items: [{ ...validItem, [field]: url }],
      };

      expect(() => parseCatalog(JSON.stringify(candidate)), field).toThrow(
        'generated catalog is invalid',
      );
    });
  });

  test.each([
    {
      viewUrl: 'https://drive.google.com/file/d/one/view?resourcekey=opaque-key',
      downloadUrl: 'https://drive.google.com/uc?export=download&id=one&resourcekey=opaque-key',
    },
    {
      viewUrl: 'https://docs.google.com/document/d/one/edit?usp=drive_link',
      downloadUrl: 'https://docs.google.com/document/d/one/export?format=pdf',
    },
    {
      viewUrl: 'https://drive.google.com/open?id=one',
      downloadUrl: null,
    },
  ])('accepts HTTPS Drive and Docs URL shapes, including null downloads', (urls) => {
    const candidate = {
      ...validCatalog,
      items: [{ ...validItem, ...urls }],
    };

    expect(parseCatalog(JSON.stringify(candidate)).items[0]).toMatchObject(urls);
  });

  test.each([
    ['viewUrl', 'https://drive.google.com/file/d/different-item/view'],
    ['viewUrl', 'https://docs.google.com/document/d/different-item/edit'],
    ['downloadUrl', 'https://drive.google.com/uc?export=download&id=different-item'],
  ] as const)('rejects a %s that references a different Drive item', (field, url) => {
    const candidate = {
      ...validCatalog,
      items: [{ ...validItem, [field]: url }],
    };

    expect(() => parseCatalog(JSON.stringify(candidate))).toThrow('generated catalog is invalid');
  });
});

describe('parseMissingList', () => {
  const validMissingList = {
    generatedAt: '2026-08-26T00:00:00.000Z',
    sourcePath: 'מה חסר?',
    headerHe: ['פריט', 'הערה'],
    rows: [['קופסה של פיפוש', '']],
  };

  /* Same failure the derivative renditions above guard against, one artifact over: the
     writer is src/catalog/build.ts and this schema is strict, so a field added there and
     not here rejects the whole file and blanks the page — and only on a credentialed
     sync, which is the one run nobody can repeat cheaply. */
  test('accepts exactly what the sheet export pipeline writes', () => {
    expect(parseMissingList(JSON.stringify(validMissingList))).toEqual(validMissingList);
  });

  test('accepts an exported sheet whose cells are empty', () => {
    const candidate = { ...validMissingList, rows: [['', ''], ['', '']] };

    expect(parseMissingList(JSON.stringify(candidate)).rows).toEqual(candidate.rows);
  });

  test('rejects a row that does not match the header width', () => {
    const candidate = { ...validMissingList, rows: [['one cell only']] };

    expect(() => parseMissingList(JSON.stringify(candidate))).toThrow(
      'generated missing list is invalid',
    );
  });

  test('rejects an unknown key rather than rendering it', () => {
    const candidate = { ...validMissingList, sheetName: 'tab one' };

    expect(() => parseMissingList(JSON.stringify(candidate))).toThrow(
      'generated missing list is invalid',
    );
  });

  test('says what failed rather than only that something did', () => {
    const candidate = { ...validMissingList, headerHe: [42] };

    expect(() => parseMissingList(JSON.stringify(candidate))).toThrow(/headerHe\.0/u);
  });

  test('rejects malformed JSON', () => {
    expect(() => parseMissingList('{broken')).toThrow('generated missing list is invalid');
  });
});

describe('loadMissingList', () => {
  /* An absent artifact is the normal state before the first credentialed sync, and the
     deployment has to build without one. */
  test('returns an empty list when no sync has ever exported one', () => {
    expect(loadMissingList('/definitely/missing/missing-list.json')).toEqual({
      generatedAt: '1970-01-01T00:00:00.000Z',
      sourcePath: 'מה חסר?',
      headerHe: [],
      rows: [],
    });
  });

  test('propagates a malformed existing file instead of presenting an empty list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'missing-list-loader-'));
    await mkdir(join(root, 'src/generated'), { recursive: true });
    const path = join(root, 'src/generated/missing-list.json');
    await writeFile(path, '{broken');

    expect(() => loadMissingList(path)).toThrow('generated missing list is invalid');
  });
});

describe('loadCatalog', () => {
  test('returns the explicit development catalog only when the file is missing', () => {
    expect(loadCatalog('/definitely/missing/catalog.json')).toEqual({
      generatedAt: '1970-01-01T00:00:00.000Z',
      collections: [],
      items: [],
      categories: [],
      releases: [],
      releaseFacets: { types: [], subjectSlugs: [], years: [] },
    });
  });

  test('propagates malformed JSON from an existing generated file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catalog-loader-'));
    await mkdir(join(root, 'src/generated'), { recursive: true });
    const path = join(root, 'src/generated/catalog.json');
    await writeFile(path, '{broken');

    expect(() => loadCatalog(path)).toThrow('generated catalog is invalid');
  });
});
