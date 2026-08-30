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

/**
 * The geometry of the artwork drawn behind a release that has no cover.
 *
 * 33 of the 42 releases have no art anywhere in the archive — 29 of them contain no image file
 * at all, and the one exception is a single .ico — so there is nothing to derive a picture from
 * and nothing a sync will ever supply. The mat draws one instead: concentric rings off an
 * off-centre point, which is the burn ring of the CD-R the release actually is.
 *
 * Only the geometry is computed here. The colours stay in the stylesheet as color-mix over
 * --accent and --mat, so the artwork follows the theme and the release's own hue without this
 * function knowing either. Seeded from the slug the same way the accent is, so a release keeps
 * its own picture across builds and a sync cannot reshuffle them.
 *
 * Deliberately NOT an image: no canvas, no data URI, no generated file. A CSS gradient costs
 * nothing at build time, needs no request, survives with scripting off, and cannot go missing
 * from public/ the way a written artifact can.
 */
export interface CoverlessArt {
  /** Ring centre, as percentages of the mat. */
  x: number;
  y: number;
  /** Distance between rings, in px at the mat's own scale. */
  step: number;
}

export function coverlessArt(slug: string): CoverlessArt {
  const hash = hashOf(`art:${slug}`);
  /*
   * The centre is kept off the middle third in at least one axis: a ring pattern centred behind
   * the label draws a bullseye around the title, and the title is what has to be read. Ranges
   * are 12-88% so the centre stays inside the mat and the rings always resolve as arcs.
   */
  const x = 12 + ((hash >>> 3) % 77);
  const y = 12 + ((hash >>> 11) % 77);
  /* 7-16px. Below 7 the rings alias into a grey wash at tile size; above 16 a 270px tile shows
     only three of them and the pattern stops reading as a spiral. */
  const step = 7 + ((hash >>> 19) % 10);
  return { x, y, step };
}

/** No release in the catalog carries an accent yet, so the slug picks a stable one. */
export function releaseAccent(release: Release): string {
  return release.accent ?? ACCENTS[hashOf(release.slug) % ACCENTS.length]!;
}

/*
 * Covers that exist on the SITE but not in the archive. פיפוש המהפכה has no cover art in Drive
 * at all — only map scans — and the only image of its box anywhere is a 118x158 one. It lives
 * under public/assets/, which the sync does not manage, so a sync can neither overwrite it nor
 * delete it, and nothing about it enters the catalog. Recorded rather than silent because this
 * is the one image on the site that is not the owner's own material.
 */
const SITE_ONLY_COVERS: Readonly<Record<string, string>> = {
  'piposh-revolution': 'assets/covers/piposh-revolution.webp',
};

export function releaseCoverPath(release: Release): string | null {
  const siteOnly = SITE_ONLY_COVERS[release.slug];
  if (siteOnly) return siteOnly;

  return release.coverFileId ? `generated/covers/${release.coverFileId}.webp` : null;
}

/**
 * Pages of one paginated object. A set of these has a first page, and the first page of a
 * comic or a press cutting is the face of the thing — which is what a cover is.
 */
const PAGINATED_KINDS: readonly ItemKind[] = ['comic-page', 'press-page', 'booklet-page'];

export interface StandInRendition {
  /** Site-relative, still to be passed through `sitePath()` by the caller. */
  path: string;
  width: number;
}

export interface StandInCover extends StandInRendition {
  height: number;
  /** srcset candidates, narrowest first, or empty when there is nothing to choose between. */
  renditions: StandInRendition[];
}

/**
 * The one image a coverless release already owns that can stand for the cover it never had.
 *
 * Both rules read `kind`, never a filename: the sync classified these files once and a rule
 * that re-matched Hebrew filenames here would rot the next time the archive is re-read.
 *
 *  1. An item the catalog filed as `cover`. בטשת מואב's עטיפה.jpg is one, sitting beside two
 *     WMVs in a release the cover pipeline never curated.
 *  2. Otherwise the first page of a paginated set — קומיקס's 39 pages, כתבות's 25.
 *
 * And nothing else. "The first image of anything" was considered and is wrong: the fan discs'
 * first scan is 86.jpg or 1.JPG, an arbitrary frame out of a folder of them, and a random
 * scanned page presented as the face of a release looks like a mistake rather than a choice.
 * A release matching neither rule keeps the placeholder, which is a designed state.
 *
 * Only derivatives that already exist are named. A release whose stand-in was never rendered
 * gets the placeholder too, because a path to a file the sync has not written is a broken
 * image, and this must not be the thing that makes a sync mandatory.
 */
export function releaseStandInCover(items: readonly CatalogItem[]): StandInCover | null {
  const source = items.find((item) => item.kind === 'cover') ?? firstPage(items);
  if (source === undefined) return null;

  const thumb = source.derivatives?.thumb;
  const view = source.derivatives?.view;
  /* `view` and not `reader`: the reader tier is 1700px and 1.2MB for the comic, which is a
     page someone chose to open, not a thumbnail on a grid of 42 of them. */
  const widest = view ?? thumb;
  if (widest?.width === undefined || widest.height === undefined) return null;

  const renditions =
    thumb?.width !== undefined && view?.width !== undefined
      ? [
          { path: thumb.path, width: thumb.width },
          { path: view.path, width: view.width },
        ]
      : [];

  return { path: widest.path, width: widest.width, height: widest.height, renditions };
}

/**
 * Numeric on the path, not on the name: 001.jpg has to sort before 2.jpg and 10 001.jpg, and
 * the folder above a page is the physical object it was scanned from, so a release filed
 * across several folders opens on the first page of the first object rather than on whichever
 * page happened to be first in `itemIds`. Catalog order is not an answer here — rebuilding
 * the catalog reorders itemIds, and a cover that changes on an unrelated sync is not a cover.
 */
