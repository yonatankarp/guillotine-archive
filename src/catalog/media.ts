import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { htmlToText } from 'html-to-text';
import mammoth from 'mammoth';
import sharp, { type Sharp } from 'sharp';
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

export const COVER_WIDTH = 720;
const COVER_HEIGHT = 960;
const COVER_QUALITY = 82;

/**
 * Extra, narrower renditions of the same cover, for `srcset`.
 *
 * 720 is roughly double what a tile ever gets: the widest box `.release-grid` produces is the
 * two-column step, 370 CSS px, and above it the columns only get narrower. The six covers on
 * the front page and /games/ are 653,216 bytes at 720 and 268,792 at 480, so the second tier
 * is 59% off the only images either page loads.
 *
 * 480 and no lower, because a candidate narrower than the box it lands in would be enlarged by
 * the browser instead of the pipeline, and enlarging a cover is the thing this file refuses to
 * do everywhere else. 480 clears 370 with room for the gap arithmetic to move.
 */
const COVER_NARROW_WIDTHS: readonly number[] = [480];

export interface CoverRenditions {
  /** What `src` names. Up to COVER_WIDTH wide, and — without a crop — never enlarged to it. */
  base: Buffer;
  /**
   * Narrower renditions keyed by their exact rendered width, which is also the `w` descriptor
   * and the filename suffix. Empty whenever `base` did not reach COVER_WIDTH.
   */
  narrower: ReadonlyMap<number, Buffer>;
}
const LOGO_QUALITY = 90;

/**
 * What separates these from product artwork is haze, and haze is a lifted black point. The
 * darkest half percent of חלום שהתגשם measures 38 and of ווג׳ימון 37 on a 0-255 luminance
 * scale, so neither reaches black anywhere and both read grey. פיפוש measures 11 and needs
 * nothing. The pull is therefore MEASURED per cover rather than fixed: a cover that already
 * reaches black computes a gain of 1.0 and passes through untouched, which is what makes the
 * step safe to apply to every cover instead of to a hand-picked list.
 *
 * Half a percent is the whole conservatism argument. It is by construction the most pixels
 * this can clip, which is what the warning about normalise() on artwork with a dark border
 * is about; the gain cap bounds a pathological source on top of that.
 */
const BLACK_POINT_TARGET = 4;
const BLACK_POINT_PERCENTILE = 0.005;
const BLACK_POINT_MAX_GAIN = 1.25;

/**
 * The resize had no sharpening pass after it, which is what left the line art soft. m1: 0 is
 * the load-bearing setting: it sharpens edges and leaves flat areas alone, so the dust specks
 * and scan grain in the darker boxes are not amplified along with the lettering. sigma is in
 * OUTPUT pixels because this runs after the resize, so it does not have to be retuned for how
 * far a given original was scaled down. Measured against the committed 1600px renditions,
 * sigma 1.0 put a visible dark overshoot inside the yellow lettering of בתככי הרייטינג and
 * 0.4 was indistinguishable from no pass at all.
 */
const COVER_SHARPEN = { sigma: 0.7, m1: 0, m2: 2 } as const;

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
 * The frame every hand-measured rectangle was taken in. Crop numbers are read off a
 * 720x960-fitted view, not off the Drive original, which runs to 20 MiB and several thousand
 * pixels; a rectangle applied straight to the original lands in a corner of the source
 * instead of on the front panel.
 *
 * Only the logo path extracts out of this frame. A cover measures against it and then
 * extracts out of the original, which is the difference between the two crops below.
 */
