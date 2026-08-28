import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import {
  cropInSource,
  decodeWithImageMagick,
  imageTiersFor,
  isStreamableVideoContainer,
  needsExternalDecoder,
  opusBitrateFor,
  optimizeCover,
  optimizeLogo,
  remuxToStreamableMp4,
  resizeImage,
  resolveFfmpeg,
  resolveImageMagick,
  transcodeToMp4,
  transcodeToOpus,
  type CropRegion,
} from '../../src/catalog/media';

async function solidImage(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

/**
 * A four-quadrant image makes a crop verifiable by colour: extracting a known
 * rectangle must yield exactly the quadrant that rectangle covers.
 */
async function quadrantImage(width: number, height: number): Promise<Buffer> {
  const half = { width: Math.floor(width / 2), height: Math.floor(height / 2) };
  return sharp({ create: { width, height, channels: 3, background: '#000000' } })
    .composite([
      { input: await solidImage(half.width, half.height, '#ff0000'), left: 0, top: 0 },
      { input: await solidImage(half.width, half.height, '#00ff00'), left: half.width, top: 0 },
      { input: await solidImage(half.width, half.height, '#0000ff'), left: 0, top: half.height },
    ])
    .png()
    .toBuffer();
}

/**
 * One-pixel vertical stripes. A frequency this fine exists only at full resolution: any
 * downsample averages neighbouring stripes into flat grey, and enlarging afterwards cannot
 * bring them back, so the pattern's survival is proof of where the crop was taken from.
 */
async function stripedImage(width: number, height: number): Promise<Buffer> {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x += 1) row.fill(x % 2 === 0 ? 0 : 255, x * 3, x * 3 + 3);

  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) row.copy(pixels, y * width * 3);

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Darkest and lightest sample on the output's middle row, away from its edges. */
async function middleRowContrast(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const row = Math.floor(info.height / 2);
  const samples: number[] = [];
  for (let x = 40; x < info.width - 40; x += 1) {
    samples.push(data[(row * info.width + x) * info.channels]!);
  }

  return Math.max(...samples) - Math.min(...samples);
}

