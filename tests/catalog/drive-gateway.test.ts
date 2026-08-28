import { describe, expect, test, vi } from 'vitest';
import {
  DRIVE_FOLDER_MIME,
  scanDrive,
  type DriveGateway,
  type RemoteEntry,
} from '../../src/catalog/drive-gateway';
import {
  MAX_DRIVE_DOWNLOAD_BYTES,
  createDriveGatewayFromFilesClient,
  type DriveFilesClient,
} from '../../src/catalog/google-drive';

/** scanDrive never exports: it reads metadata, and the export seam belongs to the build. */
const unusedExport = async (): Promise<Buffer> => {
  throw new Error('export is not part of a scan');
};

describe('scanDrive', () => {
  test('recursively scans files in Hebrew path order', async () => {
    const children: Record<string, RemoteEntry[]> = {
      root: [
        { id: 'games', name: 'משחקים מלאים', mimeType: DRIVE_FOLDER_MIME },
        { id: 'song', name: 'שיר.mp3', mimeType: 'audio/mpeg', size: '20' },
      ],
      games: [{ id: 'piposh', name: 'פיפוש 1', mimeType: DRIVE_FOLDER_MIME }],
      piposh: [
        {
          id: 'exe',
          name: 'piposh1.exe',
          mimeType: 'application/x-msdownload',
          size: '100',
        },
      ],
    };
    const gateway: DriveGateway = {
      async listChildren(folderId) {
        return children[folderId] ?? [];
      },
      async download() {
        return Buffer.alloc(0);
      },
      exportFile: unusedExport,
    };

    const files = await scanDrive('root', gateway);

    expect(files.map((file) => file.path)).toEqual([
      'משחקים מלאים/פיפוש 1/piposh1.exe',
      'שיר.mp3',
    ]);
    expect(files[0]?.viewUrl).toBe('https://drive.google.com/file/d/exe/view');
    expect(files[0]?.downloadUrl).toContain('id=exe');
  });

  test('scans every folder ID only once in a cycle', async () => {
    const calls: string[] = [];
    const gateway: DriveGateway = {
      async listChildren(folderId) {
        calls.push(folderId);
        if (folderId === 'root' && calls.filter((id) => id === 'root').length === 1) {
          return [{ id: 'games', name: 'games', mimeType: DRIVE_FOLDER_MIME }];
        }
        if (folderId === 'games') {
          return [
            { id: 'root', name: 'root again', mimeType: DRIVE_FOLDER_MIME },
            { id: 'game', name: 'game.exe', mimeType: 'application/octet-stream' },
          ];
        }
        return [];
      },
      async download() {
        return Buffer.alloc(0);
      },
      exportFile: unusedExport,
    };

    await expect(scanDrive('root', gateway)).resolves.toHaveLength(1);
    expect(calls).toEqual(['root', 'games']);
  });

  test('rejects a duplicate file ID with both encountered paths', async () => {
    const gateway: DriveGateway = {
      async listChildren(folderId) {
        if (folderId === 'root') {
          return [
            { id: 'one', name: 'one', mimeType: DRIVE_FOLDER_MIME },
            { id: 'two', name: 'two', mimeType: DRIVE_FOLDER_MIME },
          ];
        }
        return [{ id: 'duplicate', name: 'shared.bin', mimeType: 'application/octet-stream' }];
      },
      async download() {
        return Buffer.alloc(0);
      },
      exportFile: unusedExport,
    };

    await expect(scanDrive('root', gateway)).rejects.toThrow(
      'duplicate file ID duplicate encountered at one/shared.bin and two/shared.bin',
    );
  });

  test('rejects a duplicate file ID when its first path is empty', async () => {
    const gateway: DriveGateway = {
      async listChildren() {
        return [
          { id: 'duplicate', name: '', mimeType: 'application/octet-stream' },
          { id: 'duplicate', name: 'second.bin', mimeType: 'application/octet-stream' },
        ];
      },
      async download() {
        return Buffer.alloc(0);
      },
      exportFile: unusedExport,
    };

    await expect(scanDrive('root', gateway)).rejects.toThrow(
      'duplicate file ID duplicate encountered at  and second.bin',
    );
  });

  test('keeps native Drive files and shortcuts view-only while preserving content links', async () => {
    const gateway: DriveGateway = {
      async listChildren() {
        return [
          {
            id: 'linked',
            name: 'linked.zip',
            mimeType: 'application/zip',
            webContentLink: 'https://example.test/linked.zip',
          },
          {
            id: 'doc',
            name: 'document',
            mimeType: 'application/vnd.google-apps.document',
            webViewLink: 'https://example.test/document',
            webContentLink: 'https://example.test/document-download',
          },
          {
            id: 'shortcut',
            name: 'shortcut',
            mimeType: 'application/vnd.google-apps.shortcut',
            webContentLink: 'https://example.test/shortcut-download',
          },
        ];
      },
      async download() {
        return Buffer.alloc(0);
      },
      exportFile: unusedExport,
    };

    const files = await scanDrive('root', gateway);

    expect(files.find((file) => file.id === 'linked')?.downloadUrl).toBe(
      'https://example.test/linked.zip',
    );
    expect(files.find((file) => file.id === 'doc')).toMatchObject({
      viewUrl: 'https://example.test/document',
      downloadUrl: null,
    });
    expect(files.find((file) => file.id === 'shortcut')?.downloadUrl).toBeNull();
  });
});

