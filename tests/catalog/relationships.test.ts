import { describe, expect, test } from 'vitest';
import { resolveRelationships } from '../../src/catalog/relationships';
import type {
  CuratedCollection,
  CuratorConfig,
  DriveFile,
  RelationshipKind,
  RuleMatch,
} from '../../src/catalog/types';

function driveFile(id: string, path: string): DriveFile {
  const name = path.split('/').at(-1) ?? '';

  return {
    id,
    name,
    mimeType: 'application/octet-stream',
    size: 42,
    modifiedTime: '2026-08-26T10:00:00.000Z',
    path,
    parentIds: [`parent-${id}`],
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
  };
}

function collection(
  overrides: Partial<CuratedCollection> & Pick<CuratedCollection, 'slug' | 'titleHe'>,
): CuratedCollection {
  return {
    type: 'game',
    summaryHe: 'תקציר',
    aliasesHe: [],
    tagsHe: [],
    rules: [],
    exclude: [],
    ...overrides,
  };
}

function singleRuleConfig(
  match: RuleMatch,
  value: string,
  relationship: RelationshipKind = 'part-of-release',
): CuratorConfig {
  return {
    collections: [
      collection({
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        rules: [{ match, value, relationship }],
      }),
    ],
  };
}

describe('resolveRelationships', () => {
  test('interlinks official release files while keeping press and fan relationships separate', () => {
    const files = [
      driveFile('game', 'משחקים מלאים/פיפוש 1/piposh1.exe'),
      driveFile('audio', 'שירים/דיסקים מלאים/פיפוש 1 - דיסק אודיו/דיסק אדיו.rar'),
      driveFile('press', 'עיתונות/פיפוש 1/ביקורת.jpg'),
      driveFile('fan', 'משחקי מעריצים/fan.zip'),
    ];
    const config: CuratorConfig = {
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          rules: [
            {
              match: 'path-prefix',
              value: 'משחקים מלאים/פיפוש 1',
              relationship: 'part-of-release',
              groupHe: 'גרסאות',
            },
            {
              match: 'path-prefix',
              value: 'שירים/דיסקים מלאים/פיפוש 1 - דיסק אודיו',
              relationship: 'part-of-release',
              groupHe: 'מוזיקה',
            },
            {
              match: 'path-prefix',
              value: 'עיתונות/פיפוש 1',
              relationship: 'about',
            },
            {
              match: 'file-id',
              value: 'fan',
              relationship: 'inspired-by',
            },
          ],
        }),
      ],
    };

    const catalog = resolveRelationships(files, config, '2026-08-26T12:00:00.000Z');

    expect(catalog.collections[0]?.itemIds).toEqual(['game', 'audio']);
    expect(catalog.items.find(({ id }) => id === 'press')?.collectionLinks).toEqual([
      { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'about' },
    ]);
    expect(catalog.items.find(({ id }) => id === 'fan')?.collectionLinks).toEqual([
      { slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'inspired-by' },
    ]);
  });

  test.each([
    ['file-id', 'target-id', driveFile('target-id', 'חומר/file.bin')],
    ['exact-path', 'חומר/file.bin', driveFile('target', 'חומר/file.bin')],
    ['path-prefix', 'חומר', driveFile('target', 'חומר/file.bin')],
  ] satisfies Array<[RuleMatch, string, DriveFile]>)('matches files using %s rules', (match, value, file) => {
    const catalog = resolveRelationships([file], singleRuleConfig(match, value));

    expect(catalog.collections[0]?.itemIds).toEqual([file.id]);
  });

  test.each([
    ['path-prefix', 'חומר', '/חומר/file.bin'],
    ['path-prefix', 'חומר/', 'חומר/file.bin'],
    ['exact-path', 'חומר/file.bin', '/חומר/file.bin'],
    ['exact-path', 'חומר/file.bin/', 'חומר/file.bin'],
  ] satisfies Array<[RuleMatch, string, string]>)('keeps canonical path strings distinct for %s rules', (match, value, path) => {
    const catalog = resolveRelationships(
      [driveFile('target', path)],
      singleRuleConfig(match, value),
    );

    expect(catalog.collections[0]?.itemIds).toEqual([]);
  });

  test('matches path prefixes only at segment boundaries', () => {
    const files = [
      driveFile('one', 'משחקים מלאים/פיפוש 1'),
      driveFile('child', 'משחקים מלאים/פיפוש 1/setup.exe'),
      driveFile('ten', 'משחקים מלאים/פיפוש 10/setup.exe'),
    ];

    expect(
      resolveRelationships(
        files,
        singleRuleConfig('path-prefix', 'משחקים מלאים/פיפוש 1'),
      ).collections[0]?.itemIds,
    ).toEqual(['one', 'child']);
  });

  test('applies collection exclusions before positive rules', () => {
    const config: CuratorConfig = {
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          rules: [
            { match: 'path-prefix', value: 'חומר', relationship: 'part-of-release' },
          ],
          exclude: [{ match: 'file-id', value: 'skip', relationship: 'about' }],
        }),
      ],
    };

    const catalog = resolveRelationships(
      [driveFile('keep', 'חומר/keep.bin'), driveFile('skip', 'חומר/skip.bin')],
      config,
    );

    expect(catalog.collections[0]?.itemIds).toEqual(['keep']);
    expect(catalog.items.find(({ id }) => id === 'skip')?.collectionLinks).toEqual([]);
  });

  test('deduplicates identical overlapping links but preserves distinct relationship and group links', () => {
    const config: CuratorConfig = {
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          rules: [
            {
              match: 'path-prefix',
              value: 'חומר',
              relationship: 'part-of-release',
              groupHe: 'גרסאות',
            },
            {
              match: 'exact-path',
              value: 'חומר/file.bin',
              relationship: 'part-of-release',
              groupHe: 'גרסאות',
            },
            {
              match: 'file-id',
              value: 'target',
              relationship: 'about',
              groupHe: 'גרסאות',
            },
            {
              match: 'file-id',
              value: 'target',
              relationship: 'part-of-release',
              groupHe: 'תוספות',
            },
          ],
        }),
      ],
    };

    const catalog = resolveRelationships([driveFile('target', 'חומר/file.bin')], config);

    expect(catalog.items[0]?.collectionLinks).toEqual([
      {
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        relationship: 'part-of-release',
        groupHe: 'גרסאות',
      },
      {
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        relationship: 'about',
        groupHe: 'גרסאות',
      },
      {
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        relationship: 'part-of-release',
        groupHe: 'תוספות',
      },
    ]);
    expect(catalog.collections[0]?.itemIds).toEqual(['target']);
  });

  test('preserves collection metadata and derives cover URLs', () => {
    const config: CuratorConfig = {
      minimumFileCount: 1000,
      collections: [
        collection({
          slug: 'covered',
          titleHe: 'עם עטיפה',
          type: 'archive',
          year: 1999,
          summaryHe: 'תקציר מקורי',
          descriptionHe: 'תיאור מלא',
          coverFileId: 'cover-id',
          aliasesHe: ['שם נוסף'],
          tagsHe: ['הרפתקה'],
        }),
        collection({ slug: 'bare', titleHe: 'בלי עטיפה' }),
      ],
    };

    const catalog = resolveRelationships([], config);

    expect(catalog.collections[0]).toEqual({
      ...config.collections[0],
      coverUrl: '/generated/covers/cover-id.webp',
      itemIds: [],
    });
    expect(catalog.collections[1]?.coverUrl).toBeNull();
  });

  test('preserves Drive data, derives categories, and keeps source order', () => {
    const files = [
      driveFile('press', '/עיתונות/review.jpg'),
      driveFile('games', 'משחקים מלאים/game.exe'),
      driveFile('press-two', 'עיתונות/second.jpg'),
      driveFile('empty', '///'),
    ];

    const catalog = resolveRelationships(files, { collections: [] });

    expect(catalog.items.map(({ id }) => id)).toEqual(['press', 'games', 'press-two', 'empty']);
    expect(catalog.items[0]).toEqual({
      ...files[0],
      category: 'עיתונות',
      aliasesHe: [],
      tagsHe: [],
      collectionLinks: [],
    });
    expect(catalog.items.map(({ category }) => category)).toEqual([
      'עיתונות',
      'משחקים מלאים',
      'עיתונות',
      'אחר',
    ]);
    expect(catalog.categories).toEqual(['אחר', 'משחקים מלאים', 'עיתונות']);
  });

  test.each(['', '/', '///'])('uses אחר for a path with no nonempty segment: %j', (path) => {
    const catalog = resolveRelationships([driveFile('empty', path)], { collections: [] });

    expect(catalog.items[0]?.category).toBe('אחר');
    expect(catalog.categories).toEqual(['אחר']);
  });

  test('orders categories by a fixed Hebrew alphabet with deterministic final-letter ties', () => {
    const catalog = resolveRelationships(
      [
        driveFile('bet', 'בית/file.bin'),
        driveFile('medial-mem', 'אמ/file.bin'),
        driveFile('final-kaf', 'אך/file.bin'),
        driveFile('aleph-bet', 'אב/file.bin'),
        driveFile('final-mem', 'אם/file.bin'),
        driveFile('medial-kaf', 'אכ/file.bin'),
        driveFile('marked-aleph-bet', 'אָב/file.bin'),
        driveFile('latin-lowercase', 'alpha/file.bin'),
        driveFile('latin-uppercase', 'Beta/file.bin'),
      ],
      { collections: [] },
    );

    expect(catalog.categories).toEqual([
      'אָב',
      'אב',
      'אך',
      'אכ',
      'אם',
      'אמ',
      'בית',
      'Beta',
      'alpha',
    ]);
  });

  test('uses the supplied timestamp exactly and does not mutate inputs', () => {
    const files = [driveFile('target', 'חומר/file.bin')];
    const config = singleRuleConfig('path-prefix', 'חומר');
    const filesBefore = structuredClone(files);
    const configBefore = structuredClone(config);
    const generatedAt = 'not-normalized-on-purpose';

    const catalog = resolveRelationships(files, config, generatedAt);

    expect(catalog.generatedAt).toBe(generatedAt);
    expect(files).toEqual(filesBefore);
    expect(config).toEqual(configBefore);
    expect(catalog.items[0]).not.toBe(files[0]);
    expect(catalog.collections[0]).not.toBe(config.collections[0]);
  });

  test('supports empty files and empty collections', () => {
    expect(resolveRelationships([], { collections: [] }, 'fixed')).toEqual({
      generatedAt: 'fixed',
      collections: [],
      items: [],
      categories: [],
    });
  });
});
