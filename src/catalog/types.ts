export type RelationshipKind = 'part-of-release' | 'about' | 'inspired-by';

export type RuleMatch = 'path-prefix' | 'exact-path' | 'file-id';

/** What a file *is*, derived from its bytes and its shelf. Machine enum, never displayed raw. */
export type ItemKind =
  | 'video'
  | 'track'
  | 'sound'
  | 'booklet-page'
  | 'press-page'
  | 'comic-page'
  | 'cover'
  | 'sprite'
  | 'scan'
  | 'build'
  | 'document'
  | 'game-data'
  | 'noise'
  | 'other';

export type ReleaseType =
  | 'game'
  | 'demo'
  | 'fan-disc'
  | 'audio-cd'
  | 'video'
  | 'press'
  | 'fan-game'
  | 'other';

/** Rectangle measured against the 720x960-fitted cover frame. */
export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Derivative {
  path: string;
  bytes: number;
  width?: number;
  height?: number;
}

/**
 * Generated renditions. Every field is optional because the committed catalog
 * predates the derivative pipeline and the site must render without any of them.
 */
export interface ItemDerivatives {
  thumb?: Derivative;
  view?: Derivative;
  reader?: Derivative;
  audio?: Derivative;
  poster?: Derivative;
  durationMillis?: number;
}

/** Per-container curator override. Always wins over inference. */
export interface ReleaseOverride {
  paths: string[];
  slug?: string;
  titleHe?: string;
  type?: ReleaseType;
  subjectSlug?: string | null;
  year?: number;
  formatHe?: string;
  coverFileId?: string;
  logoFileId?: string;
  accent?: string;
}

/**
 * The real unit of the archive: one CD-ROM, installed game, tape or press run.
 * A release may span several source containers when it shipped on several discs.
 */
export interface Release {
  slug: string;
  titleHe: string;
  type: ReleaseType;
  subjectSlug: string | null;
  year?: number;
  formatHe?: string;
  itemIds: string[];
  coverFileId?: string;
  logoFileId?: string;
  accent?: string;
  sourcePaths: string[];
}

export interface ReleaseFacets {
  types: ReleaseType[];
  subjectSlugs: string[];
  years: number[];
}

export interface CuratorRule {
  match: RuleMatch;
  value: string;
  relationship: RelationshipKind;
  groupHe?: string;
}

export interface CuratedCollection {
  slug: string;
  titleHe: string;
  type: 'game' | 'music' | 'press' | 'fan' | 'archive';
  year?: number;
  summaryHe: string;
  descriptionHe?: string;
  coverFileId?: string;
  coverCrop?: CropRegion;
  logoCrop?: CropRegion;
  aliasesHe: string[];
  tagsHe: string[];
  rules: CuratorRule[];
  exclude: CuratorRule[];
}

export interface CuratedFileMetadata {
  titleHe?: string;
  descriptionHe?: string;
  aliasesHe?: string[];
  tagsHe?: string[];
}

export interface CuratorConfig {
  minimumFileCount?: number;
  files?: Record<string, CuratedFileMetadata>;
  collections: CuratedCollection[];
  releases?: ReleaseOverride[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  path: string;
  viewUrl: string;
  downloadUrl: string | null;
  /** Drive-hosted thumbnail, which spares a poster the 6.4 GB of video bytes. */
  thumbnailUrl?: string | null;
  durationMillis?: number | null;
}

export interface CollectionLink {
  slug: string;
  titleHe: string;
  relationship: RelationshipKind;
  groupHe?: string;
}

export interface CatalogItem extends DriveFile {
  category: string;
  kind: ItemKind;
  releaseSlug: string;
  titleHe?: string;
  descriptionHe?: string;
  aliasesHe: string[];
  tagsHe: string[];
  extractedTextHe?: string;
  derivatives?: ItemDerivatives;
  collectionLinks: CollectionLink[];
}

export interface CatalogCollection extends CuratedCollection {
  coverUrl: string | null;
  logoUrl?: string | null;
  itemIds: string[];
}

export interface Catalog {
  generatedAt: string;
  collections: CatalogCollection[];
  items: CatalogItem[];
  categories: string[];
  releases: Release[];
  releaseFacets: ReleaseFacets;
}
