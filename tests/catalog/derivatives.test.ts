import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import {
  coverBlackPointGain,
  cropInSource,
  decodeWithImageMagick,
  imageTiersFor,
  isStreamableVideoContainer,
  luminancePercentile,
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

/**
 * A grey ramp across the width. `floor` is the darkest level in it, which makes the black
 * point of the frame a number the test chose rather than one it has to discover.
 */
async function rampImage(width: number, height: number, floor: number): Promise<Buffer> {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x += 1) {
    row.fill(Math.round(floor + ((255 - floor) * x) / (width - 1)), x * 3, x * 3 + 3);
  }

  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) row.copy(pixels, y * width * 3);

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/**
 * Luminance range of a region, which is how both the black point and flatness are read.
 * Decoded rather than taken from sharp's stats(), which reports on the input image and
 * silently ignores an extract earlier in the chain.
 */
async function regionRange(
  image: Buffer,
  region: { left: number; top: number; width: number; height: number },
): Promise<{ min: number; max: number; stdev: number }> {
  const { data, info } = await sharp(image)
    .extract(region)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let min = 255;
  let max = 0;
  let sum = 0;
  let squares = 0;
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const level = data[pixel * info.channels]!;
    min = Math.min(min, level);
    max = Math.max(max, level);
    sum += level;
    squares += level * level;
  }

  const count = info.width * info.height;
  const mean = sum / count;

  return { min, max, stdev: Math.sqrt(Math.max(0, squares / count - mean * mean)) };
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

  /*
   * The old version of this test only ever fed rectangles that were ALREADY 3:4, so despite its
   * name it never tested a non-3:4 source — and that is precisely how פיפוש 2 shipped with its
   * title sliced off. Its scan is a near-square front panel with no wrap, and squaring it to the
   * frame cut the lettering off both sides. The contract is now: the rectangle is the artwork,
   * so its shape is PRESERVED and the frame mats the difference.
   */
  test('a crop keeps its own shape rather than being squared to the frame', async () => {
    for (const [width, height] of [
      [689, 919],
      [720, 711],
      [357, 479],
      [612, 882],
    ] as const) {
      const crop: CropRegion = { left: 0, top: 0, width, height };
      const cropped = await optimizeCover(await solidImage(width, height, '#123456'), crop);
      const { width: outWidth = 0, height: outHeight = 0 } = await sharp(cropped).metadata();

      expect(outWidth, `${width}x${height} fits the frame`).toBeLessThanOrEqual(720);
      expect(outHeight, `${width}x${height} fits the frame`).toBeLessThanOrEqual(960);
      /* One dimension reaches the frame, so nothing is left needlessly small. */
      expect(outWidth === 720 || outHeight === 960, `${width}x${height} fills one axis`).toBe(true);
      /* And the shape survives: no slicing. */
      expect(
        Math.abs(outWidth / outHeight - width / height),
        `${width}x${height} keeps its aspect`,
      ).toBeLessThan(0.01);
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

/**
 * A soft edge and a grainy flat field in one frame, plus a black bar wide enough to hold the
 * black point at zero so the tone pass is a no-op and the sharpen can be judged on its own.
 *
 * The edge spans three pixels because that is what a downscale leaves of a printed edge, and
 * it is the scale a 0.7-pixel radius acts on: a wider ramp passes through untouched.
 */
async function edgeAndGrainImage(): Promise<Buffer> {
  const width = 720;
  const height = 960;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      if (x >= 20 && x < 200) value = 40;
      else if (x >= 200 && x < 203) value = 40 + Math.round(((x - 199) * 170) / 4);
      else if (x >= 203 && x < 400) value = 210;
      else if (x >= 400) value = 128 + (((x * 7 + y * 13) % 13) - 6);
      const offset = (y * width + x) * 3;
      pixels.fill(value, offset, offset + 3);
    }
  }

  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/**
 * How far the middle row dips below the flat level on the dark side of the edge and rises
 * above it on the light side. An unsharp pass and nothing else puts values outside the two
 * flat levels the source was built from, so this is the signature to assert on rather than
 * the step across the edge, which a three-pixel ramp already maximises on its own.
 */
async function edgeOvershoot(image: Buffer): Promise<{ under: number; over: number }> {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const row = Math.floor(info.height / 2) * info.width;
  let under = 255;
  let over = 0;
  for (let x = 195; x < 200; x += 1) under = Math.min(under, data[row + x]!);
  for (let x = 203; x < 208; x += 1) over = Math.max(over, data[row + x]!);

  return { under, over };
}

const WHOLE_FRAME: CropRegion = { left: 0, top: 0, width: 720, height: 960 };

describe('cover finishing pass', () => {
  /**
   * The measured complaint: the box scans reach the frame with nothing near black in them,
   * which is what reads as haze rather than as printed card.
   */
  test('pulls a lifted black point down to black', async () => {
    const source = await rampImage(720, 960, 40);
    expect((await regionRange(source, WHOLE_FRAME)).min).toBe(40);

    const finished = await optimizeCover(source, WHOLE_FRAME);

    expect((await regionRange(finished, WHOLE_FRAME)).min).toBeLessThan(12);
  });

  /**
   * The same pass has to be inert on a cover that already reaches black, because that is what
   * lets it run on every cover instead of on a hand-picked list.
   */
  test('leaves a cover that already reaches black alone', async () => {
    const finished = await optimizeCover(await rampImage(720, 960, 0), WHOLE_FRAME);
    const { min, max } = await regionRange(finished, WHOLE_FRAME);

    expect(min).toBeLessThan(4);
    expect(max).toBeGreaterThan(251);
    // The ramp's midpoint moves only by the encoder, not by a tone curve.
    const middle = await regionRange(finished, { left: 356, top: 400, width: 8, height: 160 });
    expect(middle.min).toBeGreaterThan(120);
    expect(middle.max).toBeLessThan(136);
  });

  /**
   * A frame with no dark content at all is a legitimately light image, not a hazy one. The
   * gain cap is what stops the pass from reading it as haze and slamming it.
   */
  test('caps the pull instead of slamming a frame with no dark content', async () => {
    const finished = await optimizeCover(await solidImage(720, 960, '#c8c8c8'), WHOLE_FRAME);
    const { min } = await regionRange(finished, WHOLE_FRAME);

    expect(min).toBeGreaterThan(175);
  });

  test('holds the white point still so the pass can only deepen shadows', () => {
    for (const darkest of [0, 4, 12, 38, 120]) {
      const gain = coverBlackPointGain(darkest);
      expect(255 * gain + 255 * (1 - gain)).toBeCloseTo(255);
    }
  });

  /**
   * A greyscale or palette source decodes to one band, where the Rec. 709 weights would read
   * across into the next pixel instead of into this one's green and blue.
   */
  test('reads the black point of a single-band frame from that band', () => {
    const grey = Uint8Array.from([10, 20, 30, 40, 200, 200, 200, 200, 200, 200]);

    expect(luminancePercentile(grey, 10, 1, 1, 0.05)).toBe(10);
    expect(luminancePercentile(grey, 10, 1, 1, 0.35)).toBe(40);
    // Three RGB pixels, of which the darkest is the middle one.
    const colour = Uint8Array.from([255, 255, 255, 0, 0, 0, 128, 128, 128]);
    expect(luminancePercentile(colour, 3, 1, 3, 0.01)).toBe(0);
  });

  test('scales the pull to how lifted the black point is, and no further', () => {
    expect(coverBlackPointGain(0)).toBe(1);
    expect(coverBlackPointGain(4)).toBe(1);
    expect(coverBlackPointGain(38)).toBeCloseTo(1.157, 3);
    expect(coverBlackPointGain(200)).toBe(1.25);
  });

  /**
   * The tone pass reconstructs the frame from a raw buffer, so a source with transparency has
   * to survive both that and the WebP encode with its alpha band intact and unramped: a ramped
   * alpha would show as transparency punched through the middle of a 3:4 cover.
   */
  test('carries an alpha band through the pass without ramping it', async () => {
    const width = 720;
    const height = 960;
    const pixels = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      // A black left half holds the black point at zero, so the gain here is exactly 1.
      const opaque = pixel % width < width / 2;
      pixels[offset] = opaque ? 0 : 200;
      pixels[offset + 3] = opaque ? 255 : 128;
    }
    const source = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const finished = await optimizeCover(source, WHOLE_FRAME);

    expect((await sharp(finished).metadata()).hasAlpha).toBe(true);
    const { data, info } = await sharp(finished)
      .extract({ left: 500, top: 400, width: 40, height: 40 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let lowest = 255;
    let highest = 0;
    for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
      const alpha = data[pixel * info.channels + 3]!;
      lowest = Math.min(lowest, alpha);
      highest = Math.max(highest, alpha);
    }

    // Still half transparent across the whole patch rather than pulled toward either end.
    expect(lowest).toBeGreaterThan(118);
    expect(highest).toBeLessThan(138);
  });

  test('adds acutance to an edge the downscale softened', async () => {
    const source = await edgeAndGrainImage();
    const finished = await optimizeCover(source, WHOLE_FRAME);

    // The source is built from two flat levels, so it sits exactly on them.
    expect(await edgeOvershoot(source)).toEqual({ under: 40, over: 210 });

    const { under, over } = await edgeOvershoot(finished);
    expect(under).toBeLessThan(38);
    expect(over).toBeGreaterThan(212);
  });

  /**
   * m1: 0 is what keeps the dust specks and grain of a scan out of the sharpen. The same
   * probe run with sharp's default m1: 1 takes this field from 3.7 to 6.5, so the margin
   * below separates a finishing pass from a filter rather than merely passing.
   */
  test('does not amplify grain in a flat field', async () => {
    const grain = { left: 480, top: 300, width: 200, height: 200 };
    const source = await edgeAndGrainImage();
    const finished = await optimizeCover(source, WHOLE_FRAME);

    const before = (await regionRange(source, grain)).stdev;
    expect((await regionRange(finished, grain)).stdev).toBeLessThan(before * 1.2);
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
