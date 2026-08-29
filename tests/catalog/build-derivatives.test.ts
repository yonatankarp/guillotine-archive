import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

/** ffmpeg is the only practical way to author a valid video fixture. */
async function syntheticVideo(binary: string, container: 'avi' | 'mp4'): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'guillotine-video-fixture-'));
  const path = join(directory, `clip.${container}`);
  const codecs =
    container === 'mp4' ? ['-c:v', 'libx264', '-c:a', 'aac'] : ['-c:v', 'mpeg4', '-c:a', 'mp3'];

  await promisify(execFile)(binary, [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    ...codecs,
    '-y', path,
  ]);

  return readFile(path);
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

describe('video derivatives', () => {
  const video = (id: string, overrides: Partial<DriveFile> = {}): DriveFile =>
    driveFile(id, {
      name: `${id}.wmv`,
      mimeType: 'video/x-ms-wmv',
      path: `סרטונים/טלוויזיה/${id}.wmv`,
      size: 4 * 1024 * 1024,
      ...overrides,
    });

  /**
   * Records the arguments it was handed and writes the requested number of
   * bytes to the target path, which is always the last argument. That is enough
   * to prove which branch ran and to drive the size guards without waiting on a
   * real encode.
   */
  function stubFfmpeg(root: string, outputBytes: number): { path: string; args: () => string[] } {
    const argsPath = join(root, 'ffmpeg-args.txt');
    const path = stubBinary(
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\nfor target; do :; done\nhead -c ${String(outputBytes)} /dev/zero > "$target"\n`,
    );
    return {
      path,
      args: () => readFileSync(argsPath, 'utf8').trim().split('\n'),
    };
  }

  test('remuxes an MP4 instead of re-encoding it, and transcodes everything else', async () => {
    for (const [mimeType, name, expected, rejected] of [
      ['video/mp4', 'clip.mp4', '-c', 'libx264'],
      ['video/x-ms-wmv', 'clip.wmv', 'libx264', '-c'],
    ] as const) {
      const root = await temporaryRoot();
      const ffmpeg = stubFfmpeg(root, 1024);

      const catalog = await buildCatalog({
        files: [video('clip', { name, mimeType, path: `סרטונים/טלוויזיה/${name}` })],
        curator,
        root,
        generatedAt: '2026-08-26T12:00:00.000Z',
        buildDerivatives: true,
        externalTools: { imageMagick: null, ffmpeg: ffmpeg.path },
        download: async () => Buffer.from('video bytes'),
      });

      const args = ffmpeg.args();
      expect(args).toContain(expected);
      expect(args).not.toContain(rejected);
      // Both branches must produce a progressively streamable file.
      expect(args).toContain('+faststart');
      expect(catalog.items[0]?.derivatives?.video).toMatchObject({
        path: '/generated/derivatives/clip.mp4',
        bytes: 1024,
      });
      expect(await derivativeNames(root)).toContain('clip.mp4');
    }
  });

  test('keeps the poster and duration alongside the playable derivative', async () => {
    const root = await temporaryRoot();
    const ffmpeg = stubFfmpeg(root, 512);

    const catalog = await buildCatalog({
      files: [
        video('clip', {
          thumbnailUrl: 'https://lh3.googleusercontent.com/thumb',
          durationMillis: 42_000,
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: ffmpeg.path },
      download: async () => Buffer.from('video bytes'),
      fetchThumbnail: async () => solidJpeg(1280, 720),
    });

    expect(Object.keys(catalog.items[0]?.derivatives ?? {}).sort()).toEqual([
      'durationMillis',
      'poster',
      'video',
    ]);
  });

  test('skips video with a warning when no ffmpeg exists', async () => {
    const root = await temporaryRoot();
    const downloaded: string[] = [];

    const catalog = await buildCatalog({
      files: [video('clip')],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: null },
      download: async (id) => {
        downloaded.push(id);
        return Buffer.from('video bytes');
      },
    });

    expect(downloaded).toEqual([]);
    expect(catalog.items[0]?.derivatives?.video).toBeUndefined();
    expect((await report(root)).warnings).toContain(
      '1 videos have no playable derivative because no ffmpeg binary was available',
    );
    expect((await report(root)).errors).toEqual([]);
  });

  /** The Drive gateway refuses a response this large, so the download is never attempted. */
  test('skips a video past the Drive download ceiling without downloading it', async () => {
    const root = await temporaryRoot();
    const ffmpeg = stubFfmpeg(root, 1024);
    const downloaded: string[] = [];

    const catalog = await buildCatalog({
      files: [
        video('huge', { size: 40 * 1024 * 1024 }),
        video('small', { size: 4 * 1024 * 1024 }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: ffmpeg.path },
      download: async (id) => {
        downloaded.push(id);
        return Buffer.from('video bytes');
      },
    });

    expect(downloaded).toEqual(['small']);
    const byId = new Map(catalog.items.map((item) => [item.id, item]));
    expect(byId.get('huge')?.derivatives?.video).toBeUndefined();
    expect(byId.get('small')?.derivatives?.video).toBeDefined();
    expect((await report(root)).warnings).toContain(
      '1 videos skipped because they exceed the 32 MiB Drive download ceiling',
    );
  });

  test('discards a derivative that would overrun the video budget and says so', async () => {
    const root = await temporaryRoot();
    const ffmpeg = stubFfmpeg(root, 200_000);

    const catalog = await buildCatalog({
      files: [video('first'), video('second')],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      maxVideoDerivativeBytes: 250_000,
      externalTools: { imageMagick: null, ffmpeg: ffmpeg.path },
      download: async () => Buffer.from('video bytes'),
    });

    const withVideo = catalog.items.filter((item) => item.derivatives?.video !== undefined);
    expect(withVideo).toHaveLength(1);
    // The rejected encode must leave nothing behind on disk either.
    expect(await derivativeNames(root)).toEqual(['first.mp4']);
    expect((await report(root)).warnings).toContain(
      '1 videos skipped because the video derivative budget was exceeded',
    );
    expect((await report(root)).errors).toEqual([]);
  });

  test('records a failed encode as a warning and leaves the item usable', async () => {
    const root = await temporaryRoot();
    const failing = stubBinary('#!/bin/sh\nexit 3\n');

    const catalog = await buildCatalog({
      files: [video('clip')],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      externalTools: { imageMagick: null, ffmpeg: failing },
      download: async () => Buffer.from('video bytes'),
    });

    expect(catalog.items[0]?.derivatives?.video).toBeUndefined();
    expect((await report(root)).warnings).toContain('failed to build derivatives for 1 files');
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

  test.skipIf(ffmpeg === null)('writes a genuinely streamable MP4 for an AVI', async () => {
    const root = await temporaryRoot();
    const avi = await syntheticVideo(ffmpeg!, 'avi');

    const catalog = await buildCatalog({
      files: [
        driveFile('clip', {
          name: 'clip.avi',
          mimeType: 'video/x-msvideo',
          path: 'סרטונים/טלוויזיה/clip.avi',
          size: avi.length,
        }),
      ],
      curator,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      buildDerivatives: true,
      download: async () => avi,
    });

    expect(catalog.items[0]?.derivatives?.video?.path).toBe('/generated/derivatives/clip.mp4');
    const written = await readFile(join(root, 'public/generated/derivatives/clip.mp4'));
    expect(written.subarray(4, 8).toString('latin1')).toBe('ftyp');
    // The whole point of faststart: the index precedes the frames, so playback
    // can start on the first bytes instead of after the last one.
    expect(written.indexOf(Buffer.from('moov'))).toBeLessThan(written.indexOf(Buffer.from('mdat')));
  });
});

describe('cover renditions', () => {
  const withCover: CuratorConfig = {
    minimumFileCount: 1,
    collections: [
      {
        slug: 'piposh-1',
        titleHe: 'פיפוש 1',
        type: 'game',
        summaryHe: 'המשחק המקורי',
        coverFileId: 'cover',
        aliasesHe: [],
        tagsHe: [],
        rules: [],
        exclude: [],
      },
    ],
  };

  async function coverNames(root: string): Promise<string[]> {
    return (await readdir(join(root, 'public/generated/covers'))).sort();
  }

  /*
   * The sweep is the part most likely to be wrong, so it is asserted rather than reasoned
   * about: `staleCoverArtifacts` deletes every .webp whose basename is not in the selected
   * set, so a second build has to see `cover-480` as selected too. If the renditions were
   * tracked anywhere other than the map that set is derived from, the tier would be written
   * by one sync and deleted by the next, and nothing else in the suite would notice.
   */
  test('writes the narrower cover beside the base one and keeps it across builds', async () => {
    const root = await temporaryRoot();
    const png = await sharp({
      create: { width: 1500, height: 2000, channels: 3, background: '#204060' },
    })
      .png()
      .toBuffer();
    const files = [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })];

    await buildCatalog({
      files,
      curator: withCover,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => png,
    });

    expect(await coverNames(root)).toEqual(['cover-480.webp', 'cover.webp']);
    expect(
      await sharp(join(root, 'public/generated/covers/cover-480.webp')).metadata(),
    ).toMatchObject({ format: 'webp', width: 480 });

    await buildCatalog({
      files,
      curator: withCover,
      root,
      generatedAt: '2026-08-27T12:00:00.000Z',
      download: async () => png,
    });

    expect(await coverNames(root)).toEqual(['cover-480.webp', 'cover.webp']);
  });

  test('writes only the base cover when the source cannot fill the frame', async () => {
    const root = await temporaryRoot();
    const png = await sharp({
      create: { width: 118, height: 158, channels: 3, background: '#204060' },
    })
      .png()
      .toBuffer();

    await buildCatalog({
      files: [driveFile('cover', { name: 'cover.png', mimeType: 'image/png' })],
      curator: withCover,
      root,
      generatedAt: '2026-08-26T12:00:00.000Z',
      download: async () => png,
    });

    // No tier file means the components emit no srcset for it, which is what keeps a cover
    // this small sitting at its true size on the mat instead of being stretched to fill sizes.
    expect(await coverNames(root)).toEqual(['cover.webp']);
  });
});
