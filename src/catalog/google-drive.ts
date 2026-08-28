import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { DriveGateway, RemoteEntry } from './drive-gateway';

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const FILE_FIELDS =
  'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,thumbnailLink,videoMediaMetadata(durationMillis))';
export const MAX_DRIVE_DOWNLOAD_BYTES = 32 * 1024 * 1024;

// googleapis declares files.get with six overloads. Expand them so this adapter's
// option type stays tied to the generated API instead of accepting Axios-only fields.
type OverloadArguments<T> = T extends {
  (...args: infer A1): unknown;
  (...args: infer A2): unknown;
  (...args: infer A3): unknown;
  (...args: infer A4): unknown;
  (...args: infer A5): unknown;
  (...args: infer A6): unknown;
}
  ? A1 | A2 | A3 | A4 | A5 | A6
  : never;
type SecondArgument<T> = T extends [unknown, infer Second, ...unknown[]] ? Second : never;
export type DriveGetOptions = Exclude<
  SecondArgument<OverloadArguments<drive_v3.Resource$Files['get']>>,
  (...args: never[]) => unknown
>;

const DOWNLOAD_OPTIONS = {
  responseType: 'arraybuffer',
  maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES,
} satisfies DriveGetOptions;

export interface DriveFilesClient {
  list(params: DriveListRequest): Promise<{
    data: { files?: unknown[] | null; nextPageToken?: string | null };
  }>;
  get(params: DriveMediaRequest, options: DriveGetOptions): Promise<{ data: unknown }>;
  export(params: DriveExportRequest, options: DriveGetOptions): Promise<{ data: unknown }>;
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

/** files.export takes no shared-drive flag: the export is rendered, not fetched. */
interface DriveExportRequest {
  fileId: string;
  mimeType: string;
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
      try {
        const response = await files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          DOWNLOAD_OPTIONS,
        );
        const buffer = toDownloadBuffer(response.data);

        if (buffer.byteLength > MAX_DRIVE_DOWNLOAD_BYTES) {
          throw new Error('response too large');
        }

        return buffer;
      } catch {
        throw new Error('Drive file download failed');
      }
    },

    async exportFile(fileId, mimeType) {
      try {
        const response = await files.export({ fileId, mimeType }, DOWNLOAD_OPTIONS);
        const buffer = toExportBuffer(response.data);

        if (buffer.byteLength > MAX_DRIVE_DOWNLOAD_BYTES) {
          throw new Error('response too large');
        }

        return buffer;
      } catch {
        throw new Error('Drive file export failed');
      }
    },
  };
}

/**
 * An export of a text format arrives already decoded as a string, unlike a media
 * download, which is always binary. Both shapes are accepted so the caller gets bytes
 * either way and never has to guess which one the transport chose.
 */
function toExportBuffer(value: unknown): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return toDownloadBuffer(value);
}

function toDownloadBuffer(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error('malformed response');
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
    webViewLink: optionalString(file.webViewLink),
    webContentLink: optionalString(file.webContentLink),
    thumbnailLink: optionalString(file.thumbnailLink),
    durationMillis: optionalString(
      isRecord(file.videoMediaMetadata) ? file.videoMediaMetadata.durationMillis : undefined,
    ),
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

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
