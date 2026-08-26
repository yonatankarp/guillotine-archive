import MiniSearch, { type Options, type SearchResult } from 'minisearch';
import type { Catalog, CollectionLink } from './types';

export interface SearchResultMetadata {
  kind: 'collection' | 'file';
  titleHe: string;
  href: string;
  category: string;
  categories: string[];
  filename: string;
  path: string;
  mimeType: string;
  size: number | null;
  collectionLinks: CollectionLink[];
  viewUrl: string | null;
  downloadUrl: string | null;
}

export interface SearchDocument extends SearchResultMetadata {
  id: string;
  aliasesHe: string;
  pathHe: string;
  relationshipsHe: string;
  tagsHe: string;
  categoriesHe: string;
  descriptionHe: string;
  textHe: string;
}

type MiniSearchResultFields = Pick<
  SearchResult,
  'terms' | 'queryTerms' | 'score' | 'match'
>;

export type ArchiveSearchResult = MiniSearchResultFields &
  SearchResultMetadata & { id: string };

export interface ArchiveSearchOptions {
  category?: string;
  limit?: number;
}

export interface SearchEngine {
  options: Options<SearchDocument>;
  engine: MiniSearch<SearchDocument>;
  search(query: string, options?: ArchiveSearchOptions): ArchiveSearchResult[];
}

