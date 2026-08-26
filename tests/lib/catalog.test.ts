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
