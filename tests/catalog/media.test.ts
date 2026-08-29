import { Buffer } from 'node:buffer';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const extractRawText = vi.hoisted(() => vi.fn());
const fromBuffer = vi.hoisted(() => vi.fn());
const closeZip = vi.hoisted(() => vi.fn());

vi.mock('mammoth', () => ({
  default: { extractRawText },
}));

vi.mock('yauzl', () => ({
  default: { fromBuffer },
}));

import {
  coverBlackPointGain,
  extractText,
  isTextExtractable,
  optimizeCover,
  optimizeCoverVariants,
  transcodeToOpus,
} from '../../src/catalog/media';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const SIZE_LIMIT_ERROR = `Text exceeds maximum size of ${MAX_TEXT_BYTES} bytes`;

function mockDocxEntries(...sizes: number[]): void {
  fromBuffer.mockImplementation((_data, _options, callback) => {
    const zip = new EventEmitter() as EventEmitter & {
      close: () => void;
      readEntry: () => void;
      openReadStream: (entry: object, callback: (error: Error | null, stream: Readable | null) => void) => void;
    };
    const entrySizes = new Map<object, number>();
    zip.close = closeZip;
    zip.openReadStream = (entry, streamCallback) => {
      streamCallback(null, Readable.from([Buffer.alloc(entrySizes.get(entry) ?? 0)]));
    };
    zip.readEntry = () => {
      const size = sizes.shift();
      queueMicrotask(() => {
        if (size === undefined) {
          zip.emit('end');
        } else {
          const entry = { fileName: 'word/document.xml', uncompressedSize: 0 };
          entrySizes.set(entry, size);
          zip.emit('entry', entry);
        }
      });
    };
    callback(null, zip);
  });
}

function mockDocxReadStreamError(error: Error): void {
  fromBuffer.mockImplementation((_data, _options, callback) => {
    const zip = new EventEmitter() as EventEmitter & {
      close: () => void;
      readEntry: () => void;
      openReadStream: (entry: object, callback: (error: Error, stream: null) => void) => void;
    };
    zip.close = closeZip;
    zip.readEntry = () => queueMicrotask(() => zip.emit('entry', { fileName: 'word/document.xml' }));
    zip.openReadStream = (_entry, streamCallback) => streamCallback(error, null);
    callback(null, zip);
  });
}

function mockDocxReadEntryError(error: Error): void {
  fromBuffer.mockImplementation((_data, _options, callback) => {
    const zip = new EventEmitter() as EventEmitter & {
      close: () => void;
      readEntry: () => void;
      openReadStream: (entry: object, callback: (error: null, stream: Readable) => void) => void;
    };
    let readCount = 0;
    zip.close = closeZip;
    zip.readEntry = () => {
      readCount += 1;
      if (readCount > 1) {
        throw error;
      }
      queueMicrotask(() => zip.emit('entry', { fileName: 'word/document.xml' }));
    };
    zip.openReadStream = (_entry, streamCallback) => streamCallback(null, Readable.from([Buffer.from('ok')]));
    callback(null, zip);
  });
}


/**
 * Windows-1255 maps א..ת contiguously onto 0xE0..0xFA, so a period Hebrew file
 * can be reconstructed byte for byte. Buffer has no encoder for it.
 */
function legacyHebrew(value: string): Buffer {
  return Buffer.from(
    [...value].map((character) => {
      const code = character.codePointAt(0)!;
      if (code === 0x20) return 0x20;
      if (code < 0x05d0 || code > 0x05ea) throw new Error(`not a Hebrew letter: ${character}`);
      return code - 0x05d0 + 0xe0;
    }),
  );
}