async function fittedCoverFrame(data: Buffer): Promise<Buffer> {
  return sharp(data)
    .rotate()
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

/** Size after .rotate() has applied EXIF orientation, which is the space every crop below is in. */
async function orientedSize(data: Buffer): Promise<{ width: number; height: number }> {
  const { autoOrient, width = 0, height = 0 } = await sharp(data).metadata();
  return { width: autoOrient?.width ?? width, height: autoOrient?.height ?? height };
}

/** What `fit: 'inside'` with `withoutEnlargement` resolves to, without decoding the source. */
function fittedCoverSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(COVER_WIDTH / width, COVER_HEIGHT / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * The same rectangle in full-resolution source pixels. Clamped rather than rounded freely: a
 * rectangle flush against the edge of the fitted frame has to stay inside the source, and one
 * pixel over is a decoder error rather than a slightly wrong crop.
 */
export function cropInSource(
  crop: CropRegion,
  fitted: { width: number; height: number },
  source: { width: number; height: number },
): CropRegion {
  const horizontal = source.width / fitted.width;
  const vertical = source.height / fitted.height;
  const left = Math.round(crop.left * horizontal);
  const top = Math.round(crop.top * vertical);

  return {
    left,
    top,
    width: Math.min(Math.round(crop.width * horizontal), source.width - left),
    height: Math.min(Math.round(crop.height * vertical), source.height - top),
  };
}

/**
 * The frame is always 720x960, so the page can reserve that shape for every cover.
 *
 * The curated rectangle is MEASURED against the fitted frame and then EXTRACTED from the
 * original: the two are different jobs and doing both in the fitted frame is what made the
 * covers soft. ווג׳ימון is half of a 1600px-wide box wrap, so its front panel is 359 fitted
 * pixels and around 800 real ones — cropping the fitted thumbnail threw the rest away and
 * then enlarged 2x to fill the frame, which adds no detail and blurs what was there.
 */
export async function optimizeCover(data: Buffer, crop?: CropRegion): Promise<Buffer> {
  return renderCover(data, COVER_WIDTH, COVER_HEIGHT, crop);
}

/**
 * The frame is a parameter only so a second, narrower rendition can be cut from the same
 * source. The rectangle is still measured against 720x960 — `fittedCoverSize` is deliberately
 * fixed to that frame, because that is the space every hand-measured crop was read in and a
 * rectangle re-measured against 480x640 would land somewhere else on the artwork.
 */
async function renderCover(
  data: Buffer,
  width: number,
  height: number,
  crop?: CropRegion,
): Promise<Buffer> {
  if (!crop) {
    return finishCover(
      sharp(data).rotate().resize(width, height, { fit: 'inside', withoutEnlargement: true }),
    );
  }

  const source = await orientedSize(data);
  const fitted = fittedCoverSize(source.width, source.height);
  assertCropWithin(crop, fitted.width, fitted.height);

  return finishCover(
    sharp(data)
      .rotate()
      .extract(cropInSource(crop, fitted, source))
      /*
       * 'inside', not 'cover'. The rectangle above IS the front panel, so a further crop here
       * cuts artwork — and it did: פיפוש 2's scan is a near-square 1600x1580 front with no
       * wrap, and squaring it to 3:4 sliced the פיפוש lettering off both sides. A cover matted
       * in its frame is right; a cover with its title cut off is not.
       */
      .resize(width, height, { fit: 'inside', withoutEnlargement: false }),
  );
}

/**
 * Every rendition of one cover: the 720 that ships today, plus the narrower tiers.
 *
 * A tier is emitted only when `base` actually reached COVER_WIDTH, which is the whole
 * no-upscale rule in one condition. פיפוש המהפכה's only surviving art is 118x158, so its base
 * is 118 wide, a 480 tier would be a 4x smear of it, and it gets none — the tier is SKIPPED,
 * never invented. A base that reached 720 is 3:4 or wider by construction, so fitting the same
 * source into 480x640 is width-bound and lands on exactly 480; that is what lets the filename
 * carry the `w` descriptor. The width is re-measured anyway, and a rendition that missed its
 * tier is dropped rather than described wrongly, because a wrong descriptor is worse for the
 * browser's choice than no candidate at all.
 */
export async function optimizeCoverVariants(
  data: Buffer,
  crop?: CropRegion,
): Promise<CoverRenditions> {
  const base = await optimizeCover(data, crop);
  const narrower = new Map<number, Buffer>();
  const { width: baseWidth } = await sharp(base).metadata();
  if (baseWidth !== COVER_WIDTH) return { base, narrower };

  for (const tier of COVER_NARROW_WIDTHS) {
    const rendition = await renderCover(
      data,
      tier,
      Math.round((tier * COVER_HEIGHT) / COVER_WIDTH),
      crop,
    );
    const { width } = await sharp(rendition).metadata();
    if (width === tier) narrower.set(tier, rendition);
  }

  return { base, narrower };
}

/**
 * Luminance below which `fraction` of the frame sits. Greyscale and palette sources decode to
 * one or two bands, where band 0 already IS the luminance and the Rec. 709 weights would read
 * across into the next pixel.
 */
export function luminancePercentile(
  pixels: Buffer | Uint8Array,
  width: number,
  height: number,
  channels: number,
  fraction: number,
): number {
  const histogram = new Uint32Array(256);
  const colour = channels >= 3;
  for (let pixel = 0, offset = 0; pixel < width * height; pixel += 1, offset += channels) {
    const level = colour
      ? Math.round(
          0.2126 * pixels[offset]! + 0.7152 * pixels[offset + 1]! + 0.0722 * pixels[offset + 2]!,
        )
      : pixels[offset]!;
    histogram[level] = histogram[level]! + 1;
  }

  const wanted = width * height * fraction;
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level]!;
    if (seen >= wanted) return level;
  }

  return 255;
}

/**
 * The gain that lands `darkest` on BLACK_POINT_TARGET. Returns exactly 1 for a cover that
 * already reaches black, so the tone pass is a no-op there rather than a filter applied for
 * its own sake.
 */
export function coverBlackPointGain(darkest: number): number {
  if (darkest <= BLACK_POINT_TARGET) return 1;
  return Math.min((255 - BLACK_POINT_TARGET) / (255 - darkest), BLACK_POINT_MAX_GAIN);
}

/**
 * Tone and acutance, applied to what the resize produced rather than to the source, so the
 * black point is measured on exactly the pixels that ship and the sharpen radius is in output
 * pixels rather than in however many source pixels this particular original happened to have.
 *
 * The offset holds the white point still: 255 * gain + 255 * (1 - gain) is 255 for any gain,
 * so the pass can only deepen shadows and can never blow out the lettering or the highlights.
 * `linear` leaves an alpha band alone, so an RGBA source keeps its transparency intact.
 */
async function finishCover(resized: Sharp): Promise<Buffer> {
  const { data, info } = await resized
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const darkest = luminancePercentile(
    data,
    info.width,
    info.height,
    info.channels,
    BLACK_POINT_PERCENTILE,
  );
  const gain = coverBlackPointGain(darkest);

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .linear(gain, 255 * (1 - gain))
    .sharpen(COVER_SHARPEN)
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

/**
 * `-bitexact` is here for git, not for the listener.
 *
 * Ogg stamps every stream with a random serial number, and the page CRCs follow it, so two
 * encodes of the same source differ in about 40 bytes out of 23,000 while decoding to the
 * identical MD5. Opus is already compressed, so git stores each of those as a fresh full
 * blob and delta compression recovers nothing: the 2026-08-28 sync rewrote 1,233 unchanged
 * audio derivatives and put 279MB into history for no change a visitor could hear.
 *
 * `-bitexact` fixes the serial and drops the encoder version string from OpusTags, so an
 * unchanged source re-encodes to the same bytes and git sees no modification at all. Verified
 * both ways: byte-identical output across runs, and an unchanged decoded MD5.
 *
 * The video path does not need this — MP4 output is already reproducible here.
 */
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
      '-bitexact',
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