describe('createDriveGatewayFromFilesClient', () => {
  test('paginates with escaped parent IDs and shared-drive listing options', async () => {
    const list = vi
      .fn<DriveFilesClient['list']>()
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'first', name: 'first.bin', mimeType: 'application/octet-stream' }],
          nextPageToken: 'second-page',
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'second', name: 'second.bin', mimeType: 'application/octet-stream' }],
        },
      });
    const gateway = createDriveGatewayFromFilesClient({
      list,
      get: vi.fn(),
      export: vi.fn(),
    });

    await expect(gateway.listChildren("a\\b'c")).resolves.toMatchObject([
      { id: 'first' },
      { id: 'second' },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      q: "'a\\\\b\\'c' in parents and trashed = false",
      fields:
        'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,webContentLink,thumbnailLink,videoMediaMetadata(durationMillis))',
      orderBy: 'folder,name',
      pageSize: 1000,
      pageToken: undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pageToken: 'second-page' }));
  });

  test('fails fast when a Drive response record is malformed', async () => {
    const gateway = createDriveGatewayFromFilesClient({
      list: vi.fn().mockResolvedValue({ data: { files: [{ id: 'only-id', name: 'missing type' }] } }),
      get: vi.fn(),
      export: vi.fn(),
    });

    await expect(gateway.listChildren('root')).rejects.toThrow(
      'malformed Drive file record missing mimeType',
    );
  });

  test('downloads binary data with media and shared-drive options', async () => {
    const bytes = Uint8Array.from([1, 2, 3]).buffer;
    const get = vi.fn<DriveFilesClient['get']>().mockResolvedValue({ data: bytes });
    const gateway = createDriveGatewayFromFilesClient({ list: vi.fn(), get, export: vi.fn() });

    await expect(gateway.download('file-id')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(get).toHaveBeenCalledWith(
      { fileId: 'file-id', alt: 'media', supportsAllDrives: true },
      {
        responseType: 'arraybuffer',
        maxContentLength: MAX_DRIVE_DOWNLOAD_BYTES,
      },
    );
  });

  test('accepts an exact-boundary download and rejects an oversized response generically', async () => {
    const get = vi
      .fn<DriveFilesClient['get']>()
      .mockResolvedValueOnce({ data: new ArrayBuffer(MAX_DRIVE_DOWNLOAD_BYTES) })
      .mockResolvedValueOnce({ data: new ArrayBuffer(MAX_DRIVE_DOWNLOAD_BYTES + 1) });
    const gateway = createDriveGatewayFromFilesClient({ list: vi.fn(), get, export: vi.fn() });

    await expect(gateway.download('at-limit')).resolves.toHaveLength(MAX_DRIVE_DOWNLOAD_BYTES);
    await expect(gateway.download('too-large')).rejects.toThrow('Drive file download failed');
  });

  test('preserves the selected bytes of an ArrayBuffer view', async () => {
    const source = Uint8Array.from([9, 1, 2, 3, 8]);
    const data = new Uint8Array(source.buffer, 1, 3);
    const gateway = createDriveGatewayFromFilesClient({
      list: vi.fn(),
      get: vi.fn<DriveFilesClient['get']>().mockResolvedValue({ data }),
      export: vi.fn(),
    });

    await expect(gateway.download('view')).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  test('replaces transport and malformed-response details with a safe download error', async () => {
    const secret = 'private_key material';
    const get = vi
      .fn<DriveFilesClient['get']>()
      .mockRejectedValueOnce(new Error(secret))
      .mockResolvedValueOnce({ data: 'not binary' });
    const gateway = createDriveGatewayFromFilesClient({ list: vi.fn(), get, export: vi.fn() });

    await expect(gateway.download('transport')).rejects.toThrow(/^Drive file download failed$/);
    await expect(gateway.download('malformed')).rejects.toThrow('Drive file download failed');
  });
});
