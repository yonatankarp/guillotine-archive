import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { buildCatalog } from '../../src/catalog/build';
import {
  GOOGLE_SHEET_MIME,
  MISSING_LIST_SOURCE_PATH,
  parseCsv,
  toMissingList,
} from '../../src/catalog/missing-list';
import type { CuratorConfig, DriveFile } from '../../src/catalog/types';
import { parseMissingList } from '../../src/lib/catalog';

const curator: CuratorConfig = { minimumFileCount: 1, collections: [] };
const GENERATED_AT = '2026-08-26T12:00:00.000Z';

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'guillotine-missing-list-'));
  for (const directory of ['src/generated', 'public/data', 'reports']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  return root;
}

function sheetFile(overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: 'sheet',
    name: MISSING_LIST_SOURCE_PATH,
    mimeType: GOOGLE_SHEET_MIME,
    size: null,
    modifiedTime: '2017-09-27T19:09:37.182Z',
    path: MISSING_LIST_SOURCE_PATH,
    viewUrl: 'https://docs.google.com/spreadsheets/d/sheet/edit',
    downloadUrl: null,
    ...overrides,
  };
}

function otherFile(): DriveFile {
  return {
    id: 'page',
    name: 'page.jpg',
    mimeType: 'image/jpeg',
    size: 4096,
    modifiedTime: '2026-08-26T10:00:00.000Z',
    path: 'עיתונות/כתבות/page.jpg',
    viewUrl: 'https://drive.google.com/file/d/page/view',
    downloadUrl: 'https://drive.google.com/uc?export=download&id=page',
  };
}

async function missingListArtifact(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, 'src/generated/missing-list.json'), 'utf8');
  } catch {
    return null;
  }
}

async function report(root: string): Promise<{ warnings: string[]; errors: string[] }> {
  return JSON.parse(await readFile(join(root, 'reports/curator-report.json'), 'utf8')) as {
    warnings: string[];
    errors: string[];
  };
}