describe('extractText', () => {
  beforeEach(() => {
    extractRawText.mockReset();
    fromBuffer.mockReset();
    closeZip.mockReset();
    mockDocxEntries();
  });

  test('extracts Hebrew text from UTF-8 HTML', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.from('<h1>פיפוש</h1><p>פתרון מלא למשחק</p>'),
    );

    expect(text).toContain('פתרון מלא');
  });

  test('decodes Windows-1255 HTML according to its charset declaration', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([
        Buffer.from('<meta charset="windows-1255"><p>', 'ascii'),
        Buffer.from([0xf4, 0xe9, 0xf4, 0xe5, 0xf9]),
        Buffer.from('</p>', 'ascii'),
      ]),
    );

    expect(text).toContain('פיפוש');
  });

  test('decodes ISO-8859-8 HTML according to its charset declaration', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([
        Buffer.from('<meta charset="iso-8859-8"><p>', 'ascii'),
        Buffer.from([0xf4, 0xe9, 0xf4, 0xe5, 0xf9]),
        Buffer.from('</p>', 'ascii'),
      ]),
    );

    expect(text).toContain('פיפוש');
  });

  test('decodes an HTML content-type charset declaration', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([
        Buffer.from(
          '<meta http-equiv="Content-Type" content="text/html;charset=windows-1255"><p>',
          'ascii',
        ),
        Buffer.from([0xf4, 0xe9, 0xf4, 0xe5, 0xf9]),
        Buffer.from('</p>', 'ascii'),
      ]),
    );

    expect(text).toContain('פיפוש');
  });

  test('ignores meta content charset values without an HTTP-equivalent content-type declaration', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.from('<meta content="text/html;charset=windows-1255"><p>פיפוש</p>'),
    );

    expect(text).toContain('פיפוש');
  });

  test('ignores HTML charset declarations after the sniff window', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([
        Buffer.alloc(2048, 0x20),
        Buffer.from('<meta charset="windows-1255"><p>פיפוש</p>'),
      ]),
    );

    expect(text).toContain('פיפוש');
  });

  test('does not treat image alt text as searchable HTML content', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.from('<img alt="סוד"><p>פתרון מלא</p>'),
    );

    expect(text).toContain('פתרון מלא');
    expect(text).not.toContain('סוד');
  });

  test('keeps plain UTF-8 text mentioning a charset declaration intact', async () => {
    const text = await extractText(
      'text/plain',
      'notes.txt',
      Buffer.from('charset=windows-1255 פיפוש'),
    );

    expect(text).toBe('charset=windows-1255 פיפוש');
  });

  test('decodes Windows-1255 plain text that no charset declaration announces', async () => {
    const text = await extractText('text/plain', 'notes.txt', legacyHebrew('פיפוש חוזר'));

    expect(text).toBe('פיפוש חוזר');
  });

  test('decodes Windows-1255 HTML with no charset declaration at all', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([Buffer.from('<p>', 'ascii'), legacyHebrew('פתרון מלא'), Buffer.from('</p>', 'ascii')]),
    );

    expect(text).toContain('פתרון מלא');
  });

  test('decodes Windows-1255 HTML whose declaration sits past the sniff window', async () => {
    const text = await extractText(
      'text/html',
      'guide.html',
      Buffer.concat([
        Buffer.alloc(2048, 0x20),
        Buffer.from('<meta charset="windows-1255"><p>', 'ascii'),
        legacyHebrew('פיפוש'),
        Buffer.from('</p>', 'ascii'),
      ]),
    );

    expect(text).toContain('פיפוש');
  });

  test('never leaves replacement characters in extracted Hebrew', async () => {
    const text = await extractText('text/plain', 'notes.txt', legacyHebrew('קיבינימאט'));

    expect(text).not.toContain('\uFFFD');
    expect(text).toBe('קיבינימאט');
  });

  test('leaves undecodable bytes to the replacement character rather than throwing', async () => {
    const text = await extractText('text/plain', 'notes.txt', Buffer.from([0x81, 0x8d, 0x8f]));

    expect(typeof text).toBe('string');
  });

  test('uses Mammoth for DOCX files and trims its text', async () => {
    extractRawText.mockResolvedValue({ value: '  פיפוש חוזר  \n' });
    const data = Buffer.from('document bytes');

    await expect(
      extractText(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'piposh.docx',
        data,
      ),
    ).resolves.toBe('פיפוש חוזר');
    expect(extractRawText).toHaveBeenCalledWith({ buffer: data });
  });

  test('uses Mammoth when the official DOCX MIME type is present without an extension', async () => {
    extractRawText.mockResolvedValue({ value: ' פיפוש ' });
    const data = Buffer.from('document bytes');

    await expect(
      extractText(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document.bin',
        data,
      ),
    ).resolves.toBe('פיפוש');
    expect(extractRawText).toHaveBeenCalledWith({ buffer: data });
  });

  test('rejects oversized downloaded text before decoding it', async () => {
    await expect(
      extractText('text/plain', 'notes.txt', Buffer.alloc(MAX_TEXT_BYTES + 1)),
    ).rejects.toThrow(SIZE_LIMIT_ERROR);
  });

  test('rejects oversized downloaded DOCX before sending it to Mammoth', async () => {
    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.alloc(MAX_TEXT_BYTES + 1)),
    ).rejects.toThrow(SIZE_LIMIT_ERROR);
    expect(extractRawText).not.toHaveBeenCalled();
  });

  test('rejects DOCX archives with oversized aggregate uncompressed entries before Mammoth', async () => {
    mockDocxEntries(MAX_TEXT_BYTES + 1);

    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.from('small zip')),
    ).rejects.toThrow(SIZE_LIMIT_ERROR);
    expect(extractRawText).not.toHaveBeenCalled();
  });

  test('closes a DOCX archive after streaming its entries', async () => {
    extractRawText.mockResolvedValue({ value: 'פיפוש' });
    mockDocxEntries(100, 200);

    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.from('small zip')),
    ).resolves.toBe('פיפוש');
    expect(closeZip).toHaveBeenCalledTimes(1);
  });

  test('closes a DOCX archive and skips Mammoth when opening an entry stream fails', async () => {
    mockDocxReadStreamError(new Error('stream failed'));

    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.from('small zip')),
    ).rejects.toThrow('stream failed');
    expect(closeZip).toHaveBeenCalledTimes(1);
    expect(extractRawText).not.toHaveBeenCalled();
  });

  test('closes a DOCX archive and skips Mammoth when reading the next entry fails', async () => {
    mockDocxReadEntryError(new Error('read failed'));

    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.from('small zip')),
    ).rejects.toThrow('read failed');
    expect(closeZip).toHaveBeenCalledTimes(1);
    expect(extractRawText).not.toHaveBeenCalled();
  });

  test('rejects extracted DOCX text over the size limit', async () => {
    extractRawText.mockResolvedValue({ value: 'א'.repeat(MAX_TEXT_BYTES) });

    await expect(
      extractText('application/octet-stream', 'notes.docx', Buffer.from('small zip')),
    ).rejects.toThrow(SIZE_LIMIT_ERROR);
  });
});

