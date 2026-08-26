import type {
  Catalog,
  CatalogCollection,
  CatalogItem,
  CollectionLink,
  CuratedCollection,
  CuratorConfig,
  CuratorRule,
  DriveFile,
} from './types';

function matchesRule(file: DriveFile, rule: CuratorRule): boolean {
  if (rule.match === 'file-id') {
    return file.id === rule.value;
  }

  if (rule.match === 'exact-path') {
    return file.path === rule.value;
  }

  return file.path === rule.value || file.path.startsWith(`${rule.value}/`);
}

function categoryFromPath(path: string): string {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length >= 2 ? segments[0]! : 'אחר';
}

function linkKey(link: CollectionLink): string {
  return JSON.stringify([link.slug, link.relationship, link.groupHe ?? null]);
}

function copyRule(rule: CuratorRule): CuratorRule {
  return { ...rule };
}

function copyCollection(collection: CuratedCollection): CuratedCollection {
  return {
    ...collection,
    aliasesHe: [...collection.aliasesHe],
    tagsHe: [...collection.tagsHe],
    rules: collection.rules.map(copyRule),
    exclude: collection.exclude.map(copyRule),
  };
}

function copyFile(file: DriveFile): CatalogItem {
  return {
    ...file,
    parentIds: [...file.parentIds],
    category: categoryFromPath(file.path),
    aliasesHe: [],
    tagsHe: [],
    collectionLinks: [],
  };
}

const HEBREW_ALPHABET = [...'אבגדהוזחטיכלמנסעפצקרשת'];
const HEBREW_RANK = new Map(HEBREW_ALPHABET.map((letter, index) => [letter, index]));
const FINAL_TO_BASE: Readonly<Record<string, string>> = {
  ך: 'כ',
  ם: 'מ',
  ן: 'נ',
  ף: 'פ',
  ץ: 'צ',
};
const HEBREW_MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/gu;

function hebrewCollationKey(value: string): string[] {
  return [...value.normalize('NFKD').replace(HEBREW_MARKS, '')].map(
    (character) => FINAL_TO_BASE[character] ?? character,
  );
}

function characterRank(character: string): number {
  return HEBREW_RANK.get(character) ?? HEBREW_ALPHABET.length + character.codePointAt(0)!;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;

    if (difference !== 0) {
      return difference;
    }
  }

  return leftPoints.length - rightPoints.length;
}

function compareHebrew(left: string, right: string): number {
  const leftKey = hebrewCollationKey(left);
  const rightKey = hebrewCollationKey(right);
  const sharedLength = Math.min(leftKey.length, rightKey.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = characterRank(leftKey[index]!) - characterRank(rightKey[index]!);

    if (difference !== 0) {
      return difference;
    }
  }

  const lengthDifference = leftKey.length - rightKey.length;

  if (lengthDifference !== 0) {
    return lengthDifference;
  }

  return compareCodePoints(left, right);
}

export function resolveRelationships(
  files: readonly DriveFile[],
  curatorConfig: Readonly<CuratorConfig>,
  generatedAt = new Date().toISOString(),
): Catalog {
  const items = files.map(copyFile);
  const collections: CatalogCollection[] = curatorConfig.collections.map((sourceCollection) => {
    const collection = copyCollection(sourceCollection);
    const itemIds: string[] = [];
    const includedIds = new Set<string>();

    for (const item of items) {
      if (collection.exclude.some((rule) => matchesRule(item, rule))) {
        continue;
      }

      const existingLinks = new Set(item.collectionLinks.map(linkKey));

      for (const rule of collection.rules) {
        if (!matchesRule(item, rule)) {
          continue;
        }

        const link: CollectionLink = {
          slug: collection.slug,
          titleHe: collection.titleHe,
          relationship: rule.relationship,
          ...(rule.groupHe === undefined ? {} : { groupHe: rule.groupHe }),
        };
        const key = linkKey(link);

        if (!existingLinks.has(key)) {
          item.collectionLinks.push(link);
          existingLinks.add(key);
        }

        if (rule.relationship === 'part-of-release' && !includedIds.has(item.id)) {
          itemIds.push(item.id);
          includedIds.add(item.id);
        }
      }
    }

    return {
      ...collection,
      coverUrl: collection.coverFileId
        ? `/generated/covers/${collection.coverFileId}.webp`
        : null,
      itemIds,
    };
  });
  const categories = [...new Set(items.map((item) => item.category))].sort(compareHebrew);

  return {
    generatedAt,
    collections,
    items,
    categories,
  };
}