const FINAL_LETTERS: Readonly<Record<string, string>> = {
  ך: 'כ',
  ם: 'מ',
  ן: 'נ',
  ף: 'פ',
  ץ: 'צ',
};
const HEBREW_MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/gu;
const HEBREW_SEPARATORS = /[\u05BE\u05C0\u05C3\u05C6]/gu;
const QUOTE_MARKS = /["'`׳״“”‘’]+/gu;
const PUNCTUATION_OR_SYMBOLS = /[\p{P}\p{S}]+/gu;
const HEBREW_LETTERS = /[\u05D0-\u05EA]+/gu;
const SEARCH_TERMS =
  /[\u05D0-\u05EA]+|(?<![\p{L}\p{Nd}])\p{Nd}+(?![\p{L}\p{Nd}])/gu;
const HEBREW_TERM = /^[\u05D0-\u05EA]+$/u;
const NUMERIC_TERM = /^\p{Nd}+$/u;
const COVERS_AND_MANUALS_FACET = 'עטיפות וחוברות';
const COVERS_AND_MANUALS_GROUP = /אריזה|עטיפ|חובר/u;
const SEARCH_FIELD_TIERS: Readonly<Record<string, number>> = {
  titleHe: 0,
  aliasesHe: 0,
  pathHe: 1,
  relationshipsHe: 1,
  tagsHe: 2,
  categoriesHe: 2,
  descriptionHe: 2,
  textHe: 3,
};
const UNKNOWN_MATCH_TIER = 4;

export function normalizeHebrew(value: string): string {
  return value
    .normalize('NFKD')
    .replace(HEBREW_MARKS, '')
    .replace(QUOTE_MARKS, '')
    .replace(HEBREW_SEPARATORS, ' ')
    .replace(/[ךםןףץ]/gu, (letter) => FINAL_LETTERS[letter] ?? letter)
    .replace(PUNCTUATION_OR_SYMBOLS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function extractHebrewTokens(value: string): string[] {
  return normalizeHebrew(value).match(HEBREW_LETTERS) ?? [];
}

function extractSearchTokens(value: string): string[] {
  return normalizeHebrew(value).match(SEARCH_TERMS) ?? [];
}

function processSearchTerm(term: string): string | null {
  const normalized = normalizeHebrew(term);

  return HEBREW_TERM.test(normalized) || NUMERIC_TERM.test(normalized) ? normalized : null;
}

function supportedQueryKey(value: string): string {
  return normalizeHebrew(value)
    .split(' ')
    .filter((term) => HEBREW_TERM.test(term) || NUMERIC_TERM.test(term))
    .join(' ');
}

export function getSearchOptions(): Options<SearchDocument> {
  return {
    fields: [
      'titleHe',
      'aliasesHe',
      'pathHe',
      'relationshipsHe',
      'tagsHe',
      'categoriesHe',
      'descriptionHe',
      'textHe',
    ],
    storeFields: [
      'kind',
      'titleHe',
      'href',
      'category',
      'categories',
      'filename',
      'path',
      'mimeType',
      'size',
      'collectionLinks',
      'viewUrl',
      'downloadUrl',
    ],
    tokenize: extractSearchTokens,
    processTerm: processSearchTerm,
    idField: 'id',
  };
}

function bestMatchTier(result: Pick<SearchResult, 'match'>): number {
  if (!result.match || typeof result.match !== 'object') {
    return UNKNOWN_MATCH_TIER;
  }

  let bestTier = UNKNOWN_MATCH_TIER;

  for (const fields of Object.values(result.match as Record<string, unknown>)) {
    if (!Array.isArray(fields)) {
      continue;
    }

    for (const field of fields) {
      if (typeof field === 'string') {
        bestTier = Math.min(bestTier, SEARCH_FIELD_TIERS[field] ?? UNKNOWN_MATCH_TIER);
      }
    }
  }

  return bestTier;
}

function compareResultIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function compareSearchResults(
  left: ArchiveSearchResult,
  right: ArchiveSearchResult,
  normalizedQuery: string,
): number {
  const leftKindRank = left.kind === 'collection' ? 0 : 1;
  const rightKindRank = right.kind === 'collection' ? 0 : 1;
  const kindDifference = leftKindRank - rightKindRank;

  if (kindDifference !== 0) {
    return kindDifference;
  }

  const exactTitleDifference =
    Number(supportedQueryKey(right.titleHe) === normalizedQuery) -
    Number(supportedQueryKey(left.titleHe) === normalizedQuery);

  if (exactTitleDifference !== 0) {
    return exactTitleDifference;
  }

  const tierDifference = bestMatchTier(left) - bestMatchTier(right);

  if (tierDifference !== 0) {
    return tierDifference;
  }

  const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
  const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
  const scoreDifference = rightScore - leftScore;

  return scoreDifference !== 0 ? scoreDifference : compareResultIds(left.id, right.id);
}

export function createSearchEngine(existing?: MiniSearch<SearchDocument>): SearchEngine {
  const options = getSearchOptions();
  const engine = existing ?? new MiniSearch<SearchDocument>(options);

  return {
    options,
    engine,
    search(query: string, queryOptions: ArchiveSearchOptions = {}): ArchiveSearchResult[] {
      if (extractHebrewTokens(query).length === 0) {
        return [];
      }

      const matches = engine.search(query, {
        prefix: true,
        fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
        boost: {
          titleHe: 5,
          aliasesHe: 4,
          pathHe: 3,
          relationshipsHe: 3,
          tagsHe: 2,
          categoriesHe: 2,
          descriptionHe: 2,
          textHe: 1,
        },
      }) as ArchiveSearchResult[];
      const { category } = queryOptions;
      const filtered = category
        ? matches.filter((result) => result.categories.includes(category))
        : matches;
      const normalizedQuery = supportedQueryKey(query);
      const ordered = [...filtered].sort((left, right) =>
        compareSearchResults(left, right, normalizedQuery),
      );

      if (
        queryOptions.limit !== undefined &&
        Number.isFinite(queryOptions.limit) &&
        queryOptions.limit > 0
      ) {
        return ordered.slice(0, Math.max(1, Math.floor(queryOptions.limit)));
      }

      return ordered;
    },
  };
}

function collectionHref(type: string, slug: string): string {
  return type === 'game' ? `/games/${slug}/` : '/archive/';
}

function uniqueStrings(values: Iterable<string | undefined>): string[] {
  const unique = new Set<string>();

  for (const value of values) {
    if (value) {
      unique.add(value);
    }
  }

  return [...unique];
}

function uniqueHebrewSearchValues(values: Iterable<string | undefined>): string[] {
  const normalizedValues = new Set<string>();

  for (const value of values) {
    if (value) {
      const normalized = extractSearchTokens(value).join(' ');

      if (normalized) {
        normalizedValues.add(normalized);
      }
    }
  }

  return [...normalizedValues];
}

function semanticFacets(item: Catalog['items'][number]): string[] {
  const hasCoversOrManuals = item.collectionLinks.some(
    ({ groupHe, relationship }) =>
      relationship === 'part-of-release' &&
      groupHe !== undefined &&
      COVERS_AND_MANUALS_GROUP.test(groupHe),
  );

  return hasCoversOrManuals ? [COVERS_AND_MANUALS_FACET] : [];
}

function itemFilterCategories(item: Catalog['items'][number]): string[] {
  return uniqueStrings([item.category, ...semanticFacets(item)]);
}

function collectionCategories(catalog: Readonly<Catalog>, itemIds: readonly string[]): string[] {
  const officialItemIds = new Set(itemIds);

  return uniqueStrings(
    catalog.items
      .filter((item) => officialItemIds.has(item.id))
      .flatMap(itemFilterCategories),
  );
}

export function searchFilterValues(catalog: Readonly<Catalog>): string[] {
  return uniqueStrings([
    ...catalog.categories,
    ...catalog.items.flatMap(semanticFacets),
  ]);
}

export function buildSearchIndex(catalog: Readonly<Catalog>): string {
  const documents: SearchDocument[] = [];

  for (const collection of catalog.collections) {
    const categories = collectionCategories(catalog, collection.itemIds);

    documents.push({
      id: `collection:${collection.slug}`,
      kind: 'collection',
      titleHe: collection.titleHe,
      aliasesHe: collection.aliasesHe.join(' '),
      pathHe: '',
      relationshipsHe: '',
      tagsHe: collection.tagsHe.join(' '),
      categoriesHe: categories.join(' '),
      descriptionHe: [collection.summaryHe, collection.descriptionHe ?? '']
        .filter(Boolean)
        .join(' '),
      textHe: '',
      href: collectionHref(collection.type, collection.slug),
      category: categories[0] ?? '',
      categories,
      filename: '',
      path: '',
      mimeType: '',
      size: null,
      collectionLinks: [],
      viewUrl: null,
      downloadUrl: null,
    });
  }

  for (const item of catalog.items) {
    const relationships = uniqueHebrewSearchValues(
      item.collectionLinks.flatMap((link) => [link.titleHe, link.groupHe]),
    );
    const filterCategories = itemFilterCategories(item);

    documents.push({
      id: `file:${item.id}`,
      kind: 'file',
      titleHe: item.titleHe ?? '',
      aliasesHe: item.aliasesHe.join(' '),
      pathHe: extractSearchTokens(item.path).join(' '),
      relationshipsHe: relationships.join(' '),
      tagsHe: item.tagsHe.join(' '),
      categoriesHe: filterCategories.join(' '),
      descriptionHe: item.descriptionHe ?? '',
      textHe: item.extractedTextHe ?? '',
      href: item.viewUrl,
      category: item.category,
      categories: filterCategories,
      filename: item.name,
      path: item.path,
      mimeType: item.mimeType,
      size: item.size,
      collectionLinks: item.collectionLinks.map((link) => ({ ...link })),
      viewUrl: item.viewUrl,
      downloadUrl: item.downloadUrl,
    });
  }

  const engine = createSearchEngine().engine;
  engine.addAll(documents);

  return JSON.stringify(engine);
}
