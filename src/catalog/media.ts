import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { htmlToText } from 'html-to-text';
import mammoth from 'mammoth';
import sharp from 'sharp';
import yauzl from 'yauzl';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SIZE_LIMIT_ERROR = `Text exceeds maximum size of ${MAX_TEXT_BYTES} bytes`;

function hasExtension(name: string, ...extensions: string[]): boolean {
  const lowerName = name.toLowerCase();
  return extensions.some((extension) => lowerName.endsWith(extension));
}

function textSizeLimitError(): Error {
  return new Error(SIZE_LIMIT_ERROR);
}

function assertTextSize(value: string | Buffer): void {
  const size = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
  if (size > MAX_TEXT_BYTES) {
    throw textSizeLimitError();
  }
}

function getHtmlCharset(data: Buffer): string | undefined {
  const header = data.subarray(0, 2048).toString('latin1');
  const metaTags = header.match(/<meta\b[^>]*>/gi) ?? [];

  for (const metaTag of metaTags) {
    const directCharset = getHtmlAttribute(metaTag, 'charset');
    if (directCharset) {
      return supportedCharset(directCharset);
    }

    const httpEquiv = getHtmlAttribute(metaTag, 'http-equiv');
    if (httpEquiv?.toLowerCase() !== 'content-type') {
      continue;
    }

    const content = getHtmlAttribute(metaTag, 'content');
    const contentCharset = /(?:^|;)\s*charset\s*=\s*([^\s"'>/;]+)/i.exec(content ?? '')?.[1];
    if (contentCharset) {
      return supportedCharset(contentCharset);
    }
  }

  return undefined;
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const expression = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = expression.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function supportedCharset(value: string): string | undefined {
  const charset = value.toLowerCase();
  return charset === 'windows-1255' || charset === 'iso-8859-8' ? charset : undefined;
}

/**
 * The archive is late-1990s Israeli material, so a file that is not valid UTF-8
 * is almost certainly Windows-1255 rather than genuinely broken. Decoding it as
 * UTF-8 anyway turns every Hebrew byte into U+FFFD, which is silent and total
 * data loss: the whole corpus reduced to its ASCII digits.
 *
 * A declared HTML charset still wins, and the sniff window stays bounded, so a
 * declaration outside it is handled by the same fallback as no declaration.
 */
const LEGACY_HEBREW_ENCODING = 'windows-1255';

function decodeExactly(data: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function decodeText(data: Buffer, isHtmlInput: boolean): string {
  const charset = isHtmlInput ? getHtmlCharset(data) : undefined;
  if (charset === 'windows-1255' || charset === 'iso-8859-8') {
    return new TextDecoder(charset).decode(data);
  }

  return (
    decodeExactly(data, 'utf-8') ??
    decodeExactly(data, LEGACY_HEBREW_ENCODING) ??
    new TextDecoder('utf-8').decode(data)
  );
}

function isHtml(mimeType: string, name: string): boolean {
  const normalizedMimeType = mimeType.toLowerCase().split(';', 1)[0]?.trim();
  return (
    normalizedMimeType === 'text/html' ||
    normalizedMimeType === 'application/xhtml+xml' ||
    hasExtension(name, '.html', '.htm')
  );
}

function isDocx(mimeType: string, name: string): boolean {
  return (
    mimeType.toLowerCase().split(';', 1)[0]?.trim() === DOCX_MIME_TYPE ||
    hasExtension(name, '.docx')
  );
}

function preflightDocx(data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Unable to read DOCX archive'));
        return;
      }

      let totalUncompressedSize = 0;
      let settled = false;
      let activeStream: Readable | undefined;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          activeStream?.destroy();
          zip.close();
        } catch (cleanupError) {
          reject(cleanupError);
          return;
        }
        callback();
      };
      const fail = (failure: unknown) => finish(() => reject(failure));
      const readNextEntry = () => {
        try {
          zip.readEntry();
        } catch (readError) {
          fail(readError);
        }
      };

      zip.on('entry', (entry) => {
        if (settled) {
          return;
        }

        if (entry.fileName.endsWith('/')) {
          readNextEntry();
          return;
        }

        try {
          zip.openReadStream(entry, (streamError, stream) => {
            if (settled) {
              stream?.destroy();
              return;
            }

            if (streamError || !stream) {
              fail(streamError ?? new Error('Unable to read DOCX entry'));
              return;
            }

            activeStream = stream;
            stream.on('data', (chunk: Buffer) => {
              totalUncompressedSize += chunk.length;
              if (totalUncompressedSize > MAX_TEXT_BYTES) {
                fail(textSizeLimitError());
              }
            });
            stream.on('end', () => {
              if (!settled) {
                activeStream = undefined;
                readNextEntry();
              }
            });
            stream.on('error', fail);
          });
        } catch (streamOpenError) {
          fail(streamOpenError);
        }
      });
      zip.on('end', () => finish(resolve));
      zip.on('error', fail);
      readNextEntry();
    });
  });
}