function firstPage(items: readonly CatalogItem[]): CatalogItem | undefined {
  return items
    .filter((item) => PAGINATED_KINDS.includes(item.kind))
    .sort((left, right) => left.path.localeCompare(right.path, 'he', { numeric: true }))[0];
}

/**
 * Advance widths of Suez One, in thousandths of an em, measured from the two woff2 files this
 * site actually serves (public/fonts/suez-one-{hebrew,latin}.woff2, unitsPerEm 1000) by
 * reading their hmtx and cmap tables.
 *
 * A table rather than one average advance, because an average is what broke this the first
 * time: ש is 0.690em and י is 0.296em, so "דמואים" and "יייייי" are the same six characters
 * and 2.3 times apart in width, and a label sized off the mean sliced the wide one in half.
 * A single conservative upper bound is no better in the other direction — the widest glyph in
 * the face is W at 1.092em, and sizing every title as though it were made of W's put the two
 * Latin titles in the catalog under 15px.
 *
 * A character that is not listed falls back to that widest glyph, so an unlisted character can
 * only ever make the label smaller than it needed to be, never wider than the mat.
 */
const SUEZ_ADVANCES =
  'א614 ב516 ג365 ד527 ה614 ו324 ז378 ח612 ט577 י296 כ504 ך484 ל469 מ601 ם641 נ358 ן335 ס593 ' +
  "ע543 פ546 ף532 צ542 ץ518 ק576 ר494 ש690 ת627 ׳270 ״466 '243 \"454 0655 1392 2433 3473 4595 " +
  '5502 6564 7499 8591 9564 A712 B648 C643 D735 E623 F608 G676 H765 I388 J378 K703 L584 M952 ' +
  'N748 O722 P647 Q740 R674 S571 T699 U753 V723 W1092 X700 Y673 Z625 a554 b565 c504 d589 e521 ' +
  'f405 g572 h660 i347 j286 k619 l342 m964 n660 o553 p583 q575 r426 s461 t416 u612 v533 w812 ' +
  'x580 y537 z512 -472 _490 .303 ,274 (324 )324 [320 ]319 \\307 /307 &797 +613 !330 ?377 :344 ' +
  ';277 #622 @877 %637 *466 =611';

/** Space is the one advance the table above cannot hold, because it is the separator. */
const SPACE_ADVANCE = 0.206;
/** W, the widest glyph in the face, and the fallback for anything unlisted. */
const WIDEST_ADVANCE = 1.098;
/** Must match `.release-placeholder strong`'s letter-spacing, which adds to every advance. */
const SCRAWL_TRACKING = 0.05;

const ADVANCE_BY_CHARACTER = new Map(
  SUEZ_ADVANCES.split(' ').map((entry) => [entry[0]!, Number(entry.slice(1)) / 1000] as const),
);

/** Width of a string at font-size 1, in em, tracking included. */
function scrawlWidth(value: string): number {
  return [...value].reduce((total, character) => {
    const advance =
      character === ' '
        ? SPACE_ADVANCE
        : (ADVANCE_BY_CHARACTER.get(character) ?? WIDEST_ADVANCE);

    return total + advance + SCRAWL_TRACKING;
  }, 0);
}

/**
 * How large a title is scrawled on a coverless mat, as a percentage of the mat's own width —
 * a `cqi` number, which is why it is unitless here.
 *
 * A marker label is written to fill the disc, so its size is a function of how much there is
 * to write, not of the tile. Two things decide it, and the smaller wins.
 *
 * THE WORD. Hebrew has no hyphenation convention, so a word broken across two lines does not
 * read as a line break — it reads as a rendering fault, which is the exact failure the empty
 * mat was replacing. The longest WORD is therefore the binding constraint, not the length of
 * the title: דמואים is six characters and still needs 3.30em of line to itself. The label's
 * line is 88% of the mat (`max-inline-size`), so a word of w em fits when f/W ≤ 0.88/w. The
 * 84 below is that 0.88 with four points held back for kerning and sub-pixel rounding, which
 * a sum of advances does not model. Words are split on whitespace only: a browser may find a
 * further break opportunity inside one — after a hyphen, around a slash — and every one it
 * finds makes the run shorter than this assumed, never longer.
 *
 * THE AREA. Constant ink area is what a hand does when a title has room to spare. A title e em
 * wide at size f, wrapped into lines of L, covers 1.3·e·f² (1.3 being the line-height); the
 * 3:4 mat's area is 1.333·W²; letting the ink take 42% of it — the rest is the frame's margin
 * and the slack of a ragged last line — gives f/W = √(0.42 · 1.333 / (1.3 · e)).
 *
 * The ceiling of 34% stops a three-letter title becoming a monogram. The floor of 6% is where
 * this stops being able to help: it is reached only by a single unbroken word of more than
 * about 21 Hebrew characters, which no title in the catalog approaches — the longest word is
 * שאלונים\משחקונים at 16, which lands at 9.8%. Below the floor the label stops shrinking and
 * `overflow-wrap: break-word` finally breaks the word, because a run that cannot fit the mat
 * at a readable size has to go somewhere, and 12px of unbroken text is not a readable size.
 */
export function scrawlSize(titleHe: string): number {
  const text = titleHe.trim();
  if (text.length === 0) return 34;

  const longestWord = text
    .split(/\s+/u)
    .reduce((widest, word) => Math.max(widest, scrawlWidth(word)), 0);
  const byWord = 84 / longestWord;
  const byArea = Math.sqrt((0.42 * 1.333) / (1.3 * scrawlWidth(text))) * 100;

  return Math.min(34, Math.max(6, Math.round(Math.min(byWord, byArea) * 10) / 10));
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
