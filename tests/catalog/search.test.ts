import MiniSearch from 'minisearch';
import { describe, expect, test } from 'vitest';
import {
  buildSearchIndex,
  createSearchEngine,
  extractHebrewTokens,
  getSearchOptions,
  normalizeHebrew,
  searchFilterValues,
  type ArchiveSearchResult,
  type SearchDocument,
} from '../../src/catalog/search';
import type { Catalog, CatalogCollection, CatalogItem } from '../../src/catalog/types';

type IsAny<Value> = 0 extends 1 & Value ? true : false;
const archiveSearchResultIdIsNotAny: IsAny<ArchiveSearchResult['id']> = false;
void archiveSearchResultIdIsNotAny;

function collection(overrides: Partial<CatalogCollection> = {}): CatalogCollection {
  return {
    slug: 'piposh-1',
    titleHe: 'פיפוש 1',
    type: 'game',
    summaryHe: 'המשחק המקורי',
    aliasesHe: ['פיפוש הראשון'],
    tagsHe: ['הרפתקה'],
    rules: [],
    exclude: [],
    coverUrl: null,
    itemIds: ['english'],
    ...overrides,
  };
}

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'english',
    name: 'piposh1-english.exe',
    mimeType: 'application/x-msdownload',
    size: 10,
    modifiedTime: null,
    path: 'משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe',
    viewUrl: 'https://drive.google.com/file/d/english/view',
    downloadUrl: 'https://drive.google.com/uc?export=download&id=english',
    category: 'משחקים מלאים',
    aliasesHe: [],
    tagsHe: [],
    collectionLinks: [
      {
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        relationship: 'part-of-release',
        groupHe: 'גרסאות',
      },
    ],
    ...overrides,
  };
}

function catalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    generatedAt: '2026-08-26T00:00:00.000Z',
    categories: ['משחקים מלאים'],
    collections: [collection()],
    items: [item()],
    ...overrides,
  };
}

function loadCatalogIndex(source: Catalog) {
  const serialized = buildSearchIndex(source);
  const loaded = MiniSearch.loadJSON<SearchDocument>(serialized, getSearchOptions());

  return { serialized, search: createSearchEngine(loaded) };
}

describe('Hebrew normalization', () => {
  test('strips niqqud and normalizes final letters', () => {
    expect(normalizeHebrew('פִּיפּוֹשׁ מלך')).toBe(normalizeHebrew('פיפוש מלכ'));
  });

  test('turns punctuation and path separators into collapsed spaces', () => {
    expect(normalizeHebrew('  מלך/קיבינימאט—פיפוש_אחד!  ')).toBe(
      'מלכ קיבינימאט פיפוש אחד',
    );
    expect(extractHebrewTokens('מלך־הארכיון')).toEqual(['מלכ', 'הארכיונ']);
  });

  test('treats Hebrew punctuation as word separators', () => {
    expect(normalizeHebrew('בית\u05BEספר\u05C0חדש\u05C3מאוד\u05C6כאן')).toBe(
      'בית ספר חדש מאוד כאנ',
    );
  });

  test('removes Hebrew and ASCII quote marks within words', () => {
    expect(normalizeHebrew('צה״ל')).toBe(normalizeHebrew('צהל'));
    expect(normalizeHebrew("ג׳ורג'")).toBe(normalizeHebrew('גורג'));
  });

  test('extracts only Hebrew letter runs', () => {
    expect(extractHebrewTokens('piposh1-english.exe')).toEqual([]);
    expect(extractHebrewTokens('Пипош первый')).toEqual([]);
    expect(extractHebrewTokens('12345')).toEqual([]);
    expect(extractHebrewTokens('piposh פיפוש-1')).toEqual(['פיפוש']);
  });
});