describe('isTextExtractable', () => {
  test('accepts a supported text file when Drive has no size', () => {
    const acceptsDriveSize: (
      mimeType: string,
      name: string,
      size: number | null,
    ) => boolean = isTextExtractable;

    expect(acceptsDriveSize('text/plain', 'guide.txt', null)).toBe(true);
  });

  test('recognizes uppercase supported extensions', () => {
    expect(isTextExtractable('application/octet-stream', 'GUIDE.TXT', 10)).toBe(true);
    expect(isTextExtractable('application/octet-stream', 'PIPOSH.DOCX', 10)).toBe(true);
  });

  test('recognizes the official DOCX MIME type without an extension', () => {
    expect(
      isTextExtractable(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document.bin',
        10,
      ),
    ).toBe(true);
  });

  test('rejects executable files', () => {
    expect(isTextExtractable('application/x-msdownload', 'piposh.exe', 10)).toBe(false);
  });

  test('rejects supported text files over 10 MiB', () => {
    expect(isTextExtractable('text/plain', 'guide.txt', 10 * 1024 * 1024 + 1)).toBe(false);
  });

  test('accepts supported text files at exactly 10 MiB', () => {
    expect(isTextExtractable('text/plain', 'guide.txt', 10 * 1024 * 1024)).toBe(true);
  });
});

