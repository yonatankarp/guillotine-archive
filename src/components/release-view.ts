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
  'fan-disc': 'דיסק של מעריצים',
  'audio-cd': 'דיסק מוזיקה',
  video: 'וידאו',
  press: 'מה שכתבו עלינו',
  'fan-game': 'משחק של מעריצים',
  other: 'לא ברור מה זה',
};

const KIND_LABELS: Record<ItemKind, string> = {
  video: 'סרטון',
  track: 'שיר',
  sound: 'רעש מתוך המשחק',
  'booklet-page': 'עמוד מהחוברת',
  'press-page': 'עמוד מהעיתון',
  'comic-page': 'עמוד קומיקס',
  cover: 'עטיפה',
  sprite: 'תמונה של דמות',
  scan: 'סריקה',
  build: 'המשחק עצמו',
  document: 'מסמך',
  'game-data': 'הקרביים של המשחק',
  noise: 'קובץ שאף אחד לא ביקש',
  other: 'לא ברור מה זה',
};

/**
 * Named for what a section holds, in the studio's own register rather than a
 * cataloguer's. They stay noun phrases, not instructions: an infinitive promises
 * an experience a section of links cannot deliver.
 * Video is its own section: a poster with a duration is not a scan.
 */
const SECTIONS: Array<{ id: string; headingHe: string; kinds: readonly ItemKind[] }> = [
  { id: 'downloads', headingHe: 'מה שאפשר להוריד ולשחק', kinds: ['build'] },
  {
    id: 'gallery',
    headingHe: 'תמונות שסרקנו',
    kinds: ['cover', 'scan', 'booklet-page', 'comic-page', 'press-page'],
  },
  { id: 'video', headingHe: 'סרטונים', kinds: ['video'] },
  { id: 'music', headingHe: 'מוזיקה', kinds: ['track'] },
  { id: 'documents', headingHe: 'מסמכים ושאר נייר', kinds: ['document'] },
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
 * A booklet is not a box, and a lyrics book is not an instruction book. The catalog stores
 * both booklets as booklet-page, so kind cannot tell them apart — but the archive already
 * filed them apart, one directory per physical object, and that directory name is usually
 * the object's own name. The folder above a file is therefore the grouping, and nothing here
 * classifies anything the archive did not already decide.
 */
export interface MediaGroup {
  /** Stable across catalog reorders: derived from the folder name, never from its position. */
  id: string;
  headingHe: string;
  items: CatalogItem[];
}

/** Box before booklet before loose scan: the order you meet the thing in, not the filing order. */
const GALLERY_KIND_ORDER: readonly ItemKind[] = [
  'cover',
  'booklet-page',
  'comic-page',
  'press-page',
  'scan',
];

const TITLE_PREFIX_SEPARATOR = ' - ';

/**
 * Geresh, gershayim and the ASCII quotes stand in for each other across the archive: the
 * catalog title is ווג׳ימון and its folder is ווג'ימון. Dropping them lets the two forms of
 * one name compare equal without transliterating anything.
 */
function foldedName(value: string): string {
  return value.replace(/[׳״'"]/gu, '').replace(/\s+/gu, ' ').trim();
}

/**
 * A folder called "פיפוש 1 - חוברת שירים" sits under a heading that already says פיפוש 1, so
 * the prefix is repeated furniture. It is stripped only when it really is the release's own
 * name — the title carries a preposition the folder does not (בתככי הרייטינג over
 * תככי הרייטינג - חוברת), so either one containing the other counts.
 */
export function galleryGroupHeading(folderHe: string, releaseTitleHe: string): string {
  const separator = folderHe.indexOf(TITLE_PREFIX_SEPARATOR);
  if (separator === -1) return folderHe;

  const prefix = foldedName(folderHe.slice(0, separator));
  const rest = folderHe.slice(separator + TITLE_PREFIX_SEPARATOR.length).trim();
  const title = foldedName(releaseTitleHe);
  if (prefix.length === 0 || rest.length === 0 || title.length === 0) return folderHe;

  return title.includes(prefix) || prefix.includes(title) ? rest : folderHe;
}

/** The directory a file was filed in, which is the physical object it was scanned from. */
function galleryFolder(item: Pick<CatalogItem, 'path' | 'name'>): string {
  return item.path.split('/').slice(-2, -1)[0] ?? item.name;
}

/**
 * Scans split into the objects they came from, in a fixed order. Groups sort by the earliest
 * kind they hold and then by heading, never by catalog position: rebuilding the catalog
 * reorders itemIds, and a gallery that reshuffles itself on an unrelated sync is not an
 * exhibition. Items keep the order they arrive in, because that is the page order of a booklet.
 */
export function galleryGroups(
  items: readonly CatalogItem[],
  releaseTitleHe: string,
): MediaGroup[] {
  const byFolder = new Map<string, CatalogItem[]>();
  for (const item of items) {
    const folder = galleryFolder(item);
    const existing = byFolder.get(folder);
    if (existing) existing.push(item);
    else byFolder.set(folder, [item]);
  }

  const rankOf = (group: readonly CatalogItem[]) =>
    Math.min(
      ...group.map((item) => {
        const rank = GALLERY_KIND_ORDER.indexOf(item.kind);
        return rank === -1 ? GALLERY_KIND_ORDER.length : rank;
      }),
    );

  return [...byFolder]
    .map(([folder, group]) => ({
      id: `group-${hashOf(folder).toString(36)}`,
      headingHe: galleryGroupHeading(folder, releaseTitleHe),
      items: group,
    }))
    .sort((left, right) => {
      const byKind = rankOf(left.items) - rankOf(right.items);
      return byKind !== 0 ? byKind : left.headingHe.localeCompare(right.headingHe, 'he');
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

/**
 * True when the ORIGINAL file plays in no browser as it is. Not a claim about
 * derivatives: the pipeline transcodes WMV, AVI, MPEG and VOB to MP4, so a file
 * this returns true for can still reach a visitor through a rendition.
 */
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