async function centrePixel(data: Buffer): Promise<[number, number, number]> {
  const { data: raw } = await sharp(data)
    .extract({
      left: Math.floor((await sharp(data).metadata()).width! / 2) - 1,
      top: Math.floor((await sharp(data).metadata()).height! / 2) - 1,
      width: 2,
      height: 2,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [raw[0]!, raw[1]!, raw[2]!].map((value) => Math.round(value / 51) * 51) as [
    number,
    number,
    number,
  ];
}

function stubBinary(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'guillotine-tool-'));
  const path = join(directory, 'stub');
  writeFileSync(path, script, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

describe('cover and logo crops', () => {
  test('leaves the uncropped cover behaviour untouched', async () => {
    const optimized = await optimizeCover(await solidImage(1200, 1800, '#ff00ff'));
    const metadata = await sharp(optimized).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(960);
  });

  test('crops into one fixed 3:4 frame regardless of the source ratio', async () => {
    for (const [width, height] of [
      [720, 919],
      [720, 711],
      [720, 479],
    ] as const) {
      const crop: CropRegion = { left: 0, top: 0, width: Math.floor(height * 0.75), height };
      const cropped = await optimizeCover(await solidImage(width, height, '#123456'), crop);
      const metadata = await sharp(cropped).metadata();

      expect([metadata.width, metadata.height]).toEqual([720, 960]);
    }
  });

  /**
   * The Drive originals run to 20 MiB and several thousand pixels while the
   * curated rectangles were measured on the 720x960-fitted frame. If the fit
   * step were skipped, this crop would land in the red quadrant instead.
   */
  test('measures the crop against the fitted frame, not the oversized original', async () => {
    const original = await quadrantImage(2880, 3840);
    const cropped = await optimizeCover(original, { left: 360, top: 0, width: 360, height: 480 });

    expect(await centrePixel(cropped)).toEqual([0, 255, 0]);
  });

  /**
   * The rectangle is measured in the fitted frame and extracted from the original, which
   * are two different spaces. ווג׳ימון is the case that made this visible: a 1600x1064 box
   * wrap fits to 720x479, so its front panel is 359 fitted pixels wide and 798 real ones.
   */
  test('scales the curated rectangle into full-resolution source pixels', () => {
    expect(
      cropInSource(
        { left: 0, top: 0, width: 359, height: 479 },
        { width: 720, height: 479 },
        { width: 1600, height: 1064 },
      ),
    ).toEqual({ left: 0, top: 0, width: 798, height: 1064 });

    // A source that already fits needs no scaling, so the rectangle is passed through.
    expect(
      cropInSource(
        { left: 15, top: 0, width: 689, height: 919 },
        { width: 720, height: 919 },
        { width: 720, height: 919 },
      ),
    ).toEqual({ left: 15, top: 0, width: 689, height: 919 });

    // Scaling up a rectangle flush against the frame edge must not round past the source.
    expect(
      cropInSource(
        { left: 0, top: 0, width: 719, height: 960 },
        { width: 719, height: 960 },
        { width: 1199, height: 1600 },
      ),
    ).toEqual({ left: 0, top: 0, width: 1199, height: 1600 });
  });

  /**
   * The frame is 720x960 whatever happens, so the only question is whether it is filled with
   * real pixels or with an enlargement of a thumbnail. Here the rectangle is a quarter of the
   * fitted frame and exactly 720x960 pixels of the original: extracted from the original it
   * fills the frame at 1:1, and extracted from the fitted frame it would be enlarged 2x.
   */
  test('fills the frame from the original rather than enlarging the fitted frame', async () => {
    const cover = await optimizeCover(await stripedImage(1440, 1920), {
      left: 0,
      top: 0,
      width: 360,
      height: 480,
    });
    const metadata = await sharp(cover).metadata();

    expect([metadata.width, metadata.height]).toEqual([720, 960]);
    // Enlarging the fitted frame instead measures 0 here: the stripes are averaged away.
    expect(await middleRowContrast(cover)).toBeGreaterThan(200);
  });

  test('keeps a logo at its native crop size', async () => {
    const logo = await optimizeLogo(await solidImage(720, 919, '#abcdef'), {
      left: 325,
      top: 10,
      width: 380,
      height: 175,
    });
    const metadata = await sharp(logo).metadata();

    expect([metadata.width, metadata.height]).toEqual([380, 175]);
    expect(metadata.format).toBe('webp');
  });

  test('rejects a crop that falls outside the fitted frame instead of producing corner art', async () => {
    const source = await solidImage(720, 479, '#ffffff');

    await expect(
      optimizeCover(source, { left: 600, top: 0, width: 300, height: 400 }),
    ).rejects.toThrow(/falls outside the 720x479 frame/u);
    await expect(
      optimizeLogo(source, { left: 0, top: 400, width: 100, height: 200 }),
    ).rejects.toThrow(/falls outside/u);
  });

  test('rejects a nonsensical crop region', async () => {
    const source = await solidImage(720, 960, '#ffffff');

    for (const crop of [
      { left: -1, top: 0, width: 10, height: 10 },
      { left: 0, top: 0, width: 0, height: 10 },
      { left: 0.5, top: 0, width: 10, height: 10 },
    ]) {
      await expect(optimizeCover(source, crop)).rejects.toThrow(/nonnegative integers/u);
    }
  });
});

describe('image derivative tiers', () => {
  test('gives reader kinds a third tier and everything else two', () => {
    for (const kind of ['booklet-page', 'comic-page', 'press-page']) {
      expect(imageTiersFor(kind).map(({ name }) => name)).toEqual(['thumb', 'view', 'reader']);
      expect(imageTiersFor(kind).at(-1)?.edge).toBe(2400);
    }
    for (const kind of ['cover', 'scan', 'sprite']) {
      expect(imageTiersFor(kind).map(({ name }) => name)).toEqual(['thumb', 'view']);
    }
  });

  test('fits inside the tier edge and never enlarges a small sprite', async () => {
    const large = await resizeImage(await solidImage(3000, 2000, '#ff0000'), 400);
    expect([large.width, large.height]).toEqual([400, 267]);

    const sprite = await resizeImage(await solidImage(32, 32, '#00ff00'), 400);
    expect([sprite.width, sprite.height]).toEqual([32, 32]);
    expect((await sharp(sprite.data).metadata()).format).toBe('webp');
  });
});

describe('external decoder routing', () => {
  test('routes exactly the formats libvips cannot read', () => {
    for (const mimeType of [
      'image/pcx',
      'image/bmp',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/x-raw',
    ]) {
      expect(needsExternalDecoder(mimeType)).toBe(true);
    }
    for (const mimeType of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(needsExternalDecoder(mimeType)).toBe(false);
    }
  });

  test('is case and parameter insensitive', () => {
    expect(needsExternalDecoder('IMAGE/PCX')).toBe(true);
    expect(needsExternalDecoder('image/bmp; charset=binary')).toBe(true);
  });

  test('sharp genuinely cannot decode a valid BMP, which is why the routing exists', async () => {
    const header = Buffer.alloc(54);
    header.write('BM', 0);
    header.writeUInt32LE(70, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(2, 18);
    header.writeInt32LE(2, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    const bmp = Buffer.concat([header, Buffer.alloc(16, 128)]);

    await expect(sharp(bmp).metadata()).rejects.toThrow(/unsupported image format/u);
  });
});

describe('binary resolution', () => {
  test('prefers an explicit override and reports a missing one as unavailable', () => {
    const stub = stubBinary('#!/bin/sh\nexit 0\n');

    expect(resolveImageMagick({ GUILLOTINE_IMAGEMAGICK_PATH: stub })).toBe(stub);
    expect(resolveFfmpeg({ GUILLOTINE_FFMPEG_PATH: stub })).toBe(stub);
    expect(resolveImageMagick({ GUILLOTINE_IMAGEMAGICK_PATH: '/nope/magick' })).toBeNull();
  });

  test('resolves an absolute path or null, never a bare name', () => {
    for (const resolved of [resolveImageMagick({}), resolveFfmpeg({})]) {
      if (resolved !== null) {
        expect(resolved.startsWith('/')).toBe(true);
        expect(existsSync(resolved)).toBe(true);
      }
    }
  });
});

describe('external tool invocation', () => {
  test('passes the image on stdin and asks ImageMagick for PNG on stdout', async () => {
    const stub = stubBinary('#!/bin/sh\ncat > /dev/null\nprintf "ARGS:%s" "$*"\n');
    const output = await decodeWithImageMagick(Buffer.from('pcx bytes'), stub);

    expect(output.toString()).toBe('ARGS:- png:-');
  });

  test('reports a nonzero exit rather than returning a broken image', async () => {
    const failing = stubBinary('#!/bin/sh\ncat > /dev/null\nexit 3\n');

    await expect(decodeWithImageMagick(Buffer.from('x'), failing)).rejects.toThrow(
      /exited with code 3/u,
    );
  });

  test('reports empty output rather than writing a zero-byte derivative', async () => {
    const silent = stubBinary('#!/bin/sh\ncat > /dev/null\nexit 0\n');

    await expect(decodeWithImageMagick(Buffer.from('x'), silent)).rejects.toThrow(
      /produced no output/u,
    );
  });

  test('does not deadlock on a tool that writes to stderr', async () => {
    const chatty = stubBinary(
      '#!/bin/sh\ncat > /dev/null\ni=0\nwhile [ $i -lt 400 ]; do echo "warning line $i" >&2; i=$((i+1)); done\nprintf "done"\n',
    );

    expect((await decodeWithImageMagick(Buffer.from('x'), chatty)).toString()).toBe('done');
  });
});

describe('audio transcoding', () => {
  test('uses a higher bitrate for released tracks than for game sounds', () => {
    expect(opusBitrateFor('track')).toBe('96k');
    expect(opusBitrateFor('sound')).toBe('64k');
  });

  const ffmpeg = resolveFfmpeg();

  test.skipIf(ffmpeg === null)('produces a real Ogg/Opus stream from PCM', async () => {
    const pcm = Buffer.alloc(44100 * 2, 0);
    for (let index = 0; index < 44100; index += 1) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin((index / 44100) * 2 * Math.PI * 440)), index * 2);
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

    const opus = await transcodeToOpus(wav, ffmpeg!, '64k');

    expect(opus.subarray(0, 4).toString('latin1')).toBe('OggS');
    expect(opus.subarray(0, 200).includes(Buffer.from('OpusHead'))).toBe(true);
    expect(opus.length).toBeLessThan(wav.length / 2);
  });
});

describe('video transcoding', () => {
  test('routes only an MP4 container down the no-re-encode path', () => {
    expect(isStreamableVideoContainer('video/mp4')).toBe(true);
    expect(isStreamableVideoContainer('VIDEO/MP4')).toBe(true);
    expect(isStreamableVideoContainer('video/mp4; codecs=avc1')).toBe(true);
    for (const mimeType of [
      'video/x-ms-wmv',
      'video/x-msvideo',
      'video/mpeg',
      'video/mp2p',
      // WebM plays in a browser but its streams cannot be copied into MP4.
      'video/webm',
    ]) {
      expect(isStreamableVideoContainer(mimeType)).toBe(false);
    }
  });

  const ffmpeg = resolveFfmpeg();
  const run = promisify(execFile);

  async function sourceVideo(
    binary: string,
    size: string,
    container: 'avi' | 'mp4',
  ): Promise<Buffer> {
    const path = join(await mkdtemp(join(tmpdir(), 'guillotine-source-')), `clip.${container}`);
    const codecs =
      container === 'mp4' ? ['-c:v', 'libx264', '-c:a', 'aac'] : ['-c:v', 'mpeg4', '-c:a', 'mp3'];
    await run(binary, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      ...codecs,
      '-y', path,
    ]);
    return readFile(path);
  }

  /** ffmpeg reports the decoded stream on stderr, which is the cheapest probe available. */
  async function streamSummary(binary: string, data: Buffer): Promise<string> {
    const path = join(await mkdtemp(join(tmpdir(), 'guillotine-probe-')), 'clip.mp4');
    await writeFile(path, data);
    const { stderr } = await run(binary, ['-hide_banner', '-i', path, '-f', 'null', '-']);
    return stderr;
  }

  function indexPrecedesFrames(mp4: Buffer): boolean {
    return mp4.indexOf(Buffer.from('moov')) < mp4.indexOf(Buffer.from('mdat'));
  }

  test.skipIf(ffmpeg === null)('transcodes an AVI to browser-safe H.264 and caps it at 480p', async () => {
    const mp4 = await transcodeToMp4(await sourceVideo(ffmpeg!, '1920x1080', 'avi'), ffmpeg!);
    const summary = await streamSummary(ffmpeg!, mp4);

    expect(mp4.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(indexPrecedesFrames(mp4)).toBe(true);
    expect(summary).toContain('854x480');
    // yuv420p at Main is the combination every browser decodes.
    expect(summary).toMatch(/h264 \(Main\)/u);
    expect(summary).toContain('yuv420p');
    expect(summary).toContain('aac');
  });

  test.skipIf(ffmpeg === null)('never enlarges a source that is already small', async () => {
    const mp4 = await transcodeToMp4(await sourceVideo(ffmpeg!, '320x240', 'avi'), ffmpeg!);

    expect(await streamSummary(ffmpeg!, mp4)).toContain('320x240');
  });

  /**
   * The remux must not re-encode, and the visible proof is the frame size: a
   * transcode of this same source would come back downscaled to 854x480.
   */
  test.skipIf(ffmpeg === null)('remuxes an MP4 for streaming without touching its frames', async () => {
    const source = await sourceVideo(ffmpeg!, '1920x1080', 'mp4');
    const mp4 = await remuxToStreamableMp4(source, ffmpeg!);

    expect(await streamSummary(ffmpeg!, mp4)).toContain('1920x1080');
    expect(indexPrecedesFrames(mp4)).toBe(true);
  });

  test('reports a failing encoder rather than returning a broken file', async () => {
    const failing = stubBinary('#!/bin/sh\nexit 3\n');

    await expect(transcodeToMp4(Buffer.from('not a video'), failing)).rejects.toThrow(
      /exited with code 3/u,
    );
  });
});
