import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadCatalog, parseCatalog } from '../../src/lib/catalog';

const validCatalog = {
  generatedAt: '2026-08-26T00:00:00.000Z',
  collections: [],
  items: [],
  categories: [],
};

const validItem = {
  id: 'one',
  name: 'one.zip',
  mimeType: 'application/zip',
  size: 12,
  modifiedTime: '2026-08-26T00:00:00.000Z',
  path: 'משחקים מלאים/one.zip',
  parentIds: ['root'],
  viewUrl: 'https://drive.google.com/file/d/one/view',
  downloadUrl: 'https://drive.google.com/uc?id=one',
  category: 'משחקים מלאים',
  aliasesHe: [],
  tagsHe: [],
  collectionLinks: [],
};

describe('parseCatalog', () => {
  test('accepts a valid generated catalog', () => {
    expect(parseCatalog(JSON.stringify(validCatalog))).toEqual(validCatalog);
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

describe('loadCatalog', () => {
  test('returns the explicit development catalog only when the file is missing', () => {
    expect(loadCatalog('/definitely/missing/catalog.json')).toEqual({
      generatedAt: '1970-01-01T00:00:00.000Z',
      collections: [],
      items: [],
      categories: [],
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
