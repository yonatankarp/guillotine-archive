import type { DriveFile } from './types';

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface RemoteEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
  webContentLink?: string | null;
  thumbnailLink?: string | null;
  durationMillis?: string | null;
}

export interface DriveGateway {
  listChildren(folderId: string): Promise<RemoteEntry[]>;
  download(fileId: string): Promise<Buffer>;
}

interface FolderToScan {
  id: string;
  path: string;
}

export async function scanDrive(rootId: string, gateway: DriveGateway): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const folders: FolderToScan[] = [{ id: rootId, path: '' }];
  const visitedFolderIds = new Set([rootId]);
  const filePaths = new Map<string, string>();

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];
    if (!folder) continue;

    for (const entry of await gateway.listChildren(folder.id)) {
      const path = folder.path ? `${folder.path}/${entry.name}` : entry.name;

      if (entry.mimeType === DRIVE_FOLDER_MIME) {
        if (visitedFolderIds.has(entry.id)) continue;

        visitedFolderIds.add(entry.id);
        folders.push({ id: entry.id, path });
        continue;
      }

      if (filePaths.has(entry.id)) {
        const firstPath = filePaths.get(entry.id)!;
        throw new Error(
          `duplicate file ID ${entry.id} encountered at ${firstPath} and ${path}`,
        );
      }
      filePaths.set(entry.id, path);

      files.push({
        id: entry.id,
        name: entry.name,
        mimeType: entry.mimeType,
        size: toSize(entry.size),
        modifiedTime: entry.modifiedTime ?? null,
        path,
        viewUrl: entry.webViewLink ?? `https://drive.google.com/file/d/${entry.id}/view`,
        downloadUrl: getDownloadUrl(entry),
        ...(entry.thumbnailLink ? { thumbnailUrl: entry.thumbnailLink } : {}),
        ...(toDuration(entry.durationMillis) === null
          ? {}
          : { durationMillis: toDuration(entry.durationMillis) }),
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path, 'he'));
}

function getDownloadUrl(entry: RemoteEntry): string | null {
  if (entry.mimeType.startsWith('application/vnd.google-apps.')) return null;
  if (entry.webContentLink) return entry.webContentLink;

  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(entry.id)}`;
}

function toDuration(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function toSize(size: string | null | undefined): number | null {
  if (size === null || size === undefined) return null;

  const value = Number(size);
  return Number.isFinite(value) ? value : null;
}