function trimExtractedText(text: string): string {
  assertTextSize(text);
  return text.trim();
}

export function isTextExtractable(
  mimeType: string,
  name: string,
  size: number | null,
): boolean {
  if (size !== null && size > MAX_TEXT_BYTES) {
    return false;
  }

  return (
    mimeType.toLowerCase().startsWith('text/') ||
    hasExtension(name, '.txt', '.html', '.htm') ||
    isDocx(mimeType, name)
  );
}

export async function extractText(mimeType: string, name: string, data: Buffer): Promise<string> {
  assertTextSize(data);

  if (isDocx(mimeType, name)) {
    await preflightDocx(data);
    const result = await mammoth.extractRawText({ buffer: data });
    return trimExtractedText(result.value);
  }

  const htmlInput = isHtml(mimeType, name);
  const text = decodeText(data, htmlInput);
  if (htmlInput) {
    const extracted = htmlToText(text, {
      wordwrap: false,
      selectors: [{ selector: 'img', format: 'skip' }],
    });
    return trimExtractedText(extracted);
  }

  return trimExtractedText(text);
}

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImageDerivativeTier {
  name: 'thumb' | 'view' | 'reader';
  edge: number;
}

const COVER_WIDTH = 720;
const COVER_HEIGHT = 960;
const COVER_QUALITY = 82;
const LOGO_QUALITY = 90;

export const IMAGE_TIERS: readonly ImageDerivativeTier[] = [
  { name: 'thumb', edge: 400 },
  { name: 'view', edge: 1600 },
];
/** Hebrew magazine body text is illegible below this, so reader pages get a third tier. */
export const READER_TIER: ImageDerivativeTier = { name: 'reader', edge: 2400 };
export const READER_KINDS: readonly string[] = ['booklet-page', 'comic-page', 'press-page'];

/** sharp/libvips decodes none of these; ICO is BMP-encoded internally, so it shares the gap. */
const EXTERNAL_DECODER_MIME_TYPES = new Set([
  'image/pcx',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/x-raw',
]);

export function needsExternalDecoder(mimeType: string): boolean {
  return EXTERNAL_DECODER_MIME_TYPES.has(mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '');
}

export function imageTiersFor(kind: string): ImageDerivativeTier[] {
  return READER_KINDS.includes(kind) ? [...IMAGE_TIERS, READER_TIER] : [...IMAGE_TIERS];
}

function assertCropWithin(crop: CropRegion, width: number, height: number): void {
  const { left, top, width: cropWidth, height: cropHeight } = crop;
  if (
    !Number.isInteger(left) ||
    !Number.isInteger(top) ||
    !Number.isInteger(cropWidth) ||
    !Number.isInteger(cropHeight) ||
    left < 0 ||
    top < 0 ||
    cropWidth <= 0 ||
    cropHeight <= 0
  ) {
    throw new Error('crop region must be nonnegative integers with a positive size');
  }
  if (left + cropWidth > width || top + cropHeight > height) {
    throw new Error(
      `crop region ${cropWidth}x${cropHeight}+${left}+${top} falls outside the ${width}x${height} frame`,
    );
  }
}

