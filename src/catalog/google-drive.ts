import { google } from 'googleapis';
import type { DriveGateway, RemoteEntry } from './drive-gateway';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,webViewLink,webContentLink)';

export interface DriveFilesClient {
  list(params: DriveListRequest): Promise<{
    data: { files?: unknown[] | null; nextPageToken?: string | null };
  }>;
  get(params: DriveMediaRequest, options: ArrayBufferOptions): Promise<{ data: unknown }>;
}

interface DriveListRequest {
  q: string;
  fields: string;
  orderBy: string;
  pageSize: number;
  pageToken?: string;
  supportsAllDrives: true;
  includeItemsFromAllDrives: true;
}

interface DriveMediaRequest {
  fileId: string;
  alt: 'media';
  supportsAllDrives: true;
}

interface ArrayBufferOptions {
  responseType: 'arraybuffer';
}

export function createGoogleDriveGateway(credentialsJson: string): DriveGateway {
  const credentials = JSON.parse(credentialsJson) as Record<string, unknown>;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [DRIVE_READONLY_SCOPE],
  });
  const drive = google.drive({ version: 'v3', auth });

  return createDriveGatewayFromFilesClient(drive.files);
}

export function createDriveGatewayFromFilesClient(files: DriveFilesClient): DriveGateway {
  return {
    async listChildren(folderId) {
      const entries: RemoteEntry[] = [];
      let pageToken: string | undefined;

      do {
        const response = await files.list({
          q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
          fields: FILE_FIELDS,
          orderBy: 'folder,name',
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        for (const file of response.data.files ?? []) {
          entries.push(toRemoteEntry(file));
        }

        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);

      return entries;
    },

    async download(fileId) {
      const response = await files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      return Buffer.from(response.data as ArrayBuffer);
    },
  };
}

function toRemoteEntry(file: unknown): RemoteEntry {
  if (!isRecord(file)) throw new Error('malformed Drive file record missing id');

  const id = requiredString(file, 'id');
  const name = requiredString(file, 'name');
  const mimeType = requiredString(file, 'mimeType');

  return {
    id,
    name,
    mimeType,
    size: optionalString(file.size),
    modifiedTime: optionalString(file.modifiedTime),
    parents: optionalStringArray(file.parents),
    webViewLink: optionalString(file.webViewLink),
    webContentLink: optionalString(file.webContentLink),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`malformed Drive file record missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  return typeof value === 'string' || value === null ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  if (value === null || value === undefined) return value;
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
