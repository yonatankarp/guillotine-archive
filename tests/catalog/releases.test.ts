import { describe, expect, test } from 'vitest';
import { resolveReleases } from '../../src/catalog/releases';
import { resolveRelationships } from '../../src/catalog/relationships';
import { validateCatalog } from '../../src/catalog/validate';
import type {
  CuratedCollection,
  CuratorConfig,
  DriveFile,
  Release,
} from '../../src/catalog/types';

function driveFile(id: string, path: string): DriveFile {
  return {
    id,
    name: path.split('/').at(-1) ?? '',
    mimeType: 'application/octet-stream',
    size: 42,
    modifiedTime: null,
    path,
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: null,
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

function config(overrides: Partial<CuratorConfig> = {}): CuratorConfig {
  return { collections: [], ...overrides };
}

function bySlug(releases: readonly Release[], slug: string): Release {
  const release = releases.find((candidate) => candidate.slug === slug);

  if (!release) {
    throw new Error(`no release ${slug} in [${releases.map((r) => r.slug).join(', ')}]`);
  }

  return release;
}

function resolve(files: readonly DriveFile[], curator: CuratorConfig) {
  return resolveReleases(resolveRelationships(files, curator, '2026-08-27T00:00:00.000Z'), curator);
}

describe('resolveReleases', () => {
  test('turns each curated collection into a release that keeps its curated identity', () => {
    const files = [driveFile('a', 'משחקים מלאים/פיפוש 1/גרסה 1/game.exe')];
    const curator = config({
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          year: 1999,
          coverFileId: 'a',
          rules: [
            {
              match: 'path-prefix',
              value: 'משחקים מלאים/פיפוש 1/גרסה 1',
              relationship: 'part-of-release',
            },
          ],
        }),
      ],
    });

    const { releases } = resolve(files, curator);
    const release = bySlug(releases, 'piposh-1');

    expect(release).toMatchObject({
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      type: 'game',
      year: 1999,
      coverFileId: 'a',
      itemIds: ['a'],
    });
    // A game release is its own subject, so the facet resolves without curation.
    expect(release.subjectSlug).toBe('piposh-1');
  });

  test('drives curated release membership from the curator rules, exclusions included', () => {
    const files = [
      driveFile('a', 'דמואים/Vegimon_Beta1.0/setup.exe'),
      driveFile('b', 'דמואים/Vegimon_Beta1.0/Thumbs.db'),
    ];
    const curator = config({
      collections: [
        collection({
          slug: 'vogimon',
          titleHe: 'ווג׳ימון',
          rules: [
            {
              match: 'path-prefix',
              value: 'דמואים/Vegimon_Beta1.0',
              relationship: 'part-of-release',
            },
          ],
          exclude: [
            {
              match: 'exact-path',
              value: 'דמואים/Vegimon_Beta1.0/Thumbs.db',
              relationship: 'part-of-release',
            },
          ],
        }),
      ],
    });

    const { releases } = resolve(files, curator);

    expect(bySlug(releases, 'vogimon').itemIds).toEqual(['a']);
    // The excluded file still needs a home, so its container yields an auto-release.
    const leftovers = releases.filter((release) => release.itemIds.includes('b'));
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.slug).not.toBe('vogimon');
  });

  test('groups leftover files into one auto-release per depth-two container', () => {
    const files = [
      driveFile('a', 'עיתונות/כתבות/1998/scan.jpg'),
      driveFile('b', 'עיתונות/כתבות/2001/scan.jpg'),
      driveFile('c', 'עיתונות/קומיקס/1.jpg'),
    ];

    const { releases } = resolve(files, config());

    expect(releases).toHaveLength(2);
    const articles = releases.find((release) => release.titleHe === 'כתבות');
    expect(articles?.itemIds).toEqual(['a', 'b']);
    expect(articles?.sourcePaths).toEqual(['עיתונות/כתבות']);
    expect(releases.find((release) => release.titleHe === 'קומיקס')?.itemIds).toEqual(['c']);
  });

  test('infers the release type from the top-level category', () => {
    const files = [
      driveFile('a', 'דמואים/Animal3D/x'),
      driveFile('b', 'פרטי אספנות/דיסק הקונגרס/x'),
      driveFile('c', 'שירים/רמיקסים/x'),
      driveFile('d', 'סרטונים/טלוויזיה/x'),
      driveFile('e', 'עיתונות/כתבות/x'),
      driveFile('f', 'משחקי מעריצים/טריוויה/x'),
      driveFile('g', 'גרפיקה/סקינים/x'),
    ];

    const { releases } = resolve(files, config());
    const typeByTitle = new Map(releases.map((release) => [release.titleHe, release.type]));

    expect(typeByTitle.get('Animal3D')).toBe('demo');
    expect(typeByTitle.get('דיסק הקונגרס')).toBe('fan-disc');
    expect(typeByTitle.get('רמיקסים')).toBe('audio-cd');
    expect(typeByTitle.get('טלוויזיה')).toBe('video');
    expect(typeByTitle.get('כתבות')).toBe('press');
    expect(typeByTitle.get('טריוויה')).toBe('fan-game');
    expect(typeByTitle.get('סקינים')).toBe('other');
  });

  test('houses shallow files under their top-level category', () => {
    const files = [driveFile('a', 'פתרונות/פיפוש 1 - פתרון'), driveFile('b', 'מה חסר?')];

    const { releases } = resolve(files, config());

    expect(bySlug(releases, releases[0]!.slug).itemIds).toHaveLength(1);
    expect(releases.map((release) => release.titleHe).sort()).toEqual(['אחר', 'פתרונות']);
    expect(releases.every((release) => release.itemIds.length === 1)).toBe(true);
  });

  test('derives ascii slugs from latin path segments and hashes Hebrew-only ones', () => {
    const files = [
      driveFile('a', 'דמואים/Vegimon_Beta1.0/x'),
      driveFile('b', 'פרטי אספנות/אני פיפושאי גאה/x'),
    ];

    const { releases } = resolve(files, config());

    expect(bySlug(releases, 'vegimon-beta1-0').titleHe).toBe('Vegimon_Beta1.0');
    const hashed = releases.find((release) => release.titleHe === 'אני פיפושאי גאה');
    expect(hashed?.slug).toMatch(/^fan-disc-[0-9a-f]{8}$/u);
  });

  test('keeps a derived slug stable when unrelated containers appear', () => {
    const base = [driveFile('a', 'פרטי אספנות/אני פיפושאי גאה/x')];
    const grown = [...base, driveFile('b', 'פרטי אספנות/דיסק הקונגרס/y')];

    const before = resolve(base, config()).releases[0]?.slug;
    const after = resolve(grown, config()).releases.find((release) =>
      release.itemIds.includes('a'),
    )?.slug;

    expect(after).toBe(before);
  });

  test('merges several containers into one release under a curator override', () => {
    const files = [
      driveFile('a', 'פרטי אספנות/הטברה של פיפוש - דיסק 1/01.mp3'),
      driveFile('b', 'פרטי אספנות/הטברה של פיפוש - דיסק 2/01.mp3'),
    ];
    const curator = config({
      releases: [
        {
          paths: [
            'פרטי אספנות/הטברה של פיפוש - דיסק 1',
            'פרטי אספנות/הטברה של פיפוש - דיסק 2',
          ],
          slug: 'hatbara-shel-piposh',
          titleHe: 'ההטברה של פיפוש',
          type: 'audio-cd',
          subjectSlug: 'piposh-1',
          year: 2003,
          formatHe: 'שני דיסקים',
          accent: '#c94f2b',
        },
      ],
    });

    const { releases } = resolve(files, curator);

    expect(releases).toHaveLength(1);
    expect(releases[0]).toEqual({
      slug: 'hatbara-shel-piposh',
      titleHe: 'ההטברה של פיפוש',
      type: 'audio-cd',
      subjectSlug: 'piposh-1',
      year: 2003,
      formatHe: 'שני דיסקים',
      accent: '#c94f2b',
      itemIds: ['a', 'b'],
      sourcePaths: [
        'פרטי אספנות/הטברה של פיפוש - דיסק 1',
        'פרטי אספנות/הטברה של פיפוש - דיסק 2',
      ],
    });
  });

  test('lets a curator override win over every inferred field', () => {
    const files = [driveFile('a', 'גרפיקה/סקינים/x')];
    const curator = config({
      releases: [
        {
          paths: ['גרפיקה/סקינים'],
          titleHe: 'סקינים לשולחן העבודה',
          type: 'fan-disc',
          coverFileId: 'a',
          logoFileId: 'a',
        },
      ],
    });

    const { releases } = resolve(files, curator);

    expect(releases[0]).toMatchObject({
      titleHe: 'סקינים לשולחן העבודה',
      type: 'fan-disc',
      coverFileId: 'a',
      logoFileId: 'a',
    });
  });

  test('overrides a curated collection release without disturbing its membership', () => {
    const files = [driveFile('a', 'משחקים מלאים/פיפוש 1/גרסה 1/game.exe')];
    const curator = config({
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          rules: [
            {
              match: 'path-prefix',
              value: 'משחקים מלאים/פיפוש 1',
              relationship: 'part-of-release',
            },
          ],
        }),
      ],
      releases: [{ paths: ['piposh-1'], formatHe: 'תקליטור', accent: '#123456' }],
    });

    const { releases } = resolve(files, curator);

    expect(bySlug(releases, 'piposh-1')).toMatchObject({
      formatHe: 'תקליטור',
      accent: '#123456',
      itemIds: ['a'],
    });
  });

  test('infers a subject by matching a container title against a game title or alias', () => {
    const files = [
      driveFile('a', 'סרטונים/תככי הרייטינג/clip.wmv'),
      driveFile('b', 'דמואים/פיפוש1 - אנגלית/demo.dxr'),
      driveFile('c', 'משחקי מעריצים/פיפוש 2 וחצי/x'),
    ];
    const curator = config({
      collections: [
        collection({ slug: 'betochhei-harating', titleHe: 'בתככי הרייטינג', aliasesHe: ['תככי הרייטינג'] }),
        collection({ slug: 'piposh-1', titleHe: 'פיפוש 1' }),
      ],
    });

    const { releases } = resolve(files, curator);
    const subjectByTitle = new Map(
      releases.map((release) => [release.titleHe, release.subjectSlug]),
    );

    expect(subjectByTitle.get('תככי הרייטינג')).toBe('betochhei-harating');
    // The ' - אנגלית' edition suffix must not hide the subject.
    expect(subjectByTitle.get('פיפוש1 - אנגלית')).toBe('piposh-1');
    // A fan title that merely contains a game name is not about that game.
    expect(subjectByTitle.get('פיפוש 2 וחצי')).toBeNull();
  });

  test('assigns every file to exactly one release', () => {
    const files = [
      driveFile('a', 'משחקים מלאים/פיפוש 1/גרסה 1/game.exe'),
      driveFile('b', 'עיתונות/כתבות/scan.jpg'),
      driveFile('c', 'מה חסר?'),
    ];
    const curator = config({
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          rules: [
            {
              match: 'path-prefix',
              value: 'משחקים מלאים/פיפוש 1',
              relationship: 'part-of-release',
            },
          ],
        }),
      ],
    });

    const { releases, catalog } = resolve(files, curator);
    const owners = releases.flatMap((release) =>
      release.itemIds.map((itemId) => [itemId, release.slug] as const),
    );

    expect(owners.map(([itemId]) => itemId).sort()).toEqual(['a', 'b', 'c']);
    for (const item of catalog.items) {
      expect(item.releaseSlug).toBe(owners.find(([itemId]) => itemId === item.id)?.[1]);
    }
  });

  test('rejects two curated collections claiming the same file', () => {
    const files = [driveFile('a', 'משחקים מלאים/פיפוש 1/גרסה 1/game.exe')];
    const rules = [
      {
        match: 'path-prefix' as const,
        value: 'משחקים מלאים/פיפוש 1',
        relationship: 'part-of-release' as const,
      },
    ];
    const curator = config({
      collections: [
        collection({ slug: 'piposh-1', titleHe: 'פיפוש 1', rules }),
        collection({ slug: 'piposh-2', titleHe: 'פיפוש 2', rules }),
      ],
    });

    expect(() => resolve(files, curator)).toThrow(/exactly one release/u);
  });

  test('rejects a container claimed by two curator release overrides', () => {
    const files = [driveFile('a', 'גרפיקה/סקינים/x')];
    const curator = config({
      releases: [
        { paths: ['גרפיקה/סקינים'], slug: 'skins-one' },
        { paths: ['גרפיקה/סקינים'], slug: 'skins-two' },
      ],
    });

    expect(() => resolve(files, curator)).toThrow(/גרפיקה\/סקינים/u);
  });

  test('rejects a curator override whose slug collides with another release', () => {
    const files = [
      driveFile('a', 'גרפיקה/סקינים/x'),
      driveFile('b', 'גרפיקה/גיפים/y'),
    ];
    const curator = config({
      releases: [
        { paths: ['גרפיקה/סקינים'], slug: 'shared' },
        { paths: ['גרפיקה/גיפים'], slug: 'shared' },
      ],
    });

    expect(() => resolve(files, curator)).toThrow(/shared/u);
  });

  // A fixture build reuses the production curator, so an override naming a
  // container outside the current file set must be as silent as an unmatched rule.
  test('skips an override path absent from this file set without failing or warning', () => {
    const files = [driveFile('a', 'גרפיקה/סקינים/x')];
    const curator = config({ releases: [{ paths: ['גרפיקה/לא קיים'] }] });

    const { catalog, releases } = resolve(files, curator);
    const report = validateCatalog(catalog, curator);

    expect(releases.map(({ titleHe }) => titleHe)).toEqual(['סקינים']);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual(['1 files are not linked to a curated collection']);
  });

  test('keeps the present half of a partially absent multi-container override', () => {
    const files = [driveFile('a', 'פרטי אספנות/דיסק 1/01.mp3')];
    const curator = config({
      releases: [{ paths: ['פרטי אספנות/דיסק 1', 'פרטי אספנות/דיסק 2'], slug: 'two-discs' }],
    });

    const { releases } = resolve(files, curator);

    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      slug: 'two-discs',
      itemIds: ['a'],
      sourcePaths: ['פרטי אספנות/דיסק 1'],
    });
  });

  test('derives the facets present in the resolved releases', () => {
    const files = [
      driveFile('a', 'משחקים מלאים/פיפוש 1/גרסה 1/game.exe'),
      driveFile('b', 'עיתונות/כתבות/scan.jpg'),
      driveFile('c', 'סרטונים/תככי הרייטינג/clip.wmv'),
    ];
    const curator = config({
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          year: 1999,
          rules: [
            {
              match: 'path-prefix',
              value: 'משחקים מלאים/פיפוש 1',
              relationship: 'part-of-release',
            },
          ],
        }),
        collection({ slug: 'betochhei-harating', titleHe: 'תככי הרייטינג' }),
      ],
      releases: [{ paths: ['עיתונות/כתבות'], year: 1998 }],
    });

    const { facets } = resolve(files, curator);

    expect(facets.types).toEqual(['game', 'press', 'video']);
    expect(facets.subjectSlugs).toEqual(['betochhei-harating', 'piposh-1']);
    expect(facets.years).toEqual([1998, 1999]);
  });

  test('orders releases by descending size so the five big discs lead', () => {
    const files = [
      driveFile('a', 'גרפיקה/גיפים/1.gif'),
      driveFile('b', 'פרטי אספנות/דיסק הקונגרס/1'),
      driveFile('c', 'פרטי אספנות/דיסק הקונגרס/2'),
      driveFile('d', 'עיתונות/כתבות/1.jpg'),
      driveFile('e', 'עיתונות/כתבות/2.jpg'),
      driveFile('f', 'עיתונות/כתבות/3.jpg'),
    ];

    const { releases } = resolve(files, config());

    expect(releases.map((release) => release.itemIds.length)).toEqual([3, 2, 1]);
  });
});
