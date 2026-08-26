import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { processCharacterAsset } from '../../scripts/process-character-assets';

const ASSET_PATH = 'public/assets/characters/hezi.png';
const EXPECTED_RGB_SHA256 = '3287651a094a1d628e75d487f60a280b1f237dc1cba5084f24228fff3a05228e';
const EXPECTED_PNG_SHA256 = '98feedabe37a3b5ddc3921bc1436bd0f5c532e4bc68f7f34df8babfad50430e2';
const EXPECTED_FIXTURE_PNG_SHA256 = '68939725a2cba81bc31a9159eab0d7c2641a76709e5618c3065cacd707d1978e';

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('faithful Hezi character asset', () => {
  it('keeps the original dimensions and every decoded RGB byte', async () => {
    const { data, info } = await sharp(ASSET_PATH).raw().toBuffer({ resolveWithObject: true });
    const rgb = Buffer.alloc(info.width * info.height * 3);
    for (let source = 0, destination = 0; source < data.length; source += 4) {
      rgb[destination++] = data[source]!;
      rgb[destination++] = data[source + 1]!;
      rgb[destination++] = data[source + 2]!;
    }

    expect(info).toMatchObject({ width: 145, height: 365, channels: 4 });
    expect(hash(rgb)).toBe(EXPECTED_RGB_SHA256);
  });

  it('clears the outside while retaining opaque eyes, teeth, trousers, and colored fragments', async () => {
    const { data, info } = await sharp(ASSET_PATH).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) =>
      data.subarray((y * info.width + x) * 4, (y * info.width + x + 1) * 4);

    for (const [x, y] of [[0, 0], [144, 0], [0, 364], [144, 364]] as const) {
      expect(pixel(x, y)[3]).toBe(0);
    }
    for (const [x, y] of [[45, 49], [69, 53], [53, 79], [65, 221]] as const) {
      expect(Array.from(pixel(x, y))).toEqual([255, 255, 255, 255]);
    }
    expect(Array.from(pixel(70, 130))).toEqual([82, 189, 239, 255]);

    let opaque = 0;
    let transparent = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] === 0) transparent += 1;
      if (data[offset + 3]! > 0) opaque += 1;
      if (data[offset]! < 245 || data[offset + 1]! < 245 || data[offset + 2]! < 245) {
        expect(data[offset + 3]).toBe(255);
      }
    }
    expect({ opaque, transparent }).toEqual({ opaque: 19_462, transparent: 33_463 });
  });

  it('is byte-for-byte deterministic across repeated GIF decoding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-determinism-'));
    const input = join(directory, 'source.gif');
    const first = join(directory, 'first.png');
    const second = join(directory, 'second.png');
    const encoded = await readFile('tests/fixtures/character-source.gif.b64', 'utf8');
    await writeFile(input, Buffer.from(encoded.trim(), 'base64'));

    await processCharacterAsset({ input, output: first });
    await processCharacterAsset({ input, output: second });

    expect(hash(await readFile(ASSET_PATH))).toBe(EXPECTED_PNG_SHA256);
    expect(await readFile(first)).toEqual(await readFile(second));
    expect(hash(await readFile(first))).toBe(EXPECTED_FIXTURE_PNG_SHA256);
    const decoded = await sharp(first).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 5, height: 5, channels: 4 });
    const transparentWhite = [255, 255, 255, 0];
    const opaqueWhite = [255, 255, 255, 255];
    const black = [0, 0, 0, 255];
    const blue = [0, 128, 255, 255];
    const expected = [
      [transparentWhite, transparentWhite, transparentWhite, transparentWhite, transparentWhite],
      [transparentWhite, black, black, black, transparentWhite],
      [transparentWhite, black, opaqueWhite, black, transparentWhite],
      [transparentWhite, black, blue, black, transparentWhite],
      [transparentWhite, transparentWhite, transparentWhite, transparentWhite, transparentWhite],
    ].flat(2);
    expect(Array.from(decoded.data)).toEqual(expected);
  });
});
