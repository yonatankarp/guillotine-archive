import type { DriveFile, ItemKind } from './types';

export type KindSource = Pick<DriveFile, 'mimeType' | 'path' | 'size' | 'name'>;

const BUILD_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-dosexec',
  'application/x-msdos-program',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar',
  'application/x-iso9660-image',
  'application/x-cab',
  'application/x-123',
]);

const DOCUMENT_MIME_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
]);

const TRACK_MIME_TYPES = new Set(['audio/mp3', 'audio/mpeg', 'audio/x-ms-wma']);

const SPRITE_MIME_TYPES = new Set(['image/pcx', 'image/x-icon', 'image/gif', 'image/x-raw']);

/** Extensions whose payload is the engine's own data, whatever the sniffed mime says. */
const GAME_DATA_EXTENSIONS = new Set([
  'mdl',
  'wdl',
  'wmb',
  'mdf',
  'wdf',
  'hmp',
  'sav',
  'cxt',
  'cst',
  'bin',
  'dat',
]);

/** Extensions that only ever hold small per-machine configuration. */
const CONFIGURATION_EXTENSIONS = new Set(['inf', 'dat', 'ini', 'cfg']);

/** Extensions that are filesystem droppings rather than archive content. */
const DROPPING_EXTENSIONS = new Set(['db', 'tmp']);

const SONGS_CATEGORY = 'שירים';
const AUDIO_DISC_SEGMENTS = ['דיסקים מלאים', 'דיסק אודיו'];
const NUMBERED_TRACK = /^\d+\s*Track/iu;

const CONFIGURATION_SIZE_LIMIT = 4096;
const SPRITE_BITMAP_SIZE_LIMIT = 64_000;

function extensionOf(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator > 0 ? name.slice(separator + 1).toLowerCase() : '';
}

function topCategoryOf(path: string): string {
  return path.split('/').filter((segment) => segment.length > 0)[0] ?? '';
}

function audioKind(file: KindSource, mimeType: string): ItemKind {
  const isRelease =
    topCategoryOf(file.path) === SONGS_CATEGORY ||
    AUDIO_DISC_SEGMENTS.some((segment) => file.path.includes(segment)) ||
    NUMBERED_TRACK.test(file.name) ||
    TRACK_MIME_TYPES.has(mimeType);

  return isRelease ? 'track' : 'sound';
}

function imageKind(file: KindSource, mimeType: string): ItemKind {
  if (file.path.includes('חוברת')) return 'booklet-page';
  if (file.path.includes('עיתונות/כתבות')) return 'press-page';
  if (file.path.includes('עיתונות/קומיקס')) return 'comic-page';
  if (file.path.includes('עטיפה') || file.path.includes('אריזה')) return 'cover';
  if (SPRITE_MIME_TYPES.has(mimeType)) return 'sprite';

  // Only the palette formats of the era were used for sprites; a small JPEG is
  // still a photograph, so size alone must not demote it.
  return mimeType === 'image/bmp' && (file.size ?? Number.POSITIVE_INFINITY) < SPRITE_BITMAP_SIZE_LIMIT
    ? 'sprite'
    : 'scan';
}

export function deriveKind(file: KindSource): ItemKind {
  const mimeType = file.mimeType.toLowerCase();
  const extension = extensionOf(file.name);
  const size = file.size ?? 0;

  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return audioKind(file, mimeType);
  if (mimeType.startsWith('image/')) return imageKind(file, mimeType);
  if (BUILD_MIME_TYPES.has(mimeType)) return 'build';
  if (mimeType.startsWith('text/') || DOCUMENT_MIME_TYPES.has(mimeType)) return 'document';
  if (DROPPING_EXTENSIONS.has(extension)) return 'noise';
  if (size < CONFIGURATION_SIZE_LIMIT && CONFIGURATION_EXTENSIONS.has(extension)) return 'noise';

  // A .DXR is Director content the projector loads, not a build a visitor can run.
  return mimeType === 'application/x-director' || GAME_DATA_EXTENSIONS.has(extension)
    ? 'game-data'
    : 'other';
}
