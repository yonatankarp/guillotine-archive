import type { CatalogCollection, CatalogItem, CollectionLink } from '../catalog/types';

export interface OfficialItemGroup {
  heading: string;
  items: CatalogItem[];
}

export interface DriveAction {
  kind: 'view' | 'download';
  href: string;
  label: string;
}

type FileWithOptionalActions = Pick<CatalogItem, 'name' | 'downloadUrl'> & {
  viewUrl: string | null;
};

const FALLBACK_OFFICIAL_GROUP = 'חומרים רשמיים';

export function groupOfficialItems(
  collection: CatalogCollection,
  itemById: ReadonlyMap<string, CatalogItem>,
): OfficialItemGroup[] {
  const grouped = new Map<string, CatalogItem[]>();

  for (const itemId of collection.itemIds) {
    const item = itemById.get(itemId);
    const link = item?.collectionLinks.find(
      (candidate) =>
        candidate.slug === collection.slug && candidate.relationship === 'part-of-release',
    );
    if (!item || !link) continue;

    const heading = link.groupHe ?? FALLBACK_OFFICIAL_GROUP;
    const items = grouped.get(heading) ?? [];
    items.push(item);
    grouped.set(heading, items);
  }

  const orderedHeadings = collection.rules
    .filter((rule) => rule.relationship === 'part-of-release')
    .map((rule) => rule.groupHe ?? FALLBACK_OFFICIAL_GROUP);

  const result: OfficialItemGroup[] = [];
  for (const heading of [...orderedHeadings, ...grouped.keys()]) {
    const items = grouped.get(heading);
    if (!items || result.some((group) => group.heading === heading)) continue;
    result.push({ heading, items });
  }

  return result;
}

export function formatFileSize(size: number | null): string {
  if (size === null) return 'גודל לא ידוע';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatFileCount(count: number): string {
  return count === 1 ? 'קובץ אחד' : `${count} קבצים`;
}

export function fileTypeLabel(file: Pick<CatalogItem, 'name' | 'mimeType'>): string {
  const lastDot = file.name.lastIndexOf('.');
  const extension = lastDot > 0 && lastDot < file.name.length - 1
    ? file.name.slice(lastDot + 1).toLocaleUpperCase('en-US')
    : null;

  return extension ? `${extension} · ${file.mimeType}` : file.mimeType;
}

export function driveActions(file: FileWithOptionalActions): DriveAction[] {
  const actions: DriveAction[] = [];
  if (file.viewUrl) {
    actions.push({
      kind: 'view',
      href: file.viewUrl,
      label: `צפייה ב־Drive — ${file.name}`,
    });
  }
  if (file.downloadUrl) {
    actions.push({
      kind: 'download',
      href: file.downloadUrl,
      label: `הורדה — ${file.name}`,
    });
  }
  return actions;
}

export function officialCollectionLinks(
  item: Pick<CatalogItem, 'collectionLinks'>,
): CollectionLink[] {
  const seenSlugs = new Set<string>();
  const links: CollectionLink[] = [];

  for (const link of item.collectionLinks) {
    if (link.relationship !== 'part-of-release' || seenSlugs.has(link.slug)) continue;
    seenSlugs.add(link.slug);
    links.push(link);
  }

  return links;
}
