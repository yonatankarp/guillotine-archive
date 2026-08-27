import type { CatalogItem, ItemKind, Release, ReleaseType } from '../catalog/types';

/**
 * Presentation-side derivations for the release pages. The catalog is the authority on what
 * exists; everything here is about how a release is shown, which is why it lives beside the
 * components rather than in src/lib.
 */

export interface ReleaseSection {
  id: string;
  headingHe: string;
  items: CatalogItem[];
  /** Items beyond the render cap, still reachable through the Drive mirror. */
  hiddenCount: number;
}

/**
 * Accents are lifted from the box art of the era rather than generated, and are used only for
 * washes, rules and dither ink. Nothing here is ever a text colour, so a release cannot pick a
 * hue that fails contrast.
 */
const ACCENTS = [
  '#c9432f',
  '#d98b22',
  '#c8a21b',
  '#6e9b2e',
  '#2e9b8a',
  '#4fa8c9',
  '#6b6bc4',
  '#b7418c',
] as const;

const RELEASE_TYPE_LABELS: Record<ReleaseType, string> = {
  game: 'משחק',
  demo: 'דמו',
  'fan-disc': 'דיסק מעריצים',
  'audio-cd': 'דיסק שמע',
  video: 'וידאו',
  press: 'עיתונות',
  'fan-game': 'משחק מעריצים',
  other: 'אחר',
};

const KIND_LABELS: Record<ItemKind, string> = {
  video: 'סרטון',
  track: 'רצועה',
  sound: 'קטע קול',
  'booklet-page': 'עמוד חוברת',
  'press-page': 'עמוד עיתונות',
  'comic-page': 'עמוד קומיקס',
  cover: 'עטיפה',
  sprite: 'ספרייט',
  scan: 'סריקה',
  build: 'קובץ הפעלה',
  document: 'מסמך',
  'game-data': 'נתוני משחק',
  noise: 'קובץ עזר',
  other: 'אחר',
};

const SECTIONS: Array<{ id: string; headingHe: string; kinds: readonly ItemKind[] }> = [
  { id: 'play', headingHe: 'לשחק', kinds: ['build'] },
  {
    id: 'see',
    headingHe: 'לראות',
    kinds: ['cover', 'scan', 'booklet-page', 'comic-page', 'press-page', 'video'],
  },
  { id: 'hear', headingHe: 'להאזין', kinds: ['track'] },
  { id: 'read', headingHe: 'לקרוא', kinds: ['document'] },
];

/**
 * Files that exist because a game was installed, not because anyone catalogued
 * them: sprite sheets, the engine's sound bank, save data, AUTORUN.INF. They are
 * 1,862 of the archive's 2,816 items, and two of the demo releases are 399
 * engine files to a single exhibit, because a demo IS an installed directory.
 *
 * Listing them individually presents an unpacked install as though it were an
 * exhibition. They are summarised as a bundle instead, and the Drive mirror under
 * /archive still lists every one for anyone who wants the filenames.
 */
const BUNDLED_KINDS: readonly ItemKind[] = ['sprite', 'sound', 'game-data', 'noise'];

export interface BundledGroup {
  kind: ItemKind;
  count: number;
  bytes: number;
}

/** Engine contents of a release, counted by kind rather than listed. */
export function releaseBundle(items: readonly CatalogItem[]): BundledGroup[] {
  return BUNDLED_KINDS.flatMap((kind) => {
    const matching = items.filter((item) => item.kind === kind);
    if (matching.length === 0) return [];

    return [
      {
        kind,
        count: matching.length,
        bytes: matching.reduce((sum, item) => sum + (item.size ?? 0), 0),
      },
    ];
  });
}

/**
 * The largest release holds 754 items. Rendering every row would put a 754-row DOM behind one
 * heading, so a section shows its first rows and hands the rest to the Drive mirror, which is
 * paginated and exists for exactly this.
 */
export const SECTION_ITEM_CAP = 36;

/** Mime types no browser will ever play, whatever derivatives we build later. */
const NEVER_PLAYABLE = new Set([
  'video/x-ms-wmv',
  'video/x-msvideo',
  'video/mpeg',
  'video/mp2p',
  'video/vob',
  'audio/x-ms-wma',
  'audio/x-aiff',
  'audio/aiff',
]);

