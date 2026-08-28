import type { MissingList } from './types';

/**
 * The owner's running list of what the archive still does not have. It is a native
 * Google Sheet, so it has no bytes to download: the Drive API renders it on demand
 * through files.export, and only a credentialed sync can ask for it.
 *
 * The sheet is matched by its stored path rather than by file id, because the id is
 * meaningless to a reader of this file and a renamed sheet should stop the export
 * loudly in the sync report rather than silently export the wrong document.
 */
export const MISSING_LIST_SOURCE_PATH = 'מה חסר?';
export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * CSV, not XLSX. Three reasons, in order of weight: it is the one export shape that
 * needs no parser beyond the splitter below, so no dependency joins the build graph;
 * XLSX would mean unzipping and reading worksheet XML by hand, untestable here because
 * this machine holds no Drive credential; and the sheet is one nine-year-old question.
 *
 * The cost is real and is not hidden: a CSV export is the FIRST tab only. If the owner
 * ever adds tabs, the sync report says so rather than the page quietly losing them.
 */
export const MISSING_LIST_EXPORT_MIME = 'text/csv';

/** An export is a few KB of text. Anything near a megabyte is not this list. */
export const MAX_MISSING_LIST_CSV_BYTES = 1024 * 1024;

/**
 * RFC 4180 with the leniency a real spreadsheet export needs: CRLF or LF, `""` for a
 * literal quote, and commas inside quoted fields. Hebrew rows with commas in them are
 * the normal case here, so a split on `,` would corrupt the list rather than fail.
 */
export function parseCsv(source: string): string[][] {
  // Drive prefixes its CSV export with a UTF-8 BOM. Glued to the first header cell it
  // is invisible in a diff and wrong on the page, so it is removed before anything else.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;

    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Every row is padded to one width so the rendered table cannot go ragged, and the page
 * never has to reason about a short row. Nothing is added, reordered or reworded: an
 * empty cell in the sheet stays an empty cell on the page.
 */
export function toMissingList(csv: string, generatedAt: string): MissingList {
  const grid = parseCsv(csv)
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell !== ''));
  const [header, ...rest] = grid;
  if (header === undefined) {
    return { generatedAt, sourcePath: MISSING_LIST_SOURCE_PATH, headerHe: [], rows: [] };
  }

  let width = Math.max(header.length, ...rest.map((row) => row.length));
  // A spreadsheet exports its used range, which can trail columns nobody ever filled in.
  while (width > 0 && [header, ...rest].every((row) => (row[width - 1] ?? '') === '')) {
    width -= 1;
  }

  if (width === 0) {
    return { generatedAt, sourcePath: MISSING_LIST_SOURCE_PATH, headerHe: [], rows: [] };
  }

  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_unused, column) => row[column] ?? '');

  return {
    generatedAt,
    sourcePath: MISSING_LIST_SOURCE_PATH,
    headerHe: pad(header),
    rows: rest.map(pad),
  };
}
