import { describe, expect, test } from 'vitest';
import {
  ARCHIVE_PAGE_SIZE,
  archivePageNumbers,
  paginateArchiveItems,
} from '../../src/lib/archive';

describe('archive pagination', () => {
  test('splits items into stable pages without dropping or duplicating them', () => {
    const items = Array.from({ length: 235 }, (_, index) => `item-${index + 1}`);
    const pages = archivePageNumbers(items.length).map((page) =>
      paginateArchiveItems(items, page),
    );

    expect(pages.map(({ items: pageItems }) => pageItems.length)).toEqual([100, 100, 35]);
    expect(pages.flatMap(({ items: pageItems }) => pageItems)).toEqual(items);
    expect(new Set(pages.flatMap(({ items: pageItems }) => pageItems))).toHaveLength(
      items.length,
    );
  });

  test('uses a fixed 100-item cap and reports deterministic page metadata', () => {
    expect(ARCHIVE_PAGE_SIZE).toBe(100);
    expect(paginateArchiveItems(['a', 'b', 'c'], 2, 2)).toEqual({
      items: ['c'],
      page: 2,
      pageCount: 2,
      itemCount: 3,
    });
  });

  test('keeps one valid page for an empty category', () => {
    expect(archivePageNumbers(0)).toEqual([1]);
    expect(paginateArchiveItems([], 1)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      itemCount: 0,
    });
  });

  test.each([0, -1, 1.5, 4])('rejects invalid or out-of-range page %s', (page) => {
    expect(() => paginateArchiveItems([1, 2, 3], page, 1)).toThrow(
      'invalid archive page',
    );
  });

  test.each([0, -1, 1.5])('rejects invalid page size %s', (pageSize) => {
    expect(() => archivePageNumbers(3, pageSize)).toThrow('invalid archive page size');
  });
});