function hashOf(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** No release in the catalog carries an accent yet, so the slug picks a stable one. */
export function releaseAccent(release: Release): string {
  return release.accent ?? ACCENTS[hashOf(release.slug) % ACCENTS.length]!;
}

export function releaseCoverPath(release: Release): string | null {
  return release.coverFileId ? `generated/covers/${release.coverFileId}.webp` : null;
}

export function releaseTypeLabel(type: ReleaseType): string {
  return RELEASE_TYPE_LABELS[type];
}

export function itemKindLabel(kind: ItemKind): string {
  return KIND_LABELS[kind];
}

export function releaseItems(release: Release, itemById: Map<string, CatalogItem>): CatalogItem[] {
  return release.itemIds
    .map((id) => itemById.get(id))
    .filter((item): item is CatalogItem => item !== undefined);
}

export function releaseSections(items: readonly CatalogItem[]): ReleaseSection[] {
  return SECTIONS.flatMap(({ id, headingHe, kinds }) => {
    const matching = items.filter((item) => kinds.includes(item.kind));
    if (matching.length === 0) return [];

    return [
      {
        id,
        headingHe,
        items: matching.slice(0, SECTION_ITEM_CAP),
        hiddenCount: Math.max(0, matching.length - SECTION_ITEM_CAP),
      },
    ];
  });
}

/**
 * The archive shelf that holds all of a set of items, or null when they are spread over more
 * than one. Six releases span two or three shelves — פיפוש 1 alone is filed under משחקים
 * מלאים, פתרונות and שירים — so a single "see the rest on its shelf" link derived from one
 * item would point at a shelf that does not hold the files it just promised.
 */
export function sharedMirrorCategory(items: readonly CatalogItem[]): string | null {
  const categories = new Set(items.map((item) => item.category));
  return categories.size === 1 ? [...categories][0]! : null;
}

export function itemCountsByKind(items: readonly CatalogItem[]): Array<[ItemKind, number]> {
  const counts = new Map<ItemKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);

  return [...counts].sort(([, left], [, right]) => right - left);
}

/** True when no browser can play the file even once derivatives exist. */
export function neverPlayable(item: Pick<CatalogItem, 'mimeType'>): boolean {
  return NEVER_PLAYABLE.has(item.mimeType.toLowerCase());
}

/**
 * The fan games on דיסק הקונגרס are filed one directory per author, which is the only place the
 * catalog records who made something. Everything else drops the credit on the floor.
 */
export function creditedAuthor(item: Pick<CatalogItem, 'path'>): string | null {
  const segments = item.path.split('/');
  const gamesIndex = segments.findIndex(
    (segment, index) => segment === 'Games' && segments[index - 1] === 'Atraktivi',
  );
  if (gamesIndex === -1) return null;

  const author = segments[gamesIndex + 1];
  return author !== undefined && gamesIndex + 2 < segments.length ? author : null;
}

export function creditedWorks(
  items: readonly CatalogItem[],
): Array<{ author: string; items: CatalogItem[] }> {
  const byAuthor = new Map<string, CatalogItem[]>();
  for (const item of items) {
    const author = creditedAuthor(item);
    if (author === null) continue;
    const existing = byAuthor.get(author);
    if (existing) existing.push(item);
    else byAuthor.set(author, [item]);
  }

  return [...byAuthor]
    .map(([author, works]) => ({ author, items: works }))
    .sort((left, right) => left.author.localeCompare(right.author, 'he'));
}

/**
 * Extracted documents run to 20,625 characters. A room showing 36 of them in full would ship
 * most of a megabyte of HTML, so the page carries an excerpt and says so, and the whole file
 * stays one Drive link away.
 */
const TEXT_EXCERPT_LIMIT = 900;

export interface TextExcerpt {
  textHe: string;
  truncated: boolean;
}

export function textExcerpt(value: string): TextExcerpt {
  const text = value.trim();
  if (text.length <= TEXT_EXCERPT_LIMIT) return { textHe: text, truncated: false };

  const cut = text.slice(0, TEXT_EXCERPT_LIMIT);
  const lastBreak = cut.lastIndexOf(' ');

  return { textHe: (lastBreak > TEXT_EXCERPT_LIMIT / 2 ? cut.slice(0, lastBreak) : cut).trim(), truncated: true };
}