describe('optimizeCover', () => {
  test('creates a bounded WebP cover', async () => {
    const cover = await sharp({
      create: {
        width: 1200,
        height: 1800,
        channels: 4,
        background: '#ff00ff',
      },
    })
      .png()
      .toBuffer();

    const optimized = await optimizeCover(cover);
    const metadata = await sharp(optimized).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBeLessThanOrEqual(720);
    expect(metadata.height).toBeLessThanOrEqual(960);
  });

  test('rotates EXIF covers, preserves small dimensions, uses quality 82, and leaves input unchanged', async () => {
    const cover = await sharp({
      create: {
        width: 1000,
        height: 500,
        channels: 3,
        background: '#ff00ff',
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const original = Buffer.from(cover);

    const optimized = await optimizeCover(cover);
    // Flat magenta has a luminance of 73 and so no dark content at all, which is the case the
    // black point gain is capped for. A cover with no crop rectangle gets the same finishing
    // pass as one with a rectangle, so that a release without a curated crop does not sit
    // visibly outside the set.
    const gain = coverBlackPointGain(73);
    const expected = await sharp(cover)
      .rotate()
      .resize(720, 960, { fit: 'inside', withoutEnlargement: true })
      .linear(gain, 255 * (1 - gain))
      .sharpen({ sigma: 0.7, m1: 0, m2: 2 })
      .webp({ quality: 82 })
      .toBuffer();
    const metadata = await sharp(optimized).metadata();

    expect(cover).toEqual(original);
    expect(metadata.width).toBe(480);
    expect(metadata.height).toBe(960);
    expect(optimized).toEqual(expected);
  });

  test('does not enlarge a small cover', async () => {
    const cover = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: '#ff00ff',
      },
    })
      .png()
      .toBuffer();

    const metadata = await sharp(await optimizeCover(cover)).metadata();

    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(100);
  });

  /*
   * Ogg stamps a random serial number on every stream and the page CRCs follow it, so without
   * -bitexact two encodes of one unchanged source differ in ~40 bytes while decoding identically.
   * Opus does not delta-compress, so git stores each as a fresh full blob: the 2026-08-28 sync
   * rewrote 1,233 unchanged derivatives and put 279MB into history for nothing anyone can hear.
   * The flag is invisible in the output, which is exactly why it needs a test to survive.
   */
  test('encodes opus reproducibly, so an unchanged source does not churn the repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'guillotine-opus-args-'));
    const argsPath = join(directory, 'args');
    const binary = join(directory, 'stub');
    /* Drain stdin, record argv, then emit a byte: runExternalTool rejects empty output. */
    writeFileSync(
      binary,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$@" > '${argsPath}'\nprintf 'ok'\n`,
      'utf8',
    );
    chmodSync(binary, 0o755);

    await transcodeToOpus(Buffer.from('source audio'), binary, '96k');

    const args = readFileSync(argsPath, 'utf8').split('\n').filter(Boolean);
    expect(args).toContain('-bitexact');
    expect(args.indexOf('-bitexact')).toBeLessThan(args.indexOf('-f'));
  });
});

describe('optimizeCoverVariants', () => {
  async function solidCover(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: '#3a5f8a' } })
      .png()
      .toBuffer();
  }

  test('cuts a 480 rendition beside the one that ships, from the same source', async () => {
    const source = await solidCover(1500, 2000);

    const { base, narrower } = await optimizeCoverVariants(source);

    // The base is the existing rendition unchanged, so adding a tier cannot move the file
    // every page already names in src.
    expect(base).toEqual(await optimizeCover(source));
    expect([...narrower.keys()]).toEqual([480]);
    expect(await sharp(narrower.get(480)!).metadata()).toMatchObject({
      format: 'webp',
      width: 480,
      height: 640,
    });
  });

  /*
   * The whole no-upscale rule in one condition: a tier exists only when the source could fill
   * the 720 frame. Both cases below are real — פיפוש המהפכה's surviving art is 118x158, and a
   * source taller than 3:4 fits by its height and never reaches the full width — and in both
   * the tier is SKIPPED rather than invented at a size the artwork does not have.
   */
  test('skips the tier for a cover too small to fill the frame', async () => {
    const { base, narrower } = await optimizeCoverVariants(await solidCover(118, 158));

    expect(await sharp(base).metadata()).toMatchObject({ width: 118, height: 158 });
    expect(narrower.size).toBe(0);
  });

  test('skips the tier for a cover too tall to reach the full width', async () => {
    const { base, narrower } = await optimizeCoverVariants(await solidCover(1200, 1800));

    expect(await sharp(base).metadata()).toMatchObject({ width: 640, height: 960 });
    expect(narrower.size).toBe(0);
  });

  test('measures a curated crop against the 720 frame for every rendition', async () => {
    const source = await solidCover(3000, 4000);
    const crop = { left: 60, top: 80, width: 600, height: 800 };

    const { base, narrower } = await optimizeCoverVariants(source, crop);

    // The rectangle is read off the 720x960 fitted view whatever width is being written, so
    // the 480 is the same picture as the 720 and not a rectangle re-measured somewhere else.
    expect(base).toEqual(await optimizeCover(source, crop));
    expect(await sharp(narrower.get(480)!).metadata()).toMatchObject({ width: 480, height: 640 });
  });
});
