import { describe, expect, test } from 'vitest';
import type { CatalogCollection, CatalogItem } from '../../src/catalog/types';
import {
  driveActions,
  fileTypeLabel,
  formatFileCount,
  formatFileSize,
  groupOfficialItems,
  officialCollectionLinks,
} from '../../src/lib/archive';

const item = (overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'item-one',
  name: 'piposh1.exe',
  mimeType: 'application/x-msdownload',
  size: 1_048_576,
  modifiedTime: null,
  path: 'משחקים מלאים/פיפוש 1/גרסה 2/piposh1.exe',
  viewUrl: 'https://drive.google.com/file/d/item-one/view',
  downloadUrl: 'https://drive.google.com/uc?export=download&id=item-one',
  category: 'משחקים מלאים',
  kind: 'build',
  releaseSlug: 'piposh-1',
  aliasesHe: [],
  tagsHe: [],
  collectionLinks: [
    {
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      relationship: 'part-of-release',
      groupHe: 'גרסאות בעברית',
    },
  ],
  ...overrides,
});

const collection: CatalogCollection = {
  slug: 'piposh-1',
  titleHe: 'פיפוש 1',
  type: 'game',
  year: 1999,
  summaryHe: 'סיכום',
  aliasesHe: [],
  tagsHe: [],
  rules: [
    {
      match: 'path-prefix',
      value: 'משחקים מלאים/פיפוש 1',
      relationship: 'part-of-release',
      groupHe: 'גרסאות בעברית',
    },
    {
      match: 'path-prefix',
      value: 'משחקים מלאים/פיפוש 1 - אנגלית',
      relationship: 'part-of-release',
      groupHe: 'מהדורות רשמיות בשפות זרות',
    },
  ],
  exclude: [],
  coverUrl: null,
  itemIds: ['foreign', 'official', 'press', 'missing'],
};

describe('groupOfficialItems', () => {
  test('uses collection order while keeping only matching part-of-release items', () => {
    const items = new Map<string, CatalogItem>([
      [
        'foreign',
        item({
          id: 'foreign',
          name: 'piposh1-english.exe',
          collectionLinks: [
            {
              slug: 'piposh-1',
              titleHe: 'פיפוש 1',
              relationship: 'part-of-release',
              groupHe: 'מהדורות רשמיות בשפות זרות',
            },
          ],
        }),
      ],
      ['official', item({ id: 'official' })],
      [
        'press',
        item({
          id: 'press',
          name: 'ביקורת.jpg',
          collectionLinks: [
            {
              slug: 'piposh-1',
              titleHe: 'פיפוש 1',
              relationship: 'about',
              groupHe: 'עיתונות',
            },
          ],
        }),
      ],
    ]);

    expect(groupOfficialItems(collection, items)).toEqual([
      { heading: 'גרסאות בעברית', items: [items.get('official')] },
      { heading: 'מהדורות רשמיות בשפות זרות', items: [items.get('foreign')] },
    ]);
  });

  test('places an ungrouped official item in a factual fallback group', () => {
    const ungrouped = item({
      collectionLinks: [
        { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'part-of-release' },
      ],
    });

    expect(
      groupOfficialItems(
        { ...collection, itemIds: [ungrouped.id] },
        new Map([[ungrouped.id, ungrouped]]),
      ),
    ).toEqual([{ heading: 'חומרים רשמיים', items: [ungrouped] }]);
  });
});

describe('file metadata helpers', () => {
  test.each([
    [0, '0 קבצים'],
    [1, 'קובץ אחד'],
    [2, '2 קבצים'],
  ])('formats the Hebrew file count %s', (count, expected) => {
    expect(formatFileCount(count)).toBe(expected);
  });

  test.each([
    [null, 'גודל לא ידוע'],
    [0, '0 B'],
    [1024, '1.0 KB'],
    [1_048_576, '1.0 MB'],
  ])('formats %s bytes accessibly', (size, expected) => {
    expect(formatFileSize(size)).toBe(expected);
  });

  test('shows both a familiar extension and the exact MIME type', () => {
    expect(fileTypeLabel(item())).toBe('EXE · application/x-msdownload');
  });

  test('returns only available Drive actions with specific accessible labels', () => {
    expect(driveActions({ ...item(), viewUrl: null, downloadUrl: null })).toEqual([]);
    expect(driveActions({ ...item(), downloadUrl: null })).toEqual([
      {
        kind: 'view',
        href: item().viewUrl,
        label: 'צפייה — piposh1.exe',
      },
    ]);
    expect(driveActions(item()).map((action) => action.kind)).toEqual(['view', 'download']);
  });
});

describe('officialCollectionLinks', () => {
  test('deduplicates overlapping official groups by slug in first-occurrence order', () => {
    const linkedItem = item({
      collectionLinks: [
        {
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          relationship: 'part-of-release',
          groupHe: 'גרסאות',
        },
        {
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          relationship: 'part-of-release',
          groupHe: 'תוספות',
        },
        {
          slug: 'piposh-2',
          titleHe: 'פיפוש 2',
          relationship: 'about',
        },
        {
          slug: 'vogimon',
          titleHe: 'ווג׳ימון',
          relationship: 'part-of-release',
        },
      ],
    });

    expect(officialCollectionLinks(linkedItem)).toEqual([
      linkedItem.collectionLinks[0],
      linkedItem.collectionLinks[3],
    ]);
  });
});