/**
 * Crop rectangles are hand-measured against the 720x960-fitted frame, not the
 * Drive original, which runs to 20 MiB and several thousand pixels. Fitting
 * first puts those numbers back in the space they were taken in; skipping it
 * silently crops a corner of the source instead of the front panel.
 */
async function fittedCoverFrame(data: Buffer): Promise<Buffer> {
  return sharp(data)
    .rotate()
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

export async function optimizeCover(data: Buffer, crop?: CropRegion): Promise<Buffer> {
  if (!crop) {
    return sharp(data)
      .rotate()
      .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: COVER_QUALITY })
      .toBuffer();
  }

  const fitted = await fittedCoverFrame(data);
  const { width = 0, height = 0 } = await sharp(fitted).metadata();
  assertCropWithin(crop, width, height);

  return sharp(fitted)
    .extract(crop)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover' })
    .webp({ quality: COVER_QUALITY })
    .toBuffer();
}

/** Release titles are hand-drawn box lettering, so the logo keeps its native crop size. */
export async function optimizeLogo(data: Buffer, crop: CropRegion): Promise<Buffer> {
  const fitted = await fittedCoverFrame(data);
  const { width = 0, height = 0 } = await sharp(fitted).metadata();
  assertCropWithin(crop, width, height);

  return sharp(fitted).extract(crop).webp({ quality: LOGO_QUALITY }).toBuffer();
}

export interface ResizedImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function resizeImage(data: Buffer, edge: number): Promise<ResizedImage> {
  const output = await sharp(data)
    .rotate()
    .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: COVER_QUALITY })
    .toBuffer({ resolveWithObject: true });

  return { data: output.data, width: output.info.width, height: output.info.height };
}

/**
 * External decoders and encoders are resolved to an absolute path once, so a
 * PATH difference between a developer machine and a CI runner cannot silently
 * change which binary runs. An explicit env override wins for pinned runners.
 */
function resolveBinary(names: readonly string[], override: string | undefined): string | null {
  if (override) return existsSync(override) ? override : null;

  const directories = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/bin', '/snap/bin'];
  for (const name of names) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function resolveImageMagick(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveBinary(['magick', 'convert'], env.GUILLOTINE_IMAGEMAGICK_PATH);
}

export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveBinary(['ffmpeg'], env.GUILLOTINE_FFMPEG_PATH);
}

const EXTERNAL_TOOL_TIMEOUT_MS = 120_000;
const MAX_EXTERNAL_OUTPUT_BYTES = 256 * 1024 * 1024;

function runExternalTool(binary: string, args: readonly string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`${binary} timed out`)), EXTERNAL_TOOL_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_EXTERNAL_OUTPUT_BYTES) {
        fail(new Error(`${binary} produced more than ${MAX_EXTERNAL_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    // Draining stderr prevents a chatty tool from blocking on a full pipe.
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${binary} exited with code ${String(code)}`));
        return;
      }
      const data = Buffer.concat(chunks);
      if (data.length === 0) {
        reject(new Error(`${binary} produced no output`));
        return;
      }
      resolve(data);
    });
    child.stdin.on('error', () => {
      // A tool that rejects input before reading it all reports through its exit code.
    });
    child.stdin.end(input);
  });
}

/** Converts a format libvips cannot read into PNG, so every later step is sharp. */
export async function decodeWithImageMagick(data: Buffer, binary: string): Promise<Buffer> {
  return runExternalTool(binary, ['-', 'png:-'], data);
}

export const TRACK_OPUS_BITRATE = '96k';
export const SOUND_OPUS_BITRATE = '64k';

export function opusBitrateFor(kind: string): string {
  return kind === 'track' ? TRACK_OPUS_BITRATE : SOUND_OPUS_BITRATE;
}

export async function transcodeToOpus(
  data: Buffer,
  binary: string,
  bitrate: string,
): Promise<Buffer> {
  return runExternalTool(
    binary,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-map', 'a:0',
      '-c:a', 'libopus',
      '-b:a', bitrate,
      '-vbr', 'on',
      '-application', 'audio',
      '-f', 'ogg',
      'pipe:1',
    ],
    data,
  );
}

