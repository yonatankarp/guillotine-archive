const RGBA_CHANNELS = 4;
// The flood fill adds nine bytes per pixel (RGBA copy, visited bitmap, and queue).
// Eight million pixels keeps those working allocations below 72 MiB.
export const MAX_IMAGE_PIXELS = 8_000_000;

function validateInputs(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): number {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError('image width and height must be positive safe integers');
  }
  if (!Number.isInteger(threshold) || !Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError('white threshold must be a finite integer from 0 to 255');
  }

  const pixelCount = width * height;
  const byteCount = pixelCount * RGBA_CHANNELS;
  if (
    !Number.isSafeInteger(pixelCount)
    || !Number.isSafeInteger(byteCount)
    || pixelCount > MAX_IMAGE_PIXELS
  ) {
    throw new RangeError('image dimensions exceed the safe processing limit');
  }
  if (source.length !== byteCount) {
    throw new RangeError(`source must contain exactly ${byteCount} RGBA bytes`);
  }
  return pixelCount;
}

function isNearWhite(pixels: Uint8ClampedArray, pixel: number, threshold: number): boolean {
  const offset = pixel * RGBA_CHANNELS;
  return (
    pixels[offset]! >= threshold
    && pixels[offset + 1]! >= threshold
    && pixels[offset + 2]! >= threshold
  );
}

export function removeEdgeConnectedWhite(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 245,
): Uint8ClampedArray {
  const pixelCount = validateInputs(source, width, height, threshold);
  const pixels = new Uint8ClampedArray(source);
  const visited = new Uint8Array(pixelCount);
  const queue = new Uint32Array(pixelCount);
  let tail = 0;

  const enqueue = (pixel: number): void => {
    if (visited[pixel] === 1 || !isNearWhite(pixels, pixel, threshold)) return;
    visited[pixel] = 1;
    queue[tail] = pixel;
    tail += 1;
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  for (let head = 0; head < tail; head += 1) {
    const pixel = queue[head]!;
    pixels[pixel * RGBA_CHANNELS + 3] = 0;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }

  return pixels;
}
