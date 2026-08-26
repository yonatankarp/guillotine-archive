import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  parseCharacterAssetArgs,
  processCharacterAsset,
} from '../../scripts/process-character-assets';

const executeFile = promisify(execFile);

describe('parseCharacterAssetArgs', () => {
  it('accepts each documented flag exactly once in either order', () => {
    expect(parseCharacterAssetArgs(['--input', './source.gif', '--output', './asset.png'])).toEqual({
      input: resolve('./source.gif'),
      output: resolve('./asset.png'),
    });
    expect(parseCharacterAssetArgs(['--output', './asset.png', '--input', './source.gif'])).toEqual({
      input: resolve('./source.gif'),
      output: resolve('./asset.png'),
    });
  });

  it.each([
    { args: [] },
    { args: ['--input', 'source.gif'] },
    { args: ['--output', 'asset.png'] },
    { args: ['--input'] },
    { args: ['--input', '--output', 'asset.png'] },
    { args: ['source.gif', '--output', 'asset.png'] },
    { args: ['--source', 'source.gif', '--output', 'asset.png'] },
    { args: ['--input', 'one.gif', '--input', 'two.gif', '--output', 'asset.png'] },
    { args: ['--input', 'source.gif', '--output', 'one.png', '--output', 'two.png'] },
    { args: ['--input', '', '--output', 'asset.png'] },
  ])('rejects malformed arguments: $args', ({ args }) => {
    expect(() => parseCharacterAssetArgs(args)).toThrow(/usage|unknown|duplicate|value/u);
  });

  it('rejects the same resolved input and output path', () => {
    expect(() => parseCharacterAssetArgs(['--input', './same.png', '--output', 'same.png'])).toThrow(
      /must be different/u,
    );
  });
});

describe('processCharacterAsset', () => {
  it('creates a transparent PNG in a missing parent directory without changing RGB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-'));
    const input = join(directory, 'source.png');
    const output = join(directory, 'nested', 'character.png');
    const source = Buffer.from([
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]);
    await sharp(source, { raw: { width: 3, height: 3, channels: 4 } }).png().toFile(input);

    await processCharacterAsset({ input, output });

    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 3, height: 3, channels: 4 });
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[(3 + 1) * 4 + 3]).toBe(255);
    for (let offset = 0; offset < source.length; offset += 4) {
      expect(decoded.data.subarray(offset, offset + 3)).toEqual(source.subarray(offset, offset + 3));
    }
  });

  it('leaves an existing destination intact and cleans temporary siblings when decoding fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-failure-'));
    const input = join(directory, 'broken.gif');
    const output = join(directory, 'hezi.png');
    const existing = Buffer.from('existing output');
    await writeFile(input, 'not an image');
    await writeFile(output, existing);

    await expect(processCharacterAsset({ input, output })).rejects.toThrow(/character image/u);

    expect(await readFile(output)).toEqual(existing);
    expect((await readdir(directory)).sort()).toEqual(['broken.gif', 'hezi.png']);
  });

  it.each([
    { kind: 'symbolic link', createAlias: symlink },
    { kind: 'hard link', createAlias: link },
  ])('rejects an output $kind that identifies the input file', async ({ createAlias }) => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-alias-'));
    const input = join(directory, 'source.png');
    const output = join(directory, 'alias.png');
    const source = Buffer.from('source must survive');
    await writeFile(input, source);
    await createAlias(input, output);

    await expect(processCharacterAsset({ input, output })).rejects.toThrow(/same file/u);

    expect(await readFile(input)).toEqual(source);
  });

  it('rejects a case-only output alias on case-insensitive filesystems', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-case-'));
    const input = join(directory, 'Character.png');
    const output = join(directory, 'character.png');
    const source = Buffer.from('source must survive');
    await writeFile(input, source);

    const [inputStat, outputStat] = await Promise.all([stat(input), stat(output).catch(() => null)]);
    if (!outputStat || inputStat.dev !== outputStat.dev || inputStat.ino !== outputStat.ino) return;

    await expect(processCharacterAsset({ input, output })).rejects.toThrow(/same file/u);
    expect(await readFile(input)).toEqual(source);
  });

  it('atomically replaces an unrelated output symlink without changing its target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-output-link-'));
    const input = join(directory, 'source.png');
    const target = join(directory, 'unrelated.txt');
    const output = join(directory, 'character.png');
    const source = Buffer.from([255, 255, 255, 255]);
    const targetContents = Buffer.from('must not be overwritten');
    await sharp(source, { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(input);
    await writeFile(target, targetContents);
    await symlink(target, output);

    await processCharacterAsset({ input, output });

    expect(await readFile(target)).toEqual(targetContents);
    expect((await lstat(output)).isSymbolicLink()).toBe(false);
    expect(Array.from(await sharp(output).raw().toBuffer())).toEqual([255, 255, 255, 0]);
  });

  it('executes normally when the CLI script itself is invoked through a symbolic link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'guillotine-character-cli-link-'));
    const script = join(directory, 'character-cli.ts');
    const input = join(directory, 'source.png');
    const output = join(directory, 'output.png');
    const source = Buffer.from([255, 255, 255, 255]);
    await symlink(resolve('scripts/process-character-assets.ts'), script);
    await sharp(source, { raw: { width: 1, height: 1, channels: 4 } }).png().toFile(input);

    await executeFile(resolve('node_modules/.bin/tsx'), [
      script,
      '--input',
      input,
      '--output',
      output,
    ]);

    const decoded = await sharp(output).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 1, height: 1, channels: 4 });
    expect(Array.from(decoded.data)).toEqual([255, 255, 255, 0]);
  });

  it('has no processing side effects when imported', async () => {
    const scriptUrl = pathToFileURL(resolve('scripts/process-character-assets.ts')).href;

    const result = await executeFile(resolve('node_modules/.bin/tsx'), [
      '--eval',
      `import(${JSON.stringify(scriptUrl)})`,
    ]);

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