describe('Hebrew search index', () => {
  test('uses separate weighted fields for curated, relationship, category, and body text', () => {
    expect(getSearchOptions().fields).toEqual([
      'titleHe',
      'aliasesHe',
      'pathHe',
      'relationshipsHe',
      'tagsHe',
      'categoriesHe',
      'descriptionHe',
      'textHe',
    ]);
  });

  test('finds words separated by Hebrew maqaf and acronyms containing quotes', () => {
    const source = catalog({
      collections: [
        collection({
          aliasesHe: ['בית־ספר', 'צה״ל', 'ג׳ורג׳'],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    for (const query of ['ספר', 'צהל', 'גורג']) {
      expect(search.search(query).map((result) => result.id)).toContain(
        'collection:piposh-1',
      );
    }
  });

  test('reloads the serialized index and finds an English-named file through Hebrew metadata', () => {
    const { search } = loadCatalogIndex(catalog());
    const ids = search.search('פיפוש 1').map((result) => result.id);

    expect(ids).toContain('collection:piposh-1');
    expect(ids).toContain('file:english');
    expect(search.search('piposh')).toEqual([]);
  });

  test('ranks an exact numbered Hebrew collection title before sibling titles', () => {
    const source = catalog({
      collections: [
        collection({
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          aliasesHe: ['פיפוש הראשון', 'פיפוש אחד'],
          tagsHe: ['פיפוש', 'הרפתקה', 'קומדיה', 'גיליוטין', 'אנגלית', 'רוסית'],
          summaryHe: 'פיפוש עולה למטוס, התעלומה עולה איתו',
          descriptionHe: 'שלוש גרסאות בעברית, מהדורות רשמיות בשפות זרות והפתרון',
          itemIds: ['english', 'hebrew', 'solution'],
        }),
        collection({
          slug: 'piposh-2',
          titleHe: 'פיפוש 2',
          aliasesHe: ['פיפוש שתיים'],
          tagsHe: ['פיפוש', 'הרפתקה', 'קומדיה', 'גיליוטין'],
          summaryHe: 'פיפוש שוב הסתבך; הארכיון דווקא מסודר',
          itemIds: [],
        }),
        collection({
          slug: 'halom-shehitgashem',
          titleHe: 'חלום שהתגשם',
          aliasesHe: ['פיפוש חלום שהתגשם'],
          tagsHe: ['פיפוש'],
          summaryHe: 'חלום, חוברת ודיסק אודיו',
          itemIds: [],
        }),
        collection({
          slug: 'betochhei-harating',
          titleHe: 'בתככי הרייטינג',
          aliasesHe: ['תככי הרייטינג'],
          tagsHe: ['פיפוש'],
          summaryHe: 'שתי גרסאות, תיקונים והוראות',
          itemIds: [],
        }),
        collection({
          slug: 'piposh-revolution',
          titleHe: 'פיפוש המהפכה',
          aliasesHe: ['פיפוש שלוש', 'המהפכה'],
          tagsHe: ['פיפוש'],
          summaryHe: 'המהפכה אולי כאוטית',
          itemIds: [],
        }),
      ],
      items: [
        item({ id: 'english' }),
        item({
          id: 'hebrew',
          name: 'piposh1.exe',
          path: 'משחקים מלאים/פיפוש 1/גרסה 2/piposh1.exe',
        }),
        item({
          id: 'solution',
          name: 'פיפוש 1 - פתרון.docx',
          path: 'פתרונות/פיפוש 1 - פתרון.docx',
          category: 'פתרונות',
          extractedTextHe: 'זהו פתרון רשמי למשחק פיפוש הראשון',
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    for (const query of ['פיפוש 1', 'piposh פיפוש 1', 'פיפוש—1', 'פיפוש / 1']) {
      expect(search.search(query).at(0)?.id, query).toBe('collection:piposh-1');
    }
    expect(search.search('piposh1')).toEqual([]);
    expect(search.search('piposh1 פיפוש').at(0)?.id).toBe('collection:piposh-2');
  });

  test('uses digits accompanying Hebrew terms to rank numbered sibling files', () => {
    const firstLink = {
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      relationship: 'part-of-release' as const,
      groupHe: 'גרסאות המשחק',
    };
    const secondLink = {
      slug: 'piposh-2',
      titleHe: 'פיפוש 2',
      relationship: 'part-of-release' as const,
      groupHe: 'גרסאות המשחק',
    };
    const source = catalog({
      collections: [
        collection({ slug: 'piposh-1', titleHe: 'פיפוש 1', itemIds: ['first'] }),
        collection({ slug: 'piposh-2', titleHe: 'פיפוש 2', itemIds: ['second'] }),
      ],
      items: [
        item({
          id: 'first',
          name: 'first.exe',
          path: 'משחקים מלאים/פיפוש 1/first.exe',
          collectionLinks: [firstLink],
        }),
        item({
          id: 'second',
          name: 'second.exe',
          path: 'משחקים מלאים/פיפוש 2/second.exe',
          collectionLinks: [secondLink],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    const firstQuery = search.search('פיפוש 1').map(({ id }) => id);
    const secondQuery = search.search('פיפוש 2').map(({ id }) => id);
    expect(firstQuery.indexOf('file:first')).toBeLessThan(firstQuery.indexOf('file:second'));
    expect(secondQuery.indexOf('file:second')).toBeLessThan(secondQuery.indexOf('file:first'));
    expect(search.search('123')).toEqual([]);
    expect(search.search('piposh 2')).toEqual([]);
  });

  test('supports Hebrew prefixes and fuzzy matching only for terms of four letters or more', () => {
    const { search } = loadCatalogIndex(catalog());

    expect(search.search('פיפו').map((result) => result.id)).toContain('collection:piposh-1');
    expect(search.search('הרפתקא').map((result) => result.id)).toContain(
      'collection:piposh-1',
    );
    expect(search.search('פיפ').map((result) => result.id)).toContain('collection:piposh-1');
    expect(search.search('פיט')).toEqual([]);
  });

  test('discovers collections through aliases, tags, summaries, and descriptions', () => {
    const source = catalog({
      collections: [
        collection({
          aliasesHe: ['הראשון בסדרה'],
          tagsHe: ['הרפתקה'],
          summaryHe: 'משחק בלשים',
          descriptionHe: 'תעלומה מפוקפקת במיוחד',
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    for (const query of ['הראשון', 'הרפתקה', 'בלשים', 'תעלומה']) {
      expect(search.search(query).map((result) => result.id)).toContain(
        'collection:piposh-1',
      );
    }
  });

  test('discovers files through Hebrew aliases, tags, paths, descriptions, body text, and relationships', () => {
    const source = catalog({
      items: [
        item({
          path: 'גרסאות מיוחדות/foreign-release.exe',
          aliasesHe: ['מהדורה נדירה'],
          tagsHe: ['תרגום'],
          descriptionHe: 'תיאור חגיגי',
          extractedTextHe: 'קיבינימאט, הבלש שוב הסתבך.',
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    for (const query of ['פיפוש', 'גרסאות', 'נדירה', 'תרגום', 'מיוחדות', 'חגיגי', 'הבלש']) {
      expect(search.search(query).map((result) => result.id)).toContain('file:english');
    }
  });

  test('keeps curated titles more relevant than extracted body text within file results', () => {
    const source = catalog({
      collections: [],
      items: [
        item({
          id: 'body',
          titleHe: 'מסמך',
          path: 'foreign/body.txt',
          extractedTextHe: 'סוד',
          collectionLinks: [],
        }),
        item({
          id: 'title',
          titleHe: 'סוד',
          path: 'foreign/title.txt',
          extractedTextHe: '',
          collectionLinks: [],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    expect(search.search('סוד').map((result) => result.id)).toEqual([
      'file:title',
      'file:body',
    ]);
  });

  test('enforces relevance tiers after reloading an archive-scale sparse index', () => {
    const noise = 'מילה '.repeat(300);
    const target = (id: string, overrides: Partial<CatalogItem>): CatalogItem =>
      item({
        id,
        name: `${id}.bin`,
        path: `foreign/${id}.bin`,
        category: 'ארכיון',
        collectionLinks: [],
        ...overrides,
      });
    const fillers = Array.from({ length: 1_000 }, (_, index) =>
      target(`filler-${index}`, {}),
    );
    const source = catalog({
      collections: [],
      categories: ['ארכיון', 'אוצר'],
      items: [
        ...fillers,
        target('title', { titleHe: `${noise}אוצר` }),
        target('alias', { aliasesHe: [`${noise}אוצר`] }),
        target('path', { path: `${noise}אוצר/file.bin` }),
        target('relationship', {
          collectionLinks: [
            {
              slug: 'treasure',
              titleHe: `${noise}אוצר`,
              relationship: 'about',
            },
          ],
        }),
        target('tag', { tagsHe: ['אוצר'] }),
        target('category', { category: 'אוצר' }),
        target('description', { descriptionHe: 'אוצר' }),
        target('body', { extractedTextHe: 'אוצר' }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const ids = search.search('אוצר').map(({ id }) => id);
    const expectedTiers = [
      ['file:alias', 'file:title'],
      ['file:path', 'file:relationship'],
      ['file:category', 'file:description', 'file:tag'],
      ['file:body'],
    ];
    let offset = 0;

    expect(ids).toHaveLength(8);
    for (const tier of expectedTiers) {
      expect(ids.slice(offset, offset + tier.length).sort()).toEqual([...tier].sort());
      offset += tier.length;
    }
  });

  test('uses document id as a deterministic tie-break within the same relevance tier', () => {
    const source = catalog({
      collections: [],
      items: [
        item({
          id: 'z-tie',
          path: 'foreign/z.bin',
          tagsHe: ['אוצר'],
          collectionLinks: [],
        }),
        item({
          id: 'a-tie',
          path: 'foreign/a.bin',
          tagsHe: ['אוצר'],
          collectionLinks: [],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    expect(search.search('אוצר').map(({ id }) => id)).toEqual([
      'file:a-tie',
      'file:z-tie',
    ]);
  });

  test('indexes deduplicated relationship titles and groups without score inflation', () => {
    const link = {
      slug: 'piposh-1',
      titleHe: 'פיפוש נדיר',
      relationship: 'part-of-release' as const,
      groupHe: 'גרסאות מיוחדות',
    };
    const source = catalog({
      collections: [],
      items: [
        item({
          id: 'single',
          path: 'foreign/single.exe',
          collectionLinks: [link],
        }),
        item({
          id: 'repeated',
          path: 'foreign/repeated.exe',
          collectionLinks: [link, { ...link }, { ...link }],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const results = search.search('פיפוש');
    const single = results.find(({ id }) => id === 'file:single');
    const repeated = results.find(({ id }) => id === 'file:repeated');

    expect(search.search('גרסאות').map((result) => result.id)).toEqual([
      'file:repeated',
      'file:single',
    ]);
    expect(single?.score).toBeCloseTo(repeated?.score ?? Number.NaN, 10);
  });

  test('deduplicates relationship variants after Hebrew search normalization', () => {
    const baseLink = {
      slug: 'piposh-1',
      relationship: 'part-of-release' as const,
    };
    const source = catalog({
      collections: [],
      items: [
        item({
          id: 'canonical',
          path: 'foreign/canonical.exe',
          collectionLinks: [{ ...baseLink, titleHe: 'פיפוש 1' }],
        }),
        item({
          id: 'variants',
          path: 'foreign/variants.exe',
          collectionLinks: [
            { ...baseLink, titleHe: 'פיפוש 1' },
            { ...baseLink, titleHe: 'פִּיפּוֹשׁ 1' },
            { ...baseLink, titleHe: 'פיפוש-1' },
          ],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const results = search.search('פיפוש');
    const canonical = results.find(({ id }) => id === 'file:canonical');
    const variants = results.find(({ id }) => id === 'file:variants');

    expect(canonical?.match).toEqual(variants?.match);
    expect(canonical?.score).toBeCloseTo(variants?.score ?? Number.NaN, 10);
  });

  test('searches only the Hebrew portion of mixed queries', () => {
    const { search } = loadCatalogIndex(catalog());

    expect(search.search('piposh פיפוש').map((result) => result.id)).toEqual(
      search.search('פיפוש').map((result) => result.id),
    );
    expect(search.search('piposh Пипош 123')).toEqual([]);
  });

  test('does not index Latin or Russian filenames while retaining them for display', () => {
    const source = catalog({
      collections: [],
      items: [
        item({
          id: 'latin',
          name: 'piposh-secret.exe',
          path: 'foreign/piposh-secret.exe',
          collectionLinks: [],
        }),
        item({
          id: 'russian',
          name: 'Пипош-секрет.exe',
          path: 'foreign/Пипош-секрет.exe',
          collectionLinks: [],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    expect(search.search('piposh')).toEqual([]);
    expect(search.search('Пипош')).toEqual([]);
    expect(search.search('סוד')).toEqual([]);
  });

  test('stores result metadata and preserves a missing download as null', () => {
    const source = catalog({
      items: [
        item({
          titleHe: 'המהדורה האנגלית',
          downloadUrl: null,
          extractedTextHe: undefined,
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const result: ArchiveSearchResult | undefined = search
      .search('אנגלית')
      .find(({ id }) => id === 'file:english');

    expect(result).toMatchObject({
      id: 'file:english',
      kind: 'file',
      titleHe: 'המהדורה האנגלית',
      href: 'https://drive.google.com/file/d/english/view',
      category: 'משחקים מלאים',
      categories: ['משחקים מלאים'],
      filename: 'piposh1-english.exe',
      path: 'משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe',
      mimeType: 'application/x-msdownload',
      size: 10,
      collectionLinks: [
        {
          slug: 'piposh-1',
          titleHe: 'פיפוש 1',
          relationship: 'part-of-release',
          groupHe: 'גרסאות',
        },
      ],
      viewUrl: 'https://drive.google.com/file/d/english/view',
      downloadUrl: null,
    });
  });

  test('stores empty file metadata and Hebrew categories for collections', () => {
    const source = catalog({
      collections: [collection()],
      items: [
        item({ id: 'music', category: 'מוזיקה' }),
        item({ id: 'english', category: 'משחקים מלאים' }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const result = search.search('פיפוש').find(({ id }) => id === 'collection:piposh-1');

    expect(result).toMatchObject({
      category: 'משחקים מלאים',
      categories: ['משחקים מלאים'],
      filename: '',
      path: '',
      mimeType: '',
      size: null,
      collectionLinks: [],
      viewUrl: null,
      downloadUrl: null,
    });
  });

  test('derives unique collection categories in catalog item order and filters against all of them', () => {
    const officialLink = {
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      relationship: 'part-of-release' as const,
    };
    const source = catalog({
      collections: [collection({ itemIds: ['game', 'music', 'duplicate-category'] })],
      items: [
        item({
          id: 'music',
          category: 'מוזיקה',
          path: 'foreign/music.bin',
          collectionLinks: [officialLink],
        }),
        item({
          id: 'game',
          category: 'משחקים מלאים',
          path: 'foreign/game.bin',
          collectionLinks: [officialLink],
        }),
        item({
          id: 'duplicate-category',
          category: 'מוזיקה',
          path: 'foreign/duplicate.bin',
          collectionLinks: [officialLink],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);
    const unfiltered = search.search('פיפוש');
    const result = unfiltered.find(({ id }) => id === 'collection:piposh-1');

    expect(result).toMatchObject({
      category: 'מוזיקה',
      categories: ['מוזיקה', 'משחקים מלאים'],
    });
    expect(search.search('פיפוש', { category: 'משחקים מלאים' }).map(({ id }) => id)).toEqual([
      'collection:piposh-1',
      'file:game',
    ]);
    expect(search.search('פיפוש', { category: 'מוזיקה' }).map(({ id }) => id)).toEqual([
      'collection:piposh-1',
      'file:duplicate-category',
      'file:music',
    ]);
    expect(search.search('מוזיקה').map(({ id }) => id)).toContain('collection:piposh-1');
  });

  test('adds a covers-and-manuals facet from official material groups', () => {
    const officialLink = {
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      relationship: 'part-of-release' as const,
    };
    const source = catalog({
      collections: [collection({ itemIds: ['manual', 'game'] })],
      items: [
        item({
          id: 'manual',
          path: 'משחקים מלאים/פיפוש 1/חוברת/Scan.jpg',
          collectionLinks: [{ ...officialLink, groupHe: 'חוברות' }],
        }),
        item({
          id: 'game',
          path: 'משחקים מלאים/פיפוש 1/game.exe',
          collectionLinks: [{ ...officialLink, groupHe: 'גרסאות המשחק' }],
        }),
      ],
    });
    const { search } = loadCatalogIndex(source);

    expect(searchFilterValues(source)).toEqual(['משחקים מלאים', 'עטיפות וחוברות']);
    expect(search.search('פיפוש', { category: 'עטיפות וחוברות' }).map(({ id }) => id)).toEqual([
      'collection:piposh-1',
      'file:manual',
    ]);
  });

  test('orders collections before stronger file matches and supports a positive result limit', () => {
    const source = catalog({
      collections: [collection({ titleHe: 'אוסף', tagsHe: ['מפתח'] })],
      items: [item({ titleHe: 'מפתח', collectionLinks: [] })],
    });
    const { search } = loadCatalogIndex(source);

    expect(search.search('מפתח').map(({ id }) => id)).toEqual([
      'collection:piposh-1',
      'file:english',
    ]);
    expect(search.search('מפתח', { limit: 1 }).map(({ id }) => id)).toEqual([
      'collection:piposh-1',
    ]);
  });

  test('uses game routes for games and the archive route for other collection types', () => {
    const source = catalog({
      collections: [
        collection(),
        collection({
          slug: 'press',
          titleHe: 'עיתונות',
          type: 'press',
          itemIds: [],
        }),
      ],
      items: [],
    });
    const { search } = loadCatalogIndex(source);

    expect(search.search('פיפוש').find(({ id }) => id === 'collection:piposh-1')).toMatchObject({
      href: '/games/piposh-1/',
      viewUrl: null,
      downloadUrl: null,
    });
    expect(search.search('עיתונות').find(({ id }) => id === 'collection:press')).toMatchObject({
      href: '/archive/',
      category: '',
      categories: [],
    });
  });

  test('handles absent optional item fields and empty catalogs or queries', () => {
    const source = catalog({
      items: [item({ titleHe: undefined, extractedTextHe: undefined })],
    });
    const { search } = loadCatalogIndex(source);
    const empty = loadCatalogIndex(catalog({ collections: [], items: [], categories: [] }));

    expect(search.search('')).toEqual([]);
    expect(search.search('  / 123 ')).toEqual([]);
    expect(search.search('פיפוש').map((result) => result.id)).toContain('file:english');
    expect(empty.search.search('פיפוש')).toEqual([]);
  });

  test('serializes deterministically without mutating the catalog', () => {
    const source = catalog();
    const snapshot = structuredClone(source);

    expect(buildSearchIndex(source)).toBe(buildSearchIndex(source));
    expect(source).toEqual(snapshot);
  });

  test('rejects duplicate document ids instead of silently replacing results', () => {
    const source = catalog({ items: [item(), item()] });

    expect(() => buildSearchIndex(source)).toThrow(/duplicate ID/i);
  });
});
