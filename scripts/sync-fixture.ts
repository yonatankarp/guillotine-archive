import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { buildCatalog as defaultBuildCatalog } from '../src/catalog/build';
import { loadCurator as defaultLoadCurator } from '../src/catalog/curator';
import {
  scanDrive as defaultScanDrive,
  type DriveGateway,
  type RemoteEntry,
} from '../src/catalog/drive-gateway';
import type { Catalog, CuratorConfig } from '../src/catalog/types';

interface FixtureDocument {
  rootId: string;
  children: Record<string, RemoteEntry[]>;
  docxText: Record<string, string>;
}

export interface SyncFixtureOptions {
  root?: string;
  fixturePath?: string;
  curatorPath?: string;
  generatedAt?: string;
  log?: (message: string) => void;
}

export interface SyncFixtureDependencies {
  buildCatalog?: typeof defaultBuildCatalog;
  loadCurator?: typeof defaultLoadCurator;
  scanDrive?: typeof defaultScanDrive;
}

const repositoryRoot = resolve(import.meta.dirname, '..');
// Fixture output is checked in CI and must remain reproducible across invocations.
export const FIXTURE_GENERATED_AT = '2026-08-26T00:00:00.000Z';

/**
 * Production cover IDs identify files outside the tiny local fixture tree. Fixture builds keep
 * every other editorial choice but deliberately exercise the site's honest fallback covers.
 */
export function omitProductionCoverSelections(
  curator: Readonly<CuratorConfig>,
): CuratorConfig {
  return {
    ...curator,
    collections: curator.collections.map(({ coverFileId: _coverFileId, ...collection }) => ({
      ...collection,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRemoteEntry(value: unknown): RemoteEntry {
  if (!isRecord(value)) throw new Error('fixture tree is invalid');
  const { id, name, mimeType } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof mimeType !== 'string') {
    throw new Error('fixture tree is invalid');
  }

  const optionalString = (field: string): string | null | undefined => {
    const candidate = value[field];
    if (candidate === undefined || candidate === null || typeof candidate === 'string') {
      return candidate as string | null | undefined;
    }
    throw new Error('fixture tree is invalid');
  };
  const parents = value.parents;
  if (
    parents !== undefined &&
    parents !== null &&
    (!Array.isArray(parents) || parents.some((parent) => typeof parent !== 'string'))
  ) {
    throw new Error('fixture tree is invalid');
  }

  return {
    id,
    name,
    mimeType,
    size: optionalString('size'),
    modifiedTime: optionalString('modifiedTime'),
    parents: parents as string[] | null | undefined,
    webViewLink: optionalString('webViewLink'),
    webContentLink: optionalString('webContentLink'),
  };
}

export function parseFixtureDocument(source: string): FixtureDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('fixture tree is invalid');
  }
  if (!isRecord(parsed) || typeof parsed.rootId !== 'string' || !isRecord(parsed.children)) {
    throw new Error('fixture tree is invalid');
  }
  if (!isRecord(parsed.docxText)) throw new Error('fixture tree is invalid');

  const children: Record<string, RemoteEntry[]> = {};
  for (const [folderId, entries] of Object.entries(parsed.children)) {
    if (!Array.isArray(entries)) throw new Error('fixture tree is invalid');
    children[folderId] = entries.map(parseRemoteEntry);
  }
  const docxText: Record<string, string> = {};
  for (const [fileId, text] of Object.entries(parsed.docxText)) {
    if (typeof text !== 'string') throw new Error('fixture tree is invalid');
    docxText[fileId] = text;
  }

  return { rootId: parsed.rootId, children, docxText };
}

const FIXTURE_ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

async function createDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  const options = { date: FIXTURE_ZIP_DATE, createFolders: false };
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    options,
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    options,
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>` +
      '<w:sectPr/></w:body></w:document>',
    options,
  );

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
  });
}

export function createFixtureGateway(fixture: Readonly<FixtureDocument>): DriveGateway {
  return {
    async listChildren(folderId) {
      return (fixture.children[folderId] ?? []).map((entry) => ({ ...entry }));
    },
    async download(fileId) {
      const text = fixture.docxText[fileId];
      if (text === undefined) throw new Error(`fixture download is unavailable for ${fileId}`);
      return createDocx(text);
    },
  };
}

export async function syncFixture(
  options: SyncFixtureOptions = {},
  dependencies: SyncFixtureDependencies = {},
): Promise<Catalog> {
  const root = options.root ?? repositoryRoot;
  const fixturePath = options.fixturePath ?? resolve(root, 'tests/fixtures/drive-tree.json');
  const curatorPath = options.curatorPath ?? resolve(root, 'curator/collections.yml');
  const generatedAt = options.generatedAt ?? FIXTURE_GENERATED_AT;
  const loadCurator = dependencies.loadCurator ?? defaultLoadCurator;
  const scanDrive = dependencies.scanDrive ?? defaultScanDrive;
  const buildCatalog = dependencies.buildCatalog ?? defaultBuildCatalog;
  const fixture = parseFixtureDocument(await readFile(fixturePath, 'utf8'));
  const gateway = createFixtureGateway(fixture);
  const files = await scanDrive(fixture.rootId, gateway);
  const curator = omitProductionCoverSelections(await loadCurator(curatorPath));
  const catalog = await buildCatalog({
    files,
    curator,
    root,
    generatedAt,
    minimumFileCount: 1,
    download: gateway.download,
  });

  (options.log ?? console.log)(`fixture sync complete: ${catalog.items.length} files`);
  return catalog;
}

function isDirectInvocation(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(moduleUrl);
}

export async function main(): Promise<void> {
  await syncFixture();
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'fixture sync failed');
    process.exitCode = 1;
  });
}
