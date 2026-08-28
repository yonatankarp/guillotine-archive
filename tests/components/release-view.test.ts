import { describe, expect, test } from 'vitest';
import type { CatalogItem } from '../../src/catalog/types';
import { galleryGroupHeading, galleryGroups } from '../../src/components/release-view';

function item(path: string, overrides: Partial<CatalogItem> = {}): CatalogItem {
  const segments = path.split('/');

  return {
    id: path,
    name: segments[segments.length - 1]!,
    mimeType: 'image/jpeg',
    size: 1024,
    modifiedTime: null,
    path,
    viewUrl: 'https://drive.google.com/file/d/file-1/view',
    downloadUrl: null,
    category: 'משחקים מלאים',
    kind: 'booklet-page',
    releaseSlug: 'piposh-1',
    aliasesHe: [],
    tagsHe: [],
    collectionLinks: [],
    ...overrides,
  };
}

describe('gallery group headings', () => {
  test('strips the release name a folder repeats', () => {
    expect(galleryGroupHeading('פיפוש 1 - חוברת שירים', 'פיפוש 1')).toBe('חוברת שירים');
    expect(galleryGroupHeading('חלום שהתגשם - חוברת', 'חלום שהתגשם')).toBe('חוברת');
  });

  /* The catalog title carries a preposition the folder does not. */
  test('strips a release name the title only extends', () => {
    expect(galleryGroupHeading('תככי הרייטינג - חוברת', 'בתככי הרייטינג')).toBe('חוברת');
  });

  /* ווג׳ימון in the catalog, ווג'ימון on disk: one name, two apostrophes. */
  test('treats geresh and the ASCII apostrophe as the same letter', () => {
    expect(galleryGroupHeading("ווג'ימון - חוברת", 'ווג׳ימון')).toBe('חוברת');
    expect(galleryGroupHeading('ווג׳ימון - עטיפה', "ווג'ימון")).toBe('עטיפה');
  });

  test('keeps a folder whose prefix names something other than the release', () => {
    expect(galleryGroupHeading('פריץ פון בזזזז - קישקע', 'דיסק הקונגרס')).toBe(
      'פריץ פון בזזזז - קישקע',
    );
  });

  test('keeps a folder that carries no prefix at all', () => {
    expect(galleryGroupHeading('און ליין', 'כתבות')).toBe('און ליין');
    expect(galleryGroupHeading('אריזה', 'חלום שהתגשם')).toBe('אריזה');
  });

  /* A heading has to name something, so a folder that is only the release name stays whole. */
  test('never empties a heading', () => {
    expect(galleryGroupHeading('קומיקס', 'קומיקס')).toBe('קומיקס');
    expect(galleryGroupHeading('פיפוש 1 - ', 'פיפוש 1')).toBe('פיפוש 1 - ');
  });
});

describe('gallery groups', () => {
  const piposh1 = [
    item('משחקים מלאים/פיפוש 1/פיפוש 1 - חוברת שירים/Scan_000.jpg'),
    item('משחקים מלאים/פיפוש 1/פיפוש 1 - חוברת שירים/Scan_001.jpg'),
    item('משחקים מלאים/פיפוש 1/פיפוש 1 - חוברת משחק/Scan_000.jpg'),
    item('משחקים מלאים/פיפוש 1/פיפוש 1 - אריזה/front-cover.jpg', { kind: 'cover' }),
  ];

  /* The two booklets share one kind, which is exactly why kind cannot be the grouping. */
  test('splits two booklets of the same kind by the folder they were scanned from', () => {
    expect(galleryGroups(piposh1, 'פיפוש 1').map(({ headingHe }) => headingHe)).toEqual([
      'אריזה',
      'חוברת משחק',
      'חוברת שירים',
    ]);
  });

  test('orders the box before the booklets whatever order the catalog lists them in', () => {
    const shuffled = [...piposh1].reverse();

    expect(galleryGroups(shuffled, 'פיפוש 1').map(({ headingHe }) => headingHe)).toEqual(
      galleryGroups(piposh1, 'פיפוש 1').map(({ headingHe }) => headingHe),
    );
  });

  test('keeps every item, in the page order the booklet was scanned in', () => {
    const groups = galleryGroups(piposh1, 'פיפוש 1');

    expect(groups.flatMap(({ items }) => items)).toHaveLength(piposh1.length);
    expect(groups[2]!.items.map(({ name }) => name)).toEqual(['Scan_000.jpg', 'Scan_001.jpg']);
  });

  /* A rebuilt catalog reorders itemIds. An id derived from a position would move with it. */
  test('gives a group an id that survives a catalog reorder', () => {
    const ids = (of: CatalogItem[]) => galleryGroups(of, 'פיפוש 1').map(({ id }) => id);

    expect(ids([...piposh1].reverse())).toEqual(ids(piposh1));
    expect(new Set(ids(piposh1)).size).toBe(3);
  });

  test('a release filed in one folder is a single group', () => {
    const comics = [
      item('עיתונות/קומיקס/page-1.jpg', { kind: 'comic-page' }),
      item('עיתונות/קומיקס/page-2.jpg', { kind: 'comic-page' }),
    ];

    expect(galleryGroups(comics, 'קומיקס')).toHaveLength(1);
  });
});
