import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, test } from 'vitest';
import { buildCatalog } from '../../src/catalog/build';
import { resolveFfmpeg } from '../../src/catalog/media';
import type { CuratorConfig, DriveFile } from '../../src/catalog/types';

const roots: string[] = [];

afterEach(() => {
  roots.length = 0;
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guillotine-derivatives-'));
  for (const directory of ['src/generated', 'public/data', 'reports']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  roots.push(root);
  return root;
}

function driveFile(id: string, overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id,
    name: `${id}.jpg`,
    mimeType: 'image/jpeg',
    size: 4096,
    modifiedTime: '2026-08-26T10:00:00.000Z',
    path: `עיתונות/כתבות/${id}.jpg`,
    viewUrl: `https://drive.google.com/file/d/${id}/view`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${id}`,
    ...overrides,
  };
}

const curator: CuratorConfig = { minimumFileCount: 1, collections: [] };

async function solidJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#cc3311' } })
    .jpeg()
    .toBuffer();
}

function stubBinary(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'guillotine-stub-'));
  const path = join(directory, 'stub');
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

async function derivativeNames(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'public/generated/derivatives'))).sort();
  } catch {
    return [];
  }
}

async function report(root: string): Promise<{ warnings: string[]; errors: string[] }> {
  return JSON.parse(await readFile(join(root, 'reports/curator-report.json'), 'utf8')) as {
    warnings: string[];
    errors: string[];
  };
}

describe('derivative pipeline', () => {
  test('writes nothing and downloads nothing extra unless derivatives are requested', async () => {
    const root = await temporaryRoot();
    const downloaded: string[] = [];

    const catalog = await buildCatalog({
      files: [driveFile('page')],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async (id) => {
        downloaded.push(id);
        return solidJpeg(60, 40);
      },
    });

    expect(downloaded).toEqual([]);
    expect(await derivativeNames(root)).toEqual([]);
    expect(catalog.items[0]?.derivatives).toBeUndefined();
  });

  test('writes both tiers for an image and a third for a reader page', async () => {
    const root = await temporaryRoot();
    const files = [
      driveFile('article', { path: 'עיתונות/כתבות/article.jpg' }),
      driveFile('sprite', {
        name: 'sprite.gif',
        mimeType: 'image/gif',
        path: 'גרפיקה/גיפים/sprite.gif',
      }),
    ];

    const catalog = await buildCatalog({
      files,
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => solidJpeg(3000, 2000),
    });

    const byId = new Map(catalog.items.map((item) => [item.id, item]));
    // press-page earns the 2400px reader tier; a sprite does not.
    expect(Object.keys(byId.get('article')?.derivatives ?? {}).sort()).toEqual([
      'reader',
      'thumb',
      'view',
    ]);
    expect(Object.keys(byId.get('sprite')?.derivatives ?? {}).sort()).toEqual(['thumb', 'view']);
    expect(await derivativeNames(root)).toEqual([
      'article-reader.webp',
      'article-thumb.webp',
      'article-view.webp',
      'sprite-thumb.webp',
      'sprite-view.webp',
    ]);
    expect(byId.get('article')?.derivatives?.thumb).toMatchObject({
      path: '/generated/derivatives/article-thumb.webp',
      width: 400,
      height: 267,
    });
    expect((await report(root)).errors).toEqual([]);
  });

  test('routes an undecodable format through ImageMagick and records the result', async () => {
    const root = await temporaryRoot();
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#00f' } })
      .png()
      .toBuffer();
    // Stands in for ImageMagick: ignores stdin and emits a PNG sharp can read.
    const magick = stubBinary(
      `#!/bin/sh\ncat > /dev/null\ncat '${join(root, 'stub-source.png')}'\n`,
    );
    writeFileSync(join(root, 'stub-source.png'), png);

    const catalog = await buildCatalog({
      files: [
        driveFile('icon', {
          name: 'icon.pcx',
          mimeType: 'image/pcx',
          path: 'גרפיקה/סקינים/icon.pcx',
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: magick, ffmpeg: null },
      download: async () => Buffer.from('pcx bytes sharp cannot read'),
    });

    expect(catalog.items[0]?.derivatives?.thumb).toMatchObject({ width: 40, height: 30 });
    expect(await derivativeNames(root)).toEqual(['icon-thumb.webp', 'icon-view.webp']);
  });

  test('skips undecodable images with a warning when no ImageMagick exists', async () => {
    const root = await temporaryRoot();

    const catalog = await buildCatalog({
      files: [
        driveFile('a', { name: 'a.pcx', mimeType: 'image/pcx', path: 'גרפיקה/סקינים/a.pcx' }),
        driveFile('b', { name: 'b.bmp', mimeType: 'image/bmp', path: 'גרפיקה/סקינים/b.bmp' }),
        driveFile('c', { path: 'עיתונות/כתבות/c.jpg' }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: null },
      download: async () => solidJpeg(100, 80),
    });

    const byId = new Map(catalog.items.map((item) => [item.id, item]));
    expect(byId.get('a')?.derivatives).toBeUndefined();
    expect(byId.get('b')?.derivatives).toBeUndefined();
    // The decodable page still gets its derivatives: a missing tool is not fatal.
    expect(byId.get('c')?.derivatives?.thumb).toBeDefined();
    expect((await report(root)).warnings).toContain(
      '2 images have no derivatives because no ImageMagick binary was available to decode them',
    );
    expect((await report(root)).errors).toEqual([]);
  });

  test('skips audio with a warning when no ffmpeg exists', async () => {
    const root = await temporaryRoot();

    const catalog = await buildCatalog({
      files: [
        driveFile('effect', {
          name: 'effect.aif',
          mimeType: 'audio/x-aiff',
          path: 'דמואים/פיפוש1/FX/effect.aif',
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: null },
      download: async () => Buffer.from('aiff'),
    });

    expect(catalog.items[0]?.derivatives).toBeUndefined();
    expect((await report(root)).warnings).toContain(
      '1 audio files have no derivatives because no ffmpeg binary was available',
    );
  });

  test('stops at the source byte budget instead of pulling the whole archive', async () => {
    const root = await temporaryRoot();
    const files = Array.from({ length: 4 }, (_, index) =>
      driveFile(`page-${index}`, { size: 1000, path: `עיתונות/כתבות/page-${index}.jpg` }),
    );

    const catalog = await buildCatalog({
      files,
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      maxDerivativeSourceBytes: 2500,
      download: async () => solidJpeg(50, 50),
    });

    const withDerivatives = catalog.items.filter((item) => item.derivatives !== undefined);
    expect(withDerivatives.length).toBeLessThan(files.length);
    expect((await report(root)).warnings.join(' ')).toMatch(
      /skipped because the derivative source budget was exceeded/u,
    );
  });

  test('records a failed derivative as a warning and leaves the item usable', async () => {
    const root = await temporaryRoot();

    const catalog = await buildCatalog({
      files: [driveFile('broken', { path: 'עיתונות/כתבות/broken.jpg' })],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => Buffer.from('not an image at all'),
    });

    expect(catalog.items[0]?.derivatives).toBeUndefined();
    expect((await report(root)).warnings).toContain('failed to build derivatives for 1 files');
    expect((await report(root)).errors).toEqual([]);
  });
});

describe('video posters', () => {
  const video = (overrides: Partial<DriveFile> = {}): DriveFile =>
    driveFile('clip', {
      name: 'clip.wmv',
      mimeType: 'video/x-ms-wmv',
      path: 'סרטונים/טלוויזיה/clip.wmv',
      size: 200 * 1024 * 1024,
      ...overrides,
    });

  test('builds a poster from the Drive thumbnail without downloading video bytes', async () => {
    const root = await temporaryRoot();
    const downloaded: string[] = [];

    const catalog = await buildCatalog({
      files: [
        video({
          thumbnailUrl: 'https://lh3.googleusercontent.com/thumb',
          durationMillis: 42_000,
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async (id) => {
        downloaded.push(id);
        return Buffer.alloc(0);
      },
      fetchThumbnail: async () => solidJpeg(1280, 720),
    });

    expect(downloaded).toEqual([]);
    expect(catalog.items[0]?.derivatives).toMatchObject({
      durationMillis: 42_000,
      poster: { path: '/generated/derivatives/clip-poster.webp', width: 1280, height: 720 },
    });
    expect(await derivativeNames(root)).toEqual(['clip-poster.webp']);
  });

  test('keeps the duration and warns when Drive supplies no thumbnail', async () => {
    const root = await temporaryRoot();

    const catalog = await buildCatalog({
      files: [video({ durationMillis: 7000 })],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => Buffer.alloc(0),
    });

    expect(catalog.items[0]?.derivatives).toEqual({ durationMillis: 7000 });
    expect(await derivativeNames(root)).toEqual([]);
    expect((await report(root)).warnings.join(' ')).toMatch(
      /videos have no poster because Drive supplied no thumbnail/u,
    );
  });

  test('warns rather than failing when the thumbnail fetch breaks', async () => {
    const root = await temporaryRoot();

    await buildCatalog({
      files: [video({ thumbnailUrl: 'https://lh3.googleusercontent.com/thumb' })],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => Buffer.alloc(0),
      fetchThumbnail: async () => {
        throw new Error('403');
      },
    });

    expect((await report(root)).warnings).toContain('failed to build posters for 1 videos');
    expect((await report(root)).errors).toEqual([]);
  });
});

describe('real ffmpeg transcoding', () => {
  const ffmpeg = resolveFfmpeg();

  test.skipIf(ffmpeg === null)('writes an Ogg/Opus derivative for a WAV effect', async () => {
    const root = await temporaryRoot();
    const pcm = Buffer.alloc(44100 * 2);
    for (let index = 0; index < 44100; index += 1) {
      pcm.writeInt16LE(Math.round(6000 * Math.sin((index / 44100) * 2 * Math.PI * 330)), index * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(44100, 24);
    header.writeUInt32LE(88200, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    const wav = Buffer.concat([header, pcm]);

    const catalog = await buildCatalog({
      files: [
        driveFile('effect', {
          name: 'effect.wav',
          mimeType: 'audio/wav',
          path: 'דמואים/פיפוש1/FX/effect.wav',
          size: wav.length,
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => wav,
    });

    expect(catalog.items[0]?.derivatives?.audio?.path).toBe('/generated/derivatives/effect.opus');
    const written = await readFile(join(root, 'public/generated/derivatives/effect.opus'));
    expect(written.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(written.length).toBeLessThan(wav.length / 2);
  });
});