/**
 * Video is the one encoder here that goes through real files at both ends, and
 * that is an ffmpeg constraint rather than a preference. `+faststart` is what
 * makes an MP4 stream instead of download: it moves the index in front of the
 * frames so a browser can start playing on the first bytes. Writing it means
 * seeking backwards over the finished file, which ffmpeg refuses on a pipe with
 * "muxer does not support non seekable output". The input is a file for the
 * mirror-image reason: this archive is WMV, AVI and VOB, whose demuxers seek to
 * indexes that are not at the front of the stream.
 */
const VIDEO_TOOL_TIMEOUT_MS = 30 * 60 * 1000;

function spawnVideoTool(binary: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`${binary} timed out`)), VIDEO_TOOL_TIMEOUT_MS);

    // Draining stderr prevents a chatty encoder from blocking on a full pipe.
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`${binary} exited with code ${String(code)}`));
        return;
      }
      resolve();
    });
  });
}

async function encodeVideo(
  data: Buffer,
  binary: string,
  buildArgs: (source: string, target: string) => readonly string[],
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'guillotine-video-'));
  const source = join(directory, 'source');
  const target = join(directory, 'derivative.mp4');

  try {
    await writeFile(source, data);
    await spawnVideoTool(binary, buildArgs(source, target));
    const output = await readFile(target);
    if (output.length === 0) throw new Error(`${binary} produced no output`);
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 854 is 480p at 16:9. The archive is VHS-era television capture and phone
 * clips, so this downscales the phone footage and leaves every genuinely small
 * source at its native size rather than upscaling grain.
 */
export const VIDEO_MAX_DISPLAY_WIDTH = 854;
export const VIDEO_CRF = '26';
export const VIDEO_MAX_BITRATE = '1200k';
export const VIDEO_BUFFER_SIZE = '2400k';
export const VIDEO_AUDIO_BITRATE = '96k';

/**
 * Scaling by `iw*sar` converts to square pixels first. A PAL VOB is 720x576
 * stored with a 16:15 sample ratio, so scaling its raw width would squash the
 * picture; this yields the 768-wide frame the disc actually displays. Both
 * dimensions are forced even because H.264 4:2:0 cannot encode odd ones.
 */
const VIDEO_SCALE_FILTER = `scale=w=trunc(min(${String(VIDEO_MAX_DISPLAY_WIDTH)}\\,iw*sar)/2)*2:h=-2,setsar=1`;

/** An MP4 source needs no re-encode, only an index moved to the front. */
export function isStreamableVideoContainer(mimeType: string): boolean {
  return mimeType.toLowerCase().split(';', 1)[0]?.trim() === 'video/mp4';
}

/**
 * The cheap case: copy the existing streams into a new MP4 with the index at
 * the front. No re-encode, so it costs a file copy rather than minutes of CPU.
 * It trusts the source codecs to be browser-playable, which holds for the
 * phone-recorded MP4s here; a copy of something exotic would still fail the
 * caller's playback expectation rather than the build.
 */
export async function remuxToStreamableMp4(data: Buffer, binary: string): Promise<Buffer> {
  return encodeVideo(data, binary, (source, target) => [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', target,
  ]);
}

/**
 * H.264 Main in MP4, with AAC stereo. WebM would encode smaller, but this has to
 * play on the oldest thing a visitor might bring, and `yuv420p` at Main profile
 * is the combination every browser decodes. It is also not optional: the ancient
 * sources here carry pixel formats such as yuv411p that x264 would otherwise
 * promote to a High 4:4:4 stream no browser will touch. Audio is downmixed to
 * stereo because the VOBs carry multichannel AC-3.
 */
export async function transcodeToMp4(data: Buffer, binary: string): Promise<Buffer> {
  return encodeVideo(data, binary, (source, target) => [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', source,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', VIDEO_SCALE_FILTER,
    '-c:v', 'libx264',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', VIDEO_CRF,
    '-maxrate', VIDEO_MAX_BITRATE,
    '-bufsize', VIDEO_BUFFER_SIZE,
    '-c:a', 'aac',
    '-b:a', VIDEO_AUDIO_BITRATE,
    '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-y', target,
  ]);
}
