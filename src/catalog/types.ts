export type RelationshipKind = 'part-of-release' | 'about' | 'inspired-by';

export type RuleMatch = 'path-prefix' | 'exact-path' | 'file-id';

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
}

export interface CollectionLink {
  slug: string;
  titleHe: string;
  relationship: RelationshipKind;
  groupHe?: string;
}

export interface CatalogItem extends DriveFile {
  category: string;
  titleHe?: string;
  descriptionHe?: string;
  aliasesHe: string[];
  tagsHe: string[];
  extractedTextHe?: string;
  collectionLinks: CollectionLink[];
}

export interface CatalogCollection extends CuratedCollection {
  coverUrl: string | null;
  itemIds: string[];
}

export interface Catalog {
  generatedAt: string;
  collections: CatalogCollection[];
  items: CatalogItem[];
  categories: string[];
}