describe('parseCsv', () => {
  test('keeps a comma inside a quoted field in the cell it belongs to', () => {
    expect(parseCsv('פריט,הערה\r\n"קופסה, פתוחה",נו\r\n')).toEqual([
      ['פריט', 'הערה'],
      ['קופסה, פתוחה', 'נו'],
    ]);
  });

  test('reads a doubled quote as one literal quote', () => {
    expect(parseCsv('a,"say ""hi""",b')).toEqual([['a', 'say "hi"', 'b']]);
  });

  test('reads a newline inside a quoted field as part of the cell', () => {
    expect(parseCsv('a,"one\ntwo"')).toEqual([['a', 'one\ntwo']]);
  });

  test.each([
    ['LF', 'a,b\nc,d'],
    ['CRLF', 'a,b\r\nc,d'],
    ['CR', 'a,b\rc,d'],
  ])('splits rows on %s line endings', (_description, source) => {
    expect(parseCsv(source)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  /* Drive prefixes its CSV export with a BOM. Left in place it glues to the first header
     cell, where it is invisible in a diff and wrong on the page. */
  test('strips the byte order mark Drive puts in front of the export', () => {
    expect(parseCsv('﻿פריט,הערה')).toEqual([['פריט', 'הערה']]);
  });

  test('keeps an empty cell empty rather than dropping it', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});

describe('toMissingList', () => {
  test('takes the first row as the header and pads every row to its width', () => {
    const list = toMissingList('פריט,הערה,מי\nקופסה\nדיסק,שרוט,יוסי', GENERATED_AT);

    expect(list).toEqual({
      generatedAt: GENERATED_AT,
      sourcePath: MISSING_LIST_SOURCE_PATH,
      headerHe: ['פריט', 'הערה', 'מי'],
      rows: [
        ['קופסה', '', ''],
        ['דיסק', 'שרוט', 'יוסי'],
      ],
    });
  });

  test('widens the header when a row carries more cells than it does', () => {
    const list = toMissingList('פריט\nדיסק,שרוט', GENERATED_AT);

    expect(list.headerHe).toEqual(['פריט', '']);
    expect(list.rows).toEqual([['דיסק', 'שרוט']]);
  });

  test('drops the trailing columns a spreadsheet exports and nobody filled in', () => {
    const list = toMissingList('פריט,הערה,,\nדיסק,שרוט,,', GENERATED_AT);

    expect(list.headerHe).toEqual(['פריט', 'הערה']);
    expect(list.rows).toEqual([['דיסק', 'שרוט']]);
  });

  test.each([
    ['nothing at all', ''],
    ['only blank rows', ',,\n,,\n'],
  ])('reports an empty list for a sheet holding %s', (_description, csv) => {
    expect(toMissingList(csv, GENERATED_AT).headerHe).toEqual([]);
    expect(toMissingList(csv, GENERATED_AT).rows).toEqual([]);
  });

  test('writes a document the strict runtime schema accepts', () => {
    const list = toMissingList('פריט,הערה\n"קופסה, פתוחה",\n', GENERATED_AT);

    expect(parseMissingList(JSON.stringify(list))).toEqual(list);
  });
});

describe('exporting the missing list during a build', () => {
  test('exports the sheet as CSV and writes the rows as a separate artifact', async () => {
    const root = await temporaryRoot();
    const exportSheet = vi.fn(async () => Buffer.from('﻿פריט,הערה\nקופסה,נו\n', 'utf8'));

    await buildCatalog({
      files: [sheetFile(), otherFile()],
      curator,
      root,
      generatedAt: GENERATED_AT,
      download: async () => Buffer.alloc(0),
      exportSheet,
    });

    expect(exportSheet).toHaveBeenCalledWith('sheet', 'text/csv');
    expect(parseMissingList((await missingListArtifact(root))!)).toEqual({
      generatedAt: GENERATED_AT,
      sourcePath: MISSING_LIST_SOURCE_PATH,
      headerHe: ['פריט', 'הערה'],
      rows: [['קופסה', 'נו']],
    });
  });

  /* A CSV export is the first tab and nothing else. Nobody can see a lost second tab in
     the committed rows, so every sync has to say it in the census. */
  test('says in the report that only the first tab was exported', async () => {
    const root = await temporaryRoot();

    await buildCatalog({
      files: [sheetFile(), otherFile()],
      curator,
      root,
      generatedAt: GENERATED_AT,
      download: async () => Buffer.alloc(0),
      exportSheet: async () => Buffer.from('פריט\nקופסה\n', 'utf8'),
    });

    expect((await report(root)).warnings).toContain(
      'missing list exported as CSV: 1 rows from the first tab of the sheet only',
    );
  });

  /*
   * The committed rows are the whole feature and only a credentialed sync can rebuild
   * them, so every path that cannot export leaves the artifact alone. Writing an empty
   * document instead would blank the page on the first offline build, which is how this
   * archive once lost every cover.
   */
  test.each([
    [
      'no export seam is available',
      {} as { exportSheet?: () => Promise<Buffer> },
    ],
    [
      'the export fails',
      {
        exportSheet: async () => {
          throw new Error('Drive file export failed');
        },
      },
    ],
    [
      'the export is far too large to be that list',
      { exportSheet: async () => Buffer.alloc(2 * 1024 * 1024, 'a') },
    ],
    [
      'the sheet exports no rows',
      { exportSheet: async () => Buffer.from('\n\n', 'utf8') },
    ],
  ])('leaves the committed rows untouched when %s', async (_description, overrides) => {
    const root = await temporaryRoot();
    const committed = JSON.stringify({
      generatedAt: '2026-01-01T00:00:00.000Z',
      sourcePath: MISSING_LIST_SOURCE_PATH,
      headerHe: ['פריט'],
      rows: [['הקופסה של פעם']],
    });
    await writeFile(join(root, 'src/generated/missing-list.json'), committed, 'utf8');

    await buildCatalog({
      files: [sheetFile(), otherFile()],
      curator,
      root,
      generatedAt: GENERATED_AT,
      download: async () => Buffer.alloc(0),
      ...overrides,
    });

    expect(await missingListArtifact(root)).toBe(committed);
  });

  test('leaves the committed rows untouched and says so when the sheet is gone', async () => {
    const root = await temporaryRoot();
    const exportSheet = vi.fn(async () => Buffer.from('פריט\nקופסה\n', 'utf8'));

    await buildCatalog({
      files: [otherFile()],
      curator,
      root,
      generatedAt: GENERATED_AT,
      download: async () => Buffer.alloc(0),
      exportSheet,
    });

    expect(exportSheet).not.toHaveBeenCalled();
    expect(await missingListArtifact(root)).toBeNull();
    expect((await report(root)).warnings).toContain(
      `no sheet at ${MISSING_LIST_SOURCE_PATH}, so the committed missing list was left as it was`,
    );
  });
});
