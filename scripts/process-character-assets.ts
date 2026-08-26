import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS, removeEdgeConnectedWhite } from '../src/assets/remove-edge-white';

const USAGE = 'usage: npm run assets:characters -- --input SOURCE --output DESTINATION';
const FLAGS = new Set(['--input', '--output']);

export interface CharacterAssetPaths {
  input: string;
  output: string;
}

interface FileIdentity {
  canonicalPath: string;
  device: bigint;
  inode: bigint;
}

async function readFileIdentity(path: string): Promise<FileIdentity> {
  const [canonicalPath, metadata] = await Promise.all([
    realpath(path),
    stat(path, { bigint: true }),
  ]);
  return { canonicalPath, device: metadata.dev, inode: metadata.ino };
}

async function readOptionalFileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    return await readFileIdentity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isSameFile(first: FileIdentity, second: FileIdentity): boolean {
  return (
    first.canonicalPath === second.canonicalPath
    || (first.device === second.device && first.inode === second.inode)
  );
}

async function assertDifferentFiles(input: string, output: string): Promise<void> {
  const [inputIdentity, outputIdentity] = await Promise.all([
    readFileIdentity(input),
    readOptionalFileIdentity(output),
  ]);
  if (outputIdentity && isSameFile(inputIdentity, outputIdentity)) {
    throw new Error('input and output resolve to the same file');
  }
}

export function parseCharacterAssetArgs(args: readonly string[]): CharacterAssetPaths {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !FLAGS.has(flag)) {
      throw new Error(flag ? `unknown flag: ${flag}. ${USAGE}` : USAGE);
    }
    if (values.has(flag)) throw new Error(`duplicate flag: ${flag}. ${USAGE}`);
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}. ${USAGE}`);
    values.set(flag, value);
  }

  const input = values.get('--input');
  const output = values.get('--output');
  if (!input || !output) throw new Error(USAGE);

  const resolved = { input: resolve(input), output: resolve(output) };
  if (resolved.input === resolved.output) {
    throw new Error(`input and output must be different paths. ${USAGE}`);
  }
  return resolved;
}

export async function processCharacterAsset({ input, output }: CharacterAssetPaths): Promise<void> {
  const resolvedInput = resolve(input);
  const resolvedOutput = resolve(output);
  if (resolvedInput === resolvedOutput) throw new Error('input and output must be different paths');

  const outputDirectory = dirname(resolvedOutput);
  const temporaryOutput = resolve(
    outputDirectory,
    `.${basename(resolvedOutput)}.${process.pid}.${randomUUID()}.tmp.png`,
  );

  try {
    await assertDifferentFiles(resolvedInput, resolvedOutput);
    const decoded = await sharp(resolvedInput, {
      failOn: 'error',
      limitInputPixels: MAX_IMAGE_PIXELS,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const decodedPixels = new Uint8ClampedArray(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength,
    );
    const transparent = removeEdgeConnectedWhite(
      decodedPixels,
      decoded.info.width,
      decoded.info.height,
    );

    await mkdir(outputDirectory, { recursive: true });
    await sharp(Buffer.from(transparent), {
      raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
    })
      .png()
      .toFile(temporaryOutput);
    await rename(temporaryOutput, resolvedOutput);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown processing error';
    throw new Error(`could not process character image: ${detail}`, { cause });
  } finally {
    await unlink(temporaryOutput).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function main(): Promise<void> {
  const paths = parseCharacterAssetArgs(process.argv.slice(2));
  await processCharacterAsset(paths);
  console.log(`wrote ${paths.output}`);
}

function isDirectInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectInvocation()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'character asset processing failed');
    process.exitCode = 1;
  });
}
