import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_PIXELS,
  removeEdgeConnectedWhite,
} from '../../src/assets/remove-edge-white';

function image(
  rows: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>>,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  return {
    pixels: new Uint8ClampedArray(rows.flat(2)),
    width,
    height,
  };
}

const white = [255, 255, 255, 255] as const;
const nearWhite = [245, 246, 247, 183] as const;
const belowThreshold = [244, 255, 255, 201] as const;
const black = [0, 0, 0, 255] as const;

describe('removeEdgeConnectedWhite', () => {
  it('clears outside white while preserving enclosed white details and every RGB byte', () => {
    const { pixels, width, height } = image([
      [white, white, white, white, white],
      [white, black, black, black, white],
      [white, black, white, black, white],
      [white, black, black, black, white],
      [white, white, white, white, white],
    ]);
    const source = new Uint8ClampedArray(pixels);

    const result = removeEdgeConnectedWhite(pixels, width, height);

    expect(result[3]).toBe(0);
    expect(result[(2 * width + 2) * 4 + 3]).toBe(255);
    for (let offset = 0; offset < source.length; offset += 4) {
      expect(result.slice(offset, offset + 3)).toEqual(source.slice(offset, offset + 3));
    }
    expect(pixels).toEqual(source);
    expect(result).not.toBe(pixels);
  });

  it('uses four-connectivity so a diagonally touching enclosed white remains opaque', () => {
    const { pixels, width, height } = image([
      [white, black, black],
      [black, white, black],
      [black, black, black],
    ]);

    const result = removeEdgeConnectedWhite(pixels, width, height);

    expect(result[3]).toBe(0);
    expect(result[(width + 1) * 4 + 3]).toBe(255);
  });

  it('clears white connected to an open boundary and preserves it after the boundary closes', () => {
    const open = image([
      [black, white, black],
      [black, white, black],
      [black, black, black],
    ]);
    const closed = image([
      [black, black, black],
      [black, white, black],
      [black, black, black],
    ]);

    expect(
      removeEdgeConnectedWhite(open.pixels, open.width, open.height)[(open.width + 1) * 4 + 3],
    ).toBe(0);
    expect(
      removeEdgeConnectedWhite(closed.pixels, closed.width, closed.height)[
        (closed.width + 1) * 4 + 3
      ],
    ).toBe(255);
  });

  it('honors the inclusive threshold and leaves below-threshold pixels and alpha exact', () => {
    const { pixels, width, height } = image([[nearWhite, belowThreshold]]);

    const result = removeEdgeConnectedWhite(pixels, width, height, 245);

    expect(Array.from(result)).toEqual([
      245, 246, 247, 0,
      244, 255, 255, 201,
    ]);
  });

  it('handles a 1x1 image and narrow images without duplicate-queue side effects', () => {
    const single = removeEdgeConnectedWhite(new Uint8ClampedArray(white), 1, 1);
    const narrow = removeEdgeConnectedWhite(
      new Uint8ClampedArray([...white, ...nearWhite, ...black, ...white]),
      1,
      4,
    );

    expect(Array.from(single)).toEqual([255, 255, 255, 0]);
    expect([narrow[3], narrow[7], narrow[11], narrow[15]]).toEqual([0, 0, 255, 0]);
  });

  it('clears a moderate all-white image with bounded queue storage', () => {
    const width = 512;
    const height = 512;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);

    const result = removeEdgeConnectedWhite(pixels, width, height);

    expect(result.every((channel, index) => index % 4 !== 3 || channel === 0)).toBe(true);
    expect(pixels.every((channel) => channel === 255)).toBe(true);
  });

  it('preserves existing alpha for every pixel that is not cleared', () => {
    const pixels = new Uint8ClampedArray([
      0, 0, 0, 0,
      22, 33, 44, 91,
      255, 255, 255, 17,
    ]);

    const result = removeEdgeConnectedWhite(pixels, 3, 1);

    expect(Array.from(result)).toEqual([
      0, 0, 0, 0,
      22, 33, 44, 91,
      255, 255, 255, 0,
    ]);
  });

  it.each([
    ['zero width', 0, 1, 245],
    ['negative width', -1, 1, 245],
    ['fractional width', 1.5, 1, 245],
    ['infinite height', 1, Number.POSITIVE_INFINITY, 245],
    ['unsafe width', Number.MAX_SAFE_INTEGER + 1, 1, 245],
    ['negative threshold', 1, 1, -1],
    ['threshold above a byte', 1, 1, 256],
    ['fractional threshold', 1, 1, 244.5],
    ['non-finite threshold', 1, 1, Number.NaN],
  ])('rejects %s', (_label, width, height, threshold) => {
    expect(() => removeEdgeConnectedWhite(new Uint8ClampedArray(4), width, height, threshold)).toThrow(
      /positive safe integers|threshold/u,
    );
  });

  it('rejects dimensions whose RGBA byte count overflows safe integer arithmetic', () => {
    expect(() =>
      removeEdgeConnectedWhite(new Uint8ClampedArray(4), Number.MAX_SAFE_INTEGER, 2),
    ).toThrow(/dimensions/u);
  });

  it('accepts the explicit pixel cap before checking byte length and rejects one pixel above it', () => {
    expect(MAX_IMAGE_PIXELS).toBeGreaterThanOrEqual(1_000_000);
    expect(MAX_IMAGE_PIXELS).toBeLessThanOrEqual(16_000_000);
    expect(() => removeEdgeConnectedWhite(new Uint8ClampedArray(4), MAX_IMAGE_PIXELS, 1)).toThrow(
      new RegExp(`exactly ${MAX_IMAGE_PIXELS * 4} RGBA bytes`, 'u'),
    );
    expect(() =>
      removeEdgeConnectedWhite(new Uint8ClampedArray(4), MAX_IMAGE_PIXELS + 1, 1),
    ).toThrow(/safe processing limit/u);
  });

  it('rejects a source whose length does not exactly match the declared dimensions', () => {
    expect(() => removeEdgeConnectedWhite(new Uint8ClampedArray(7), 2, 1)).toThrow(
      /exactly 8 RGBA bytes/u,
    );
  });
});
