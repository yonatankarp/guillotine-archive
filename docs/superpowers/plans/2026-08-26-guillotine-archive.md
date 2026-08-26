# Guillotine Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Hebrew RTL static archive website that synchronizes public Google Drive metadata daily, creates curated interlinked game pages, supports Hebrew search, and deploys safely to GitHub Pages.

**Architecture:** Astro pre-renders the public pages from a generated catalog. A TypeScript synchronization pipeline reads Drive through a read-only adapter, applies version-controlled curator rules, extracts supported Hebrew text, optimizes selected covers, and writes deterministic catalog and MiniSearch artifacts. GitHub Actions runs that pipeline daily, validates it, and deploys only successful builds.

**Tech Stack:** Node.js 22, Astro 7, TypeScript 6, Zod 4, Google APIs client, MiniSearch 7, Mammoth, html-to-text, Sharp, Vitest 4, Playwright 1.62, axe-core, GitHub Actions, GitHub Pages.

---

## File structure

The implementation creates these focused units:

```text
.
├── .github/workflows/deploy-pages.yml       # Daily sync, validation, build, deployment
├── curator/collections.yml                  # Editorial collections and relationship rules
├── docs/setup-google-drive.md                # Owner setup guide
├── public/
│   ├── assets/characters/hezi.png            # Processed original character asset
│   └── data/search-index.json                # Generated serialized search index
├── reports/                                  # Generated curator and sync reports
├── scripts/
│   ├── process-character-assets.ts           # Edge-connected white removal
│   ├── sync-drive.ts                         # Production Drive entry point
│   └── sync-fixture.ts                       # Deterministic local entry point
├── src/
│   ├── assets/remove-edge-white.ts           # Pixel-safe transparency algorithm
│   ├── catalog/
│   │   ├── build.ts                          # Catalog orchestration and artifact writes
│   │   ├── curator.ts                        # YAML parsing and validation
│   │   ├── drive-gateway.ts                  # Drive interface and recursive traversal
│   │   ├── google-drive.ts                   # Google API implementation
│   │   ├── media.ts                          # Text extraction and cover optimization
│   │   ├── relationships.ts                  # Include, exclude, and link resolution
│   │   ├── search.ts                         # Hebrew normalization and MiniSearch build
│   │   ├── types.ts                          # Shared domain types
│   │   └── validate.ts                       # Blocking and reporting validation
│   ├── components/
│   │   ├── ArchiveSearch.astro               # Search form and result container
│   │   ├── FileList.astro                    # Drive actions and file metadata
│   │   ├── GameTile.astro                    # Cover-first homepage tile
│   │   └── Header.astro                      # RTL primary navigation
│   ├── generated/catalog.json                # Generated catalog, ignored by Git
│   ├── layouts/BaseLayout.astro              # Shared page shell and metadata
│   ├── lib/catalog.ts                        # Typed accessors for generated data
│   ├── lib/url.ts                            # GitHub Pages base-path handling
│   ├── pages/
│   │   ├── about.astro
│   │   ├── archive/[category].astro
│   │   ├── archive/index.astro
│   │   ├── games/[slug].astro
│   │   ├── games/index.astro
│   │   ├── index.astro
│   │   └── search.astro
│   ├── scripts/search-client.ts              # Browser-only search behavior
│   └── styles/global.css                     # Modern Piposh design system
├── tests/
│   ├── assets/remove-edge-white.test.ts
│   ├── catalog/build.test.ts
│   ├── catalog/curator.test.ts
│   ├── catalog/drive-gateway.test.ts
│   ├── catalog/media.test.ts
│   ├── catalog/relationships.test.ts
│   ├── catalog/search.test.ts
│   ├── e2e/archive.spec.ts
│   ├── fixtures/drive-tree.json
│   └── workflows/deploy-pages.test.ts
├── astro.config.ts
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── vitest.config.ts
```

This remains one plan because the Drive adapter, curator, search index, and static routes share one catalog contract and one deployment gate. Splitting them would require temporary duplicate schemas and would not produce independently useful releases.

### Task 1: Scaffold the static Astro project and quality gates

**Files:**
- Create: `package.json`
- Create: `astro.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `.gitignore`
- Create: `src/env.d.ts`
- Create: `src/pages/index.astro`

- [ ] **Step 1: Create the package manifest**

Create `package.json` with pinned direct dependencies:

```json
{
  "name": "guillotine-archive",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12 <23"
  },
  "scripts": {
    "dev": "astro dev",
    "build": "astro check && astro build",
    "preview": "astro preview",
    "check": "astro check",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "sync:fixture": "tsx scripts/sync-fixture.ts",
    "sync:drive": "tsx scripts/sync-drive.ts",
    "assets:characters": "tsx scripts/process-character-assets.ts"
  },
  "dependencies": {
    "@astrojs/check": "0.9.10",
    "astro": "7.2.7",
    "googleapis": "176.0.0",
    "html-to-text": "10.0.1",
    "mammoth": "1.12.1",
    "minisearch": "7.2.0",
    "sharp": "0.35.3",
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@axe-core/playwright": "4.13.0",
    "@playwright/test": "1.62.1",
    "@types/html-to-text": "9.0.4",
    "@types/node": "22.20.1",
    "tsx": "4.23.12",
    "typescript": "6.0.3",
    "vitest": "4.1.11"
  }
}
```

- [ ] **Step 2: Install dependencies and browser runtime**

Run:

```bash
npm install
npx playwright install chromium
```

Expected: `package-lock.json` is created and both commands exit 0.

- [ ] **Step 3: Add framework and test configuration**

Create `astro.config.ts`:

```ts
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  base: process.env.BASE_PATH ?? '/',
});
```

Create `tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": [".astro/types.d.ts", "src", "scripts", "tests", "astro.config.ts", "vitest.config.ts", "playwright.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] },
  },
});
```

Create `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
```

Create `src/env.d.ts`:

```ts
/// <reference types="astro/client" />
```

- [ ] **Step 4: Add the first buildable page**

Create `src/pages/index.astro`:

```astro
---
const title = 'ארכיון גיליוטין';
---

<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>{title}</title>
  </head>
  <body>
    <main>
      <h1>{title}</h1>
    </main>
  </body>
</html>
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
.astro/
coverage/
playwright-report/
test-results/
.env*
!.env.example
.DS_Store
reports/*.json
public/generated/
public/data/search-index.json
src/generated/catalog.json
```

- [ ] **Step 5: Run the initial quality gates**

Run:

```bash
npm run check
npm run build
```

Expected: both commands exit 0 and `dist/index.html` exists.

- [ ] **Step 6: Commit the scaffold**

```bash
git add package.json package-lock.json astro.config.ts tsconfig.json vitest.config.ts playwright.config.ts .gitignore src
git commit -m "build: scaffold static Astro archive"
```

### Task 2: Define and validate curator data

**Files:**
- Create: `src/catalog/types.ts`
- Create: `src/catalog/curator.ts`
- Create: `tests/catalog/curator.test.ts`

- [ ] **Step 1: Write the failing curator schema test**

Create `tests/catalog/curator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCurator } from '../../src/catalog/curator';

describe('parseCurator', () => {
  it('parses a Hebrew collection with an official release rule', () => {
const result = parseCurator(`
minimumFileCount: 1000
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    year: 1999
    summaryHe: המשחק המקורי
    aliasesHe: [פיפוש הראשון]
    tagsHe: [הרפתקה]
    rules:
      - match: path-prefix
        value: משחקים מלאים/פיפוש 1
        relationship: part-of-release
`);

    expect(result.collections[0]?.slug).toBe('piposh-1');
    expect(result.collections[0]?.rules[0]?.relationship).toBe('part-of-release');
    expect(result.minimumFileCount).toBe(1000);
  });

  it('rejects duplicate collection slugs', () => {
    const source = `
collections:
  - { slug: piposh-1, titleHe: פיפוש 1, type: game, summaryHe: א, rules: [] }
  - { slug: piposh-1, titleHe: פיפוש שוב, type: game, summaryHe: ב, rules: [] }
`;
    expect(() => parseCurator(source)).toThrow(/duplicate collection slug: piposh-1/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/catalog/curator.test.ts`

Expected: FAIL because `src/catalog/curator.ts` does not exist.

- [ ] **Step 3: Add shared domain types**

Create `src/catalog/types.ts`:

```ts
export type RelationshipKind = 'part-of-release' | 'about' | 'inspired-by';
export type RuleMatch = 'path-prefix' | 'exact-path' | 'file-id';

export interface CuratorRule {
  match: RuleMatch;
  value: string;
  relationship: RelationshipKind;
  groupHe?: string;
}

export interface CuratedCollection {
  slug: string;
  titleHe: string;
  type: 'game' | 'music' | 'press' | 'fan' | 'archive';
  year?: number;
  summaryHe: string;
  descriptionHe?: string;
  coverFileId?: string;
  aliasesHe: string[];
  tagsHe: string[];
  rules: CuratorRule[];
  exclude: CuratorRule[];
}

export interface CuratorConfig {
  minimumFileCount?: number;
  collections: CuratedCollection[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  path: string;
  parentIds: string[];
  viewUrl: string;
  downloadUrl: string | null;
}

export interface CollectionLink {
  slug: string;
  titleHe: string;
  relationship: RelationshipKind;
  groupHe?: string;
}

export interface CatalogItem extends DriveFile {
  category: string;
  titleHe?: string;
  descriptionHe?: string;
  aliasesHe: string[];
  tagsHe: string[];
  extractedTextHe: string;
  collectionLinks: CollectionLink[];
}

export interface CatalogCollection extends CuratedCollection {
  coverUrl: string | null;
  itemIds: string[];
}

export interface Catalog {
  generatedAt: string;
  collections: CatalogCollection[];
  items: CatalogItem[];
  categories: string[];
}
```

- [ ] **Step 4: Implement strict YAML parsing**

Create `src/catalog/curator.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import type { CuratorConfig } from './types';

const ruleSchema = z.object({
  match: z.enum(['path-prefix', 'exact-path', 'file-id']),
  value: z.string().min(1),
  relationship: z.enum(['part-of-release', 'about', 'inspired-by']),
  groupHe: z.string().min(1).optional(),
});

const collectionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  titleHe: z.string().min(1),
  type: z.enum(['game', 'music', 'press', 'fan', 'archive']),
  year: z.number().int().min(1980).max(2100).optional(),
  summaryHe: z.string().min(1),
  descriptionHe: z.string().min(1).optional(),
  coverFileId: z.string().min(1).optional(),
  aliasesHe: z.array(z.string().min(1)).default([]),
  tagsHe: z.array(z.string().min(1)).default([]),
  rules: z.array(ruleSchema).default([]),
  exclude: z.array(ruleSchema).default([]),
});

const curatorSchema = z.object({
  minimumFileCount: z.number().int().positive().default(1),
  collections: z.array(collectionSchema),
});

export function parseCurator(source: string): CuratorConfig {
  const result = curatorSchema.parse(parse(source));
  const seen = new Set<string>();
  for (const collection of result.collections) {
    if (seen.has(collection.slug)) {
      throw new Error(`duplicate collection slug: ${collection.slug}`);
    }
    seen.add(collection.slug);
  }
  return result;
}

export async function loadCurator(path: string): Promise<CuratorConfig> {
  return parseCurator(await readFile(path, 'utf8'));
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/catalog/curator.test.ts`

Expected: 2 tests pass.

```bash
git add src/catalog/types.ts src/catalog/curator.ts tests/catalog/curator.test.ts
git commit -m "feat: validate curator collection rules"
```

### Task 3: Scan Google Drive behind a testable gateway

**Files:**
- Create: `src/catalog/drive-gateway.ts`
- Create: `src/catalog/google-drive.ts`
- Create: `tests/catalog/drive-gateway.test.ts`

- [ ] **Step 1: Write failing scanner and adapter tests**

Cover stable Hebrew paths, breadth-first traversal, folder-cycle prevention (each folder ID is listed once), duplicate file-ID rejection with both paths, and download policy. Folders stay out of results; Google-native files and shortcuts are always view-only (`downloadUrl: null`), even when a gateway supplies a content link; ordinary files preserve provided content links. Shortcuts are not followed.

Exercise the production request logic through an injected structural `files` client: two-page listing, escaped backslashes/apostrophes in parent queries, exact fields/order/page size, Shared Drive flags, malformed response failure, and media-byte download behavior.

- [ ] **Step 2: Implement `scanDrive` identity and download behavior**

Seed a visited-folder ID set with the root and only enqueue unseen folders. Track emitted file IDs with membership checks (including empty paths) and fail with the duplicate ID and both paths. Preserve remote metadata and view URLs; MIME types starting `application/vnd.google-apps.` are view-only before any content-link consideration. Ordinary binaries preserve a supplied content link or receive the `/uc?export=download&id=` fallback.

- [ ] **Step 3: Implement the production Drive adapter behind an injection seam**

`createGoogleDriveGateway` parses credentials, creates read-only auth, creates the v3 client, and delegates to `createDriveGatewayFromFilesClient`. The latter paginates `files.list` with exact parent filtering, escaped IDs, requested metadata fields, `orderBy: 'folder,name'`, `pageSize: 1000`, `supportsAllDrives: true`, and `includeItemsFromAllDrives: true`. It must fail fast on records missing `id`, `name`, or `mimeType`, rather than skipping them. Downloads use `alt: 'media'`, `supportsAllDrives: true`, and `arraybuffer` responses.

- [ ] **Step 4: Verify and commit the Drive boundary**

```bash
npm test -- tests/catalog/drive-gateway.test.ts
npm test
npm run check
npx tsc --noEmit
git diff --check
git add src/catalog/drive-gateway.ts src/catalog/google-drive.ts tests/catalog/drive-gateway.test.ts docs/superpowers/plans/2026-08-26-guillotine-archive.md
git commit -m "feat: add read-only Drive scanner"
```

### Task 4: Extract searchable text and optimize selected covers

**Files:**
- Create: `src/catalog/media.ts`
- Create: `tests/catalog/media.test.ts`

- [ ] **Step 1: Write failing media tests**

Create `tests/catalog/media.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extractText, isTextExtractable, optimizeCover } from '../../src/catalog/media';

describe('media processing', () => {
  it('extracts readable text from HTML', async () => {
    const html = Buffer.from('<h1>פיפוש</h1><p>פתרון מלא למשחק</p>');
    await expect(extractText('text/html', 'guide.html', html)).resolves.toContain('פתרון מלא');
  });

  it('decodes preserved Windows-1255 Hebrew HTML', async () => {
    const html = Buffer.concat([
      Buffer.from('<meta charset="windows-1255"><p>', 'ascii'),
      Buffer.from([0xf4, 0xe9, 0xf4, 0xe5, 0xf9]),
      Buffer.from('</p>', 'ascii'),
    ]);
    await expect(extractText('text/html', 'old-site.html', html)).resolves.toContain('פיפוש');
  });

  it('does not mark game binaries as text extractable', () => {
    expect(isTextExtractable('application/x-msdownload', 'piposh.exe', 10)).toBe(false);
  });

  it('creates a bounded WebP cover', async () => {
    const source = await sharp({
      create: { width: 1200, height: 1800, channels: 3, background: '#ff00aa' },
    }).png().toBuffer();
    const output = await optimizeCover(source);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBeLessThanOrEqual(720);
    expect(metadata.height).toBeLessThanOrEqual(960);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/catalog/media.test.ts`

Expected: FAIL because `src/catalog/media.ts` does not exist.

- [ ] **Step 3: Implement bounded text and cover processing**

Create `src/catalog/media.ts`:

```ts
import { htmlToText } from 'html-to-text';
import mammoth from 'mammoth';
import sharp from 'sharp';

const MAX_TEXT_BYTES = 10 * 1024 * 1024;

function decodeSource(data: Buffer): string {
  const head = data.subarray(0, 2048).toString('latin1');
  const charset = /charset=["']?\s*([^"'\s/>]+)/iu.exec(head)?.[1]?.toLocaleLowerCase('en');
  const encoding = charset === 'windows-1255' || charset === 'iso-8859-8' ? charset : 'utf-8';
  return new TextDecoder(encoding).decode(data);
}

export function isTextExtractable(mimeType: string, name: string, size: number | null): boolean {
  if (size !== null && size > MAX_TEXT_BYTES) return false;
  const lowerName = name.toLocaleLowerCase('en');
  return mimeType.startsWith('text/') || lowerName.endsWith('.txt') || lowerName.endsWith('.html') || lowerName.endsWith('.htm') || lowerName.endsWith('.docx');
}

export async function extractText(mimeType: string, name: string, data: Buffer): Promise<string> {
  const lowerName = name.toLocaleLowerCase('en');
  if (lowerName.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: data });
    return result.value.trim();
  }
  const source = decodeSource(data);
  if (mimeType === 'text/html' || lowerName.endsWith('.html') || lowerName.endsWith('.htm')) {
    return htmlToText(source, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }).trim();
  }
  return source.trim();
}

export async function optimizeCover(data: Buffer): Promise<Buffer> {
  return sharp(data)
    .rotate()
    .resize({ width: 720, height: 960, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/catalog/media.test.ts`

Expected: 4 tests pass, including preserved Windows-1255 Hebrew.

```bash
git add src/catalog/media.ts tests/catalog/media.test.ts
git commit -m "feat: extract archive text and optimize covers"
```

### Task 5: Resolve strong and topical collection relationships

**Files:**
- Create: `src/catalog/relationships.ts`
- Create: `tests/catalog/relationships.test.ts`

- [ ] **Step 1: Write the failing relationship boundary tests**

Create `tests/catalog/relationships.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveRelationships } from '../../src/catalog/relationships';
import type { CuratorConfig, DriveFile } from '../../src/catalog/types';

const files: DriveFile[] = [
  { id: 'game', name: 'piposh1.exe', mimeType: 'application/x-msdownload', size: 10, modifiedTime: null, path: 'משחקים מלאים/פיפוש 1/piposh1.exe', parentIds: [], viewUrl: 'view-game', downloadUrl: 'download-game' },
  { id: 'audio', name: 'דיסק אדיו.rar', mimeType: 'application/rar', size: 20, modifiedTime: null, path: 'שירים/דיסקים מלאים/פיפוש 1 - דיסק אודיו/דיסק אדיו.rar', parentIds: [], viewUrl: 'view-audio', downloadUrl: 'download-audio' },
  { id: 'press', name: 'ביקורת.jpg', mimeType: 'image/jpeg', size: 30, modifiedTime: null, path: 'עיתונות/פיפוש 1/ביקורת.jpg', parentIds: [], viewUrl: 'view-press', downloadUrl: 'download-press' },
  { id: 'fan', name: 'fan.zip', mimeType: 'application/zip', size: 40, modifiedTime: null, path: 'משחקי מעריצים/fan.zip', parentIds: [], viewUrl: 'view-fan', downloadUrl: 'download-fan' },
];

const curator: CuratorConfig = {
  collections: [{
    slug: 'piposh-1', titleHe: 'פיפוש 1', type: 'game', summaryHe: 'המשחק המקורי', aliasesHe: [], tagsHe: [],
    rules: [
      { match: 'path-prefix', value: 'משחקים מלאים/פיפוש 1', relationship: 'part-of-release', groupHe: 'גרסאות' },
      { match: 'path-prefix', value: 'שירים/דיסקים מלאים/פיפוש 1', relationship: 'part-of-release', groupHe: 'מוזיקה' },
      { match: 'path-prefix', value: 'עיתונות/פיפוש 1', relationship: 'about' },
      { match: 'file-id', value: 'fan', relationship: 'inspired-by' },
    ],
    exclude: [],
  }],
};

describe('resolveRelationships', () => {
  it('puts only official materials in the release item list', () => {
    const result = resolveRelationships(files, curator);
    const collection = result.collections[0];
    expect(collection?.itemIds).toEqual(['game', 'audio']);
    expect(result.items.find((item) => item.id === 'press')?.collectionLinks[0]?.relationship).toBe('about');
    expect(result.items.find((item) => item.id === 'fan')?.collectionLinks[0]?.relationship).toBe('inspired-by');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/catalog/relationships.test.ts`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement deterministic relationship resolution**

Create `src/catalog/relationships.ts`:

```ts
import type { Catalog, CatalogItem, CuratedCollection, CuratorConfig, CuratorRule, DriveFile } from './types';

function matches(file: DriveFile, rule: CuratorRule): boolean {
  if (rule.match === 'file-id') return file.id === rule.value;
  if (rule.match === 'exact-path') return file.path === rule.value;
  return file.path === rule.value || file.path.startsWith(`${rule.value}/`);
}

function categoryFor(path: string): string {
  return path.split('/')[0] ?? 'אחר';
}

export function resolveRelationships(files: DriveFile[], curator: CuratorConfig, generatedAt = new Date().toISOString()): Catalog {
  const items: CatalogItem[] = files.map((file) => ({
    ...file,
    category: categoryFor(file.path),
    aliasesHe: [],
    tagsHe: [],
    extractedTextHe: '',
    collectionLinks: [],
  }));

  for (const collection of curator.collections) {
    for (const item of items) {
      const excluded = collection.exclude.some((rule) => matches(item, rule));
      if (excluded) continue;
      for (const rule of collection.rules) {
        if (!matches(item, rule)) continue;
        item.collectionLinks.push({
          slug: collection.slug,
          titleHe: collection.titleHe,
          relationship: rule.relationship,
          groupHe: rule.groupHe,
        });
      }
    }
  }

  const collections = curator.collections.map((collection: CuratedCollection) => ({
    ...collection,
    coverUrl: collection.coverFileId ? `/generated/covers/${collection.coverFileId}.webp` : null,
    itemIds: items
      .filter((item) => item.collectionLinks.some((link) => link.slug === collection.slug && link.relationship === 'part-of-release'))
      .map((item) => item.id),
  }));

  return {
    generatedAt,
    collections,
    items,
    categories: [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b, 'he')),
  };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/catalog/relationships.test.ts`

Expected: the official release boundary test passes.

```bash
git add src/catalog/relationships.ts tests/catalog/relationships.test.ts
git commit -m "feat: resolve curated archive relationships"
```

### Task 6: Build a Hebrew-only search index

**Files:**
- Create: `src/catalog/search.ts`
- Create: `tests/catalog/search.test.ts`

- [ ] **Step 1: Write failing Hebrew normalization and discovery tests**

Create `tests/catalog/search.test.ts`:

```ts
import MiniSearch from 'minisearch';
import { describe, expect, it } from 'vitest';
import { buildSearchIndex, createSearchEngine, extractHebrewTokens, normalizeHebrew } from '../../src/catalog/search';
import type { Catalog } from '../../src/catalog/types';

const catalog: Catalog = {
  generatedAt: '2026-08-26T00:00:00.000Z',
  categories: ['משחקים מלאים'],
  collections: [{ slug: 'piposh-1', titleHe: 'פיפוש 1', type: 'game', summaryHe: 'המשחק המקורי', aliasesHe: ['פיפוש הראשון'], tagsHe: ['הרפתקה'], rules: [], exclude: [], coverUrl: null, itemIds: ['english'] }],
  items: [{ id: 'english', name: 'piposh1-english.exe', mimeType: 'application/x-msdownload', size: 10, modifiedTime: null, path: 'משחקים מלאים/פיפוש 1 - אנגלית/piposh1-english.exe', parentIds: [], viewUrl: 'view', downloadUrl: 'download', category: 'משחקים מלאים', aliasesHe: [], tagsHe: [], extractedTextHe: '', collectionLinks: [{ slug: 'piposh-1', titleHe: 'פיפוש 1', relationship: 'part-of-release', groupHe: 'גרסאות' }] }],
};

describe('Hebrew search', () => {
  it('normalizes niqqud and final letters', () => {
    expect(normalizeHebrew('פִּיפּוֹשׁ מלך')).toBe(normalizeHebrew('פיפוש מלכ'));
  });

  it('does not produce supported query tokens from Latin filenames', () => {
    expect(extractHebrewTokens('piposh1-english.exe')).toEqual([]);
  });

  it('finds an English-named edition through Hebrew collection metadata', () => {
    const serialized = buildSearchIndex(catalog);
    const engine = createSearchEngine(MiniSearch.loadJSON(serialized, createSearchEngine().options));
    const ids = engine.search('פיפוש 1').map((result) => result.id);
    expect(ids).toContain('collection:piposh-1');
    expect(ids).toContain('file:english');
    expect(engine.search('piposh')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/catalog/search.test.ts`

Expected: FAIL because `src/catalog/search.ts` does not exist.

- [ ] **Step 3: Implement Hebrew tokenization and weighted documents**

Create `src/catalog/search.ts`:

```ts
import MiniSearch, { type Options, type SearchResult } from 'minisearch';
import type { Catalog } from './types';

interface SearchDocument {
  id: string;
  kind: 'collection' | 'file';
  titleHe: string;
  aliasesHe: string;
  pathHe: string;
  tagsHe: string;
  textHe: string;
  href: string;
  category: string;
  filename: string;
  viewUrl: string;
  downloadUrl: string;
}

const finalLetters: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

export function normalizeHebrew(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7]/gu, '')
    .replace(/[ךםןףץ]/gu, (letter) => finalLetters[letter] ?? letter)
    .replace(/[״׳'"`.,:;!?()[\]{}\-_/\\]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function extractHebrewTokens(value: string): string[] {
  return normalizeHebrew(value).match(/[\u05D0-\u05EA]+/gu) ?? [];
}

function searchOptions(): Options<SearchDocument> {
  return {
    fields: ['titleHe', 'aliasesHe', 'pathHe', 'tagsHe', 'textHe'],
    storeFields: ['kind', 'titleHe', 'href', 'category', 'filename', 'viewUrl', 'downloadUrl'],
    tokenize: extractHebrewTokens,
    processTerm: (term) => normalizeHebrew(term) || null,
    idField: 'id',
  };
}

export function createSearchEngine(existing?: MiniSearch<SearchDocument>) {
  const engine = existing ?? new MiniSearch<SearchDocument>(searchOptions());
  return {
    options: searchOptions(),
    engine,
    search(query: string): SearchResult[] {
      if (extractHebrewTokens(query).length === 0) return [];
      return engine.search(query, {
        prefix: true,
        fuzzy: (term) => term.length >= 4 ? 0.2 : false,
        boost: { titleHe: 5, aliasesHe: 4, pathHe: 3, tagsHe: 2, textHe: 1 },
      });
    },
  };
}

export function buildSearchIndex(catalog: Catalog): string {
  const documents: SearchDocument[] = [];
  for (const collection of catalog.collections) {
    documents.push({
      id: `collection:${collection.slug}`,
      kind: 'collection',
      titleHe: collection.titleHe,
      aliasesHe: collection.aliasesHe.join(' '),
      pathHe: '',
      tagsHe: collection.tagsHe.join(' '),
      textHe: [collection.summaryHe, collection.descriptionHe ?? ''].join(' '),
      href: `/games/${collection.slug}/`,
      category: collection.type,
      filename: '',
      viewUrl: '',
      downloadUrl: '',
    });
  }
  for (const item of catalog.items) {
    const inherited = item.collectionLinks.map((link) => link.titleHe).join(' ');
    documents.push({
      id: `file:${item.id}`,
      kind: 'file',
      titleHe: [item.titleHe ?? '', inherited].join(' '),
      aliasesHe: item.aliasesHe.join(' '),
      pathHe: extractHebrewTokens(item.path).join(' '),
      tagsHe: item.tagsHe.join(' '),
      textHe: item.extractedTextHe,
      href: item.viewUrl,
      category: item.category,
      filename: item.name,
      viewUrl: item.viewUrl,
      downloadUrl: item.downloadUrl ?? '',
    });
  }
  const engine = createSearchEngine().engine;
  engine.addAll(documents);
  return JSON.stringify(engine);
}
```

- [ ] **Step 4: Run the pinned MiniSearch serialization tests**

Run: `npm test -- tests/catalog/search.test.ts`

Expected: 3 tests pass, including the explicit absence of Latin-only query support.

- [ ] **Step 5: Commit Hebrew search**

```bash
git add src/catalog/search.ts tests/catalog/search.test.ts
git commit -m "feat: build Hebrew archive search index"
```

### Task 7: Validate and generate catalog artifacts

**Files:**
- Create: `src/catalog/validate.ts`
- Create: `src/catalog/build.ts`
- Create: `tests/catalog/build.test.ts`

- [ ] **Step 1: Write the failing end-to-end catalog build test**

Create `tests/catalog/build.test.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/catalog/build';
import type { CuratorConfig, DriveFile } from '../../src/catalog/types';

const file: DriveFile = {
  id: 'solution', name: 'פיפוש 1 - פתרון.txt', mimeType: 'text/plain', size: 24,
  modifiedTime: '2026-08-26T00:00:00.000Z', path: 'פתרונות/פיפוש 1 - פתרון.txt',
  parentIds: ['solutions'], viewUrl: 'https://drive.google.com/file/d/solution/view',
  downloadUrl: 'https://drive.google.com/uc?export=download&id=solution',
};

const curator: CuratorConfig = {
  collections: [{ slug: 'piposh-1', titleHe: 'פיפוש 1', type: 'game', year: 1999,
    summaryHe: 'המשחק המקורי', aliasesHe: [], tagsHe: ['הרפתקה'], coverFileId: undefined,
    rules: [{ match: 'file-id', value: 'solution', relationship: 'part-of-release', groupHe: 'פתרונות' }], exclude: [] }],
};

describe('buildCatalog', () => {
  it('writes deterministic catalog, search, and curator report artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guillotine-build-'));
    const catalog = await buildCatalog({
      files: [file], curator, root, generatedAt: '2026-08-26T00:00:00.000Z',
      download: async () => Buffer.from('זהו פתרון מלא לפיפוש'),
    });
    expect(catalog.items[0]?.extractedTextHe).toContain('פתרון מלא');
    expect(JSON.parse(await readFile(join(root, 'src/generated/catalog.json'), 'utf8')).items).toHaveLength(1);
    expect(await readFile(join(root, 'public/data/search-index.json'), 'utf8')).toContain('collection:piposh-1');
    expect(JSON.parse(await readFile(join(root, 'reports/curator-report.json'), 'utf8')).errors).toEqual([]);
  });

  it('rejects an empty Drive result before writing deployable data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'guillotine-empty-'));
    await expect(buildCatalog({ files: [], curator, root, generatedAt: '2026-08-26T00:00:00.000Z', download: async () => Buffer.alloc(0) }))
      .rejects.toThrow(/archive contains no files/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/catalog/build.test.ts`

Expected: FAIL because `src/catalog/build.ts` does not exist.

- [ ] **Step 3: Implement blocking validation and curator reporting**

Create `src/catalog/validate.ts`:

```ts
import type { Catalog, CuratorConfig } from './types';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
  unclassifiedIds: string[];
}

export function validateCatalog(catalog: Catalog, curator: CuratorConfig, previousCount = 0, minimumFileCount = curator.minimumFileCount ?? 1): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();

  if (catalog.items.length === 0) errors.push('archive contains no files');
  if (catalog.items.length > 0 && catalog.items.length < minimumFileCount) {
    errors.push(`archive contains ${catalog.items.length} files; expected at least ${minimumFileCount}`);
  }
  if (previousCount >= 20 && catalog.items.length < previousCount * 0.5) {
    errors.push(`archive shrank unexpectedly from ${previousCount} to ${catalog.items.length} files`);
  }
  for (const item of catalog.items) {
    if (ids.has(item.id)) errors.push(`duplicate Drive file id: ${item.id}`);
    ids.add(item.id);
    const byCollection = new Map<string, Set<string>>();
    for (const link of item.collectionLinks) {
      const kinds = byCollection.get(link.slug) ?? new Set<string>();
      kinds.add(link.relationship);
      byCollection.set(link.slug, kinds);
    }
    for (const [slug, kinds] of byCollection) {
      if (kinds.size > 1) errors.push(`contradictory relationships for ${item.id} in ${slug}`);
    }
  }
  for (const collection of curator.collections) {
    if (collection.coverFileId && !ids.has(collection.coverFileId)) {
      errors.push(`missing cover file ${collection.coverFileId} for ${collection.slug}`);
    }
  }
  const unclassifiedIds = catalog.items.filter((item) => item.collectionLinks.length === 0).map((item) => item.id);
  if (unclassifiedIds.length > 0) warnings.push(`${unclassifiedIds.length} files are not linked to a curated collection`);
  return { errors, warnings, unclassifiedIds };
}
```

- [ ] **Step 4: Implement the artifact builder**

Create `src/catalog/build.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildSearchIndex } from './search';
import { extractText, isTextExtractable, optimizeCover } from './media';
import { resolveRelationships } from './relationships';
import type { Catalog, CuratorConfig, DriveFile } from './types';
import { validateCatalog } from './validate';

interface BuildInput {
  files: DriveFile[];
  curator: CuratorConfig;
  root: string;
  generatedAt: string;
  minimumFileCount?: number;
  download(fileId: string): Promise<Buffer>;
}

async function readPreviousCount(path: string): Promise<number> {
  try {
    const previous = JSON.parse(await readFile(path, 'utf8')) as Catalog;
    return previous.items.length;
  } catch {
    return 0;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function buildCatalog(input: BuildInput): Promise<Catalog> {
  const catalogPath = join(input.root, 'src/generated/catalog.json');
  const previousCount = await readPreviousCount(catalogPath);
  const catalog = resolveRelationships(input.files, input.curator, input.generatedAt);

  for (const item of catalog.items) {
    if (!isTextExtractable(item.mimeType, item.name, item.size)) continue;
    try {
      item.extractedTextHe = await extractText(item.mimeType, item.name, await input.download(item.id));
    } catch {
      item.extractedTextHe = '';
    }
  }

  const report = validateCatalog(catalog, input.curator, previousCount, input.minimumFileCount ?? input.curator.minimumFileCount ?? 1);
  await writeJson(join(input.root, 'reports/curator-report.json'), report);
  if (report.errors.length > 0) throw new Error(report.errors.join('\n'));

  for (const collection of catalog.collections) {
    if (!collection.coverFileId) continue;
    const coverPath = join(input.root, `public/generated/covers/${collection.coverFileId}.webp`);
    await mkdir(dirname(coverPath), { recursive: true });
    await writeFile(coverPath, await optimizeCover(await input.download(collection.coverFileId)));
  }

  await writeJson(catalogPath, catalog);
  const searchPath = join(input.root, 'public/data/search-index.json');
  await mkdir(dirname(searchPath), { recursive: true });
  await writeFile(searchPath, buildSearchIndex(catalog), 'utf8');
  return catalog;
}
```

- [ ] **Step 5: Run the tests and commit**

Run: `npm test -- tests/catalog/build.test.ts`

Expected: 2 tests pass and the temporary build contains all three artifacts.

```bash
git add src/catalog/build.ts src/catalog/validate.ts tests/catalog/build.test.ts
git commit -m "feat: generate validated archive artifacts"
```

### Task 8: Add real curator rules, a fixture tree, and sync entry points

**Files:**
- Create: `curator/collections.yml`
- Create: `tests/fixtures/drive-tree.json`
- Create: `scripts/sync-fixture.ts`
- Create: `scripts/sync-drive.ts`

- [ ] **Step 1: Add initial editorial collections**

Create `curator/collections.yml`:

```yaml
minimumFileCount: 1000
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    year: 1999
    summaryHe: המשחק המקורי, החשוד המיידי והסיבה שבגללה כולנו כאן.
    aliasesHe: [פיפוש הראשון]
    tagsHe: [הרפתקה, קומדיה, גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/פיפוש 1, relationship: part-of-release, groupHe: גרסאות בעברית }
      - { match: path-prefix, value: משחקים מלאים/פיפוש 1 - אנגלית, relationship: part-of-release, groupHe: גרסאות רשמיות }
      - { match: path-prefix, value: משחקים מלאים/פיפוש 1 - רוסית, relationship: part-of-release, groupHe: גרסאות רשמיות }
      - { match: path-prefix, value: שירים/דיסקים מלאים/פיפוש 1 - דיסק אודיו, relationship: part-of-release, groupHe: דיסק אודיו }
      - { match: exact-path, value: פתרונות/פיפוש 1 - פתרון.docx, relationship: part-of-release, groupHe: פתרונות }
      - { match: path-prefix, value: עיתונות/פיפוש 1, relationship: about }
    exclude:
      - { match: path-prefix, value: משחקי מעריצים, relationship: inspired-by }

  - slug: piposh-2
    titleHe: פיפוש 2
    type: game
    summaryHe: עוד פיפוש, כי כנראה הראשון לא הספיק.
    aliasesHe: []
    tagsHe: [הרפתקה, קומדיה, גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/פיפוש 2, relationship: part-of-release }
    exclude: []

  - slug: halom-shehitgashem
    titleHe: חלום שהתגשם
    type: game
    summaryHe: משחק, חלום, וכנראה גם כמה קבצים שלא ביקשו רשות.
    aliasesHe: []
    tagsHe: [גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/חלום שהתגשם, relationship: part-of-release }
      - { match: path-prefix, value: שירים/דיסקים מלאים/חלום שהתגשם - דיסק אודיו, relationship: part-of-release, groupHe: דיסק אודיו }
    exclude: []

  - slug: betochhei-harating
    titleHe: בתככי הרייטינג
    type: game
    summaryHe: מאחורי הקלעים, לפני שהקלעים הגישו תלונה.
    aliasesHe: [תככי הרייטינג]
    tagsHe: [גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/בתככי הרייטינג, relationship: part-of-release }
    exclude: []

  - slug: vogimon
    titleHe: ווג׳ימון
    type: game
    summaryHe: היצור, האגדה והחוברת הסרוקה.
    aliasesHe: [ווגימון]
    tagsHe: [גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/ווג_ימון, relationship: part-of-release }
    exclude: []

  - slug: piposh-revolution
    titleHe: פיפוש המהפכה
    type: game
    summaryHe: המהפכה הגיעה, מצאה מפה והסתבכה בדרך.
    aliasesHe: []
    tagsHe: [פיפוש, גיליוטין]
    rules:
      - { match: path-prefix, value: משחקים מלאים/פיפוש המהפכה, relationship: part-of-release }
    exclude: []
```

- [ ] **Step 2: Add a deterministic local Drive fixture**

Create `tests/fixtures/drive-tree.json`:

```json
{
  "root": [
    { "id": "games", "name": "משחקים מלאים", "mimeType": "application/vnd.google-apps.folder" },
    { "id": "solutions", "name": "פתרונות", "mimeType": "application/vnd.google-apps.folder" }
  ],
  "games": [
    { "id": "piposh-folder", "name": "פיפוש 1", "mimeType": "application/vnd.google-apps.folder" },
    { "id": "english-folder", "name": "פיפוש 1 - אנגלית", "mimeType": "application/vnd.google-apps.folder" }
  ],
  "piposh-folder": [
    { "id": "piposh-exe", "name": "piposh1.exe", "mimeType": "application/x-msdownload", "size": "1048576" }
  ],
  "english-folder": [
    { "id": "piposh-en", "name": "piposh1-english.exe", "mimeType": "application/x-msdownload", "size": "1048576" }
  ],
  "solutions": [
    { "id": "solution", "name": "פיפוש 1 - פתרון.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "size": "1024" }
  ]
}
```

- [ ] **Step 3: Implement fixture synchronization**

Create `scripts/sync-fixture.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildCatalog } from '../src/catalog/build';
import { loadCurator } from '../src/catalog/curator';
import { scanDrive, type DriveGateway, type RemoteEntry } from '../src/catalog/drive-gateway';

const root = resolve(import.meta.dirname, '..');
const tree = JSON.parse(await readFile(resolve(root, 'tests/fixtures/drive-tree.json'), 'utf8')) as Record<string, RemoteEntry[]>;
const gateway: DriveGateway = {
  listChildren: async (folderId) => tree[folderId] ?? [],
  download: async (fileId) => fileId === 'solution' ? Buffer.from('פתרון מלא לפיפוש 1') : Buffer.alloc(0),
};
const files = await scanDrive('root', gateway);
const curator = await loadCurator(resolve(root, 'curator/collections.yml'));
await buildCatalog({ files, curator, root, generatedAt: new Date().toISOString(), minimumFileCount: 1, download: gateway.download });
console.log(`fixture sync complete: ${files.length} files`);
```

- [ ] **Step 4: Implement production synchronization with explicit environment errors**

Create `scripts/sync-drive.ts`:

```ts
import { resolve } from 'node:path';
import { buildCatalog } from '../src/catalog/build';
import { loadCurator } from '../src/catalog/curator';
import { scanDrive } from '../src/catalog/drive-gateway';
import { createGoogleDriveGateway } from '../src/catalog/google-drive';

const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
if (!credentialsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
if (!rootFolderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required');

const root = resolve(import.meta.dirname, '..');
const gateway = createGoogleDriveGateway(credentialsJson);
const files = await scanDrive(rootFolderId, gateway);
const curator = await loadCurator(resolve(root, 'curator/collections.yml'));
await buildCatalog({ files, curator, root, generatedAt: new Date().toISOString(), download: gateway.download });
console.log(`Drive sync complete: ${files.length} files`);
```

- [ ] **Step 5: Run the fixture sync and all catalog tests**

Run:

```bash
npm run sync:fixture
npm test -- tests/catalog
```

Expected: sync reports 3 files, catalog tests pass, and generated catalog/search/report files exist.

- [ ] **Step 6: Commit curator data and sync commands**

```bash
git add curator scripts tests/fixtures
git commit -m "feat: add archive sync entry points"
```

### Task 9: Build the RTL shell and cover-first homepage

**Files:**
- Create: `src/lib/catalog.ts`
- Create: `src/lib/url.ts`
- Create: `src/layouts/BaseLayout.astro`
- Create: `src/components/Header.astro`
- Create: `src/components/GameTile.astro`
- Create: `src/styles/global.css`
- Modify: `src/pages/index.astro`
- Create: `tests/e2e/archive.spec.ts`

- [ ] **Step 1: Write the failing homepage browser test**

Create `tests/e2e/archive.spec.ts`:

```ts
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('homepage is Hebrew RTL and presents cover-first game links', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { name: 'ארכיון גיליוטין' })).toBeVisible();
  await expect(page.getByRole('link', { name: /פיפוש 1/ })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'חיפוש בארכיון' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
```

- [ ] **Step 2: Run the browser test to verify it fails**

Run: `npm run test:e2e -- --project=desktop-chromium --grep "homepage"`

Expected: FAIL because the homepage does not contain the approved shell or search control.

- [ ] **Step 3: Add typed catalog and base-path helpers**

Create `src/lib/catalog.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Catalog } from '../catalog/types';

const emptyCatalog: Catalog = { generatedAt: '1970-01-01T00:00:00.000Z', collections: [], items: [], categories: [] };
let loadedCatalog = emptyCatalog;
try {
  loadedCatalog = JSON.parse(readFileSync(resolve('src/generated/catalog.json'), 'utf8')) as Catalog;
} catch {
  loadedCatalog = emptyCatalog;
}

export const catalog = loadedCatalog;
export const games = catalog.collections.filter((collection) => collection.type === 'game');
export const itemById = new Map(catalog.items.map((item) => [item.id, item]));
```

Create `src/lib/url.ts`:

```ts
export function sitePath(path = ''): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
}
```

- [ ] **Step 4: Create the shared semantic shell**

Create `src/layouts/BaseLayout.astro`:

```astro
---
import Header from '../components/Header.astro';
import '../styles/global.css';

interface Props { title: string; description?: string }
const { title, description = 'הארכיון הציבורי למשחקי גיליוטין וחומרי התקופה' } = Astro.props;
---

<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <title>{title}</title>
  </head>
  <body>
    <a class="skip-link" href="#main">דלגו לתוכן</a>
    <Header />
    <main id="main"><slot /></main>
    <footer>הקבצים המקוריים נשמרים ומורדים דרך Google Drive.</footer>
  </body>
</html>
```

Create `src/components/Header.astro`:

```astro
---
import { sitePath } from '../lib/url';
---

<header class="site-header">
  <a class="brand" href={sitePath()}>ארכיון גיליוטין</a>
  <nav aria-label="ניווט ראשי">
    <a href={sitePath('games/')}>משחקים</a>
    <a href={sitePath('archive/')}>כל הארכיון</a>
    <a href={sitePath('search/')}>חיפוש</a>
    <a href={sitePath('about/')}>על הארכיון</a>
  </nav>
</header>
```

- [ ] **Step 5: Create the cover-first game tile**

Create `src/components/GameTile.astro`:

```astro
---
import type { CatalogCollection } from '../catalog/types';
import { sitePath } from '../lib/url';

interface Props { game: CatalogCollection }
const { game } = Astro.props;
const officialCount = game.itemIds.length;
---

<a class="game-tile" href={sitePath(`games/${game.slug}/`)} aria-label={`${game.titleHe} — לדף המשחק`}>
  <div class="cover-frame">
    {game.coverUrl ? <img src={sitePath(game.coverUrl)} alt={`עטיפת ${game.titleHe}`} loading="lazy" /> : <span>{game.titleHe}</span>}
  </div>
  <h2>{game.titleHe}</h2>
  <p>{game.summaryHe}</p>
  <span class="fact-badge">{officialCount} פריטים רשמיים</span>
</a>
```

- [ ] **Step 6: Add the first complete Piposh visual system**

Create `src/styles/global.css`:

```css
:root {
  --ink: #151515;
  --paper: #fffdf3;
  --pink: #e6007e;
  --cyan: #66d9ff;
  --lime: #c8ff28;
  --yellow: #ffd92f;
  font-family: Arial, "Arial Hebrew", sans-serif;
  color: var(--ink);
  background: var(--paper);
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--paper); }
a { color: inherit; }
.skip-link { position: fixed; inset-inline-start: 1rem; top: -4rem; z-index: 10; padding: .7rem 1rem; background: white; border: 3px solid var(--ink); }
.skip-link:focus { top: 1rem; }
.site-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem clamp(1rem, 4vw, 4rem); border-bottom: 3px solid var(--ink); background: white; }
.brand { font-size: 1.35rem; font-weight: 950; text-decoration: none; }
nav { display: flex; flex-wrap: wrap; gap: 1rem; }
nav a { font-weight: 800; text-underline-offset: .25rem; }
main { width: min(1180px, calc(100% - 2rem)); margin: 0 auto; padding: 2rem 0 4rem; }
footer { padding: 1.5rem; border-top: 3px solid var(--ink); text-align: center; font-size: .9rem; }
.hero { padding: clamp(2rem, 7vw, 5rem); border: 3px solid var(--ink); border-radius: 1.5rem; background: var(--yellow); box-shadow: 8px 8px 0 var(--ink); }
.hero h1 { margin: 0; font-size: clamp(2.5rem, 8vw, 6rem); line-height: .95; }
.hero p { max-width: 55ch; font-size: 1.1rem; line-height: 1.6; }
.search-form { display: flex; gap: .5rem; max-width: 48rem; margin-top: 1.5rem; }
.search-form input { flex: 1; min-width: 0; padding: .9rem 1.1rem; border: 3px solid var(--ink); border-radius: 999px; font: inherit; background: white; }
.search-form button { padding: .8rem 1.4rem; border: 3px solid var(--ink); border-radius: 999px; background: var(--lime); font: inherit; font-weight: 950; }
.game-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; margin-top: 2rem; }
.game-tile { display: block; padding: 1rem; border: 3px solid var(--ink); border-radius: 1rem; background: white; box-shadow: 5px 5px 0 var(--pink); text-decoration: none; }
.game-tile:nth-child(even) { box-shadow: 5px 5px 0 var(--cyan); }
.game-tile:focus-visible, .game-tile:hover { transform: translate(-2px, -2px); box-shadow: 8px 8px 0 var(--ink); outline: none; }
.cover-frame { display: grid; place-items: center; aspect-ratio: 3 / 4; overflow: hidden; border: 3px solid var(--ink); border-radius: .65rem; background: linear-gradient(145deg, var(--lime), var(--cyan)); }
.cover-frame img { width: 100%; height: 100%; object-fit: contain; background: white; }
.cover-frame span { padding: 1rem; text-align: center; font-size: 2rem; font-weight: 950; }
.game-tile h2 { margin: 1rem 0 .35rem; }
.game-tile p { min-height: 3.4rem; line-height: 1.45; }
.fact-badge { display: inline-block; padding: .3rem .6rem; border: 2px solid var(--ink); border-radius: 999px; background: var(--yellow); font-size: .78rem; font-weight: 850; }
@media (max-width: 640px) {
  .site-header { align-items: flex-start; flex-direction: column; }
  .search-form { flex-direction: column; }
  .search-form button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
```

- [ ] **Step 7: Replace the homepage with cover tiles and the Hebrew search entry**

Replace `src/pages/index.astro`:

```astro
---
import GameTile from '../components/GameTile.astro';
import BaseLayout from '../layouts/BaseLayout.astro';
import { games } from '../lib/catalog';
import { sitePath } from '../lib/url';
---

<BaseLayout title="ארכיון גיליוטין">
  <section class="hero">
    <h1>ארכיון גיליוטין</h1>
    <p>המשחקים, החוברות, המוזיקה ושאר הדברים שאיש אחראי לא היה שומר. קיבינימאט, מזל ששמרנו.</p>
    <form class="search-form" action={sitePath('search/')} role="search">
      <label class="visually-hidden" for="home-search">חיפוש בארכיון</label>
      <input id="home-search" name="q" type="search" placeholder="מה מחפשים? בעברית, אדוני." aria-label="חיפוש בארכיון" />
      <button type="submit">חיפוש</button>
    </form>
  </section>
  <section aria-labelledby="games-heading">
    <h2 id="games-heading">המשחקים</h2>
    <div class="game-grid">{games.map((game) => <GameTile game={game} />)}</div>
  </section>
</BaseLayout>

<style>
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  section + section { margin-top: 3.5rem; }
</style>
```

- [ ] **Step 8: Run homepage checks and commit**

Run:

```bash
npm run sync:fixture
npm run build
npm run test:e2e -- --project=desktop-chromium --grep "homepage"
```

Expected: build succeeds and the homepage test passes with no axe violations.

```bash
git add src tests/e2e/archive.spec.ts
git commit -m "feat: add cover-first Hebrew homepage"
```

### Task 10: Add game hubs, category browsing, and Drive actions

**Files:**
- Create: `src/components/FileList.astro`
- Create: `src/pages/games/index.astro`
- Create: `src/pages/games/[slug].astro`
- Create: `src/pages/archive/index.astro`
- Create: `src/pages/archive/[category].astro`
- Create: `src/pages/about.astro`
- Modify: `src/lib/url.ts`
- Modify: `tests/e2e/archive.spec.ts`

- [ ] **Step 1: Add failing navigation and game-boundary tests**

Append to `tests/e2e/archive.spec.ts`:

```ts
test('Piposh 1 is an official-material hub with direct Drive actions', async ({ page }) => {
  await page.goto('/games/piposh-1/');
  await expect(page.getByRole('heading', { name: 'פיפוש 1' })).toBeVisible();
  await expect(page.getByText('piposh1.exe')).toBeVisible();
  await expect(page.getByText('piposh1-english.exe')).toBeVisible();
  await expect(page.getByRole('link', { name: /הורדה.*piposh1.exe/ })).toHaveAttribute('href', /drive\.google\.com/);
  await expect(page.getByText('ביקורת.jpg')).toHaveCount(0);
  await expect(page.getByText('fan.zip')).toHaveCount(0);
});

test('complete archive browsing remains available without search', async ({ page }) => {
  await page.goto('/archive/');
  await expect(page.getByRole('heading', { name: 'כל הארכיון' })).toBeVisible();
  await page.getByRole('link', { name: 'משחקים מלאים' }).click();
  await expect(page.getByText('piposh1.exe')).toBeVisible();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -- --project=desktop-chromium --grep "Piposh 1|complete archive"`

Expected: FAIL with 404 responses for the new routes.

- [ ] **Step 3: Create a reusable, accessible file list**

Create `src/components/FileList.astro`:

```astro
---
import type { CatalogItem } from '../catalog/types';

interface Props { items: CatalogItem[]; heading?: string }
const { items, heading } = Astro.props;
const formatSize = (size: number | null) => {
  if (size === null) return 'גודל לא ידוע';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
---

{heading && <h2>{heading}</h2>}
<ul class="file-list">
  {items.map((item) => (
    <li>
      <div>
        <strong>{item.name}</strong>
        <small>{item.path} · {formatSize(item.size)}</small>
      </div>
      <div class="file-actions">
        <a href={item.viewUrl} target="_blank" rel="noopener">צפייה ב־Drive — {item.name}</a>
        {item.downloadUrl && <a href={item.downloadUrl} target="_blank" rel="noopener">הורדה — {item.name}</a>}
      </div>
    </li>
  ))}
</ul>

<style>
  .file-list { display: grid; gap: .75rem; padding: 0; list-style: none; }
  li { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem; border: 2px solid var(--ink); border-radius: .8rem; background: white; }
  strong, small { display: block; overflow-wrap: anywhere; }
  small { margin-top: .35rem; color: #5f5a54; }
  .file-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .file-actions a { padding: .45rem .7rem; border: 2px solid var(--ink); border-radius: 999px; font-size: .82rem; font-weight: 800; white-space: nowrap; }
  @media (max-width: 680px) { li { align-items: stretch; flex-direction: column; } }
</style>
```

- [ ] **Step 4: Add game listing and official game hubs**

Create `src/pages/games/index.astro`:

```astro
---
import GameTile from '../../components/GameTile.astro';
import BaseLayout from '../../layouts/BaseLayout.astro';
import { games } from '../../lib/catalog';
---

<BaseLayout title="משחקי גיליוטין">
  <h1>המשחקים</h1>
  <p>כל משחק מקבל דף מסודר. כן, אפילו אם התיקיות ב־Drive החליטו אחרת.</p>
  <div class="game-grid">{games.map((game) => <GameTile game={game} />)}</div>
</BaseLayout>
```

Create `src/pages/games/[slug].astro`:

```astro
---
import FileList from '../../components/FileList.astro';
import BaseLayout from '../../layouts/BaseLayout.astro';
import { catalog, itemById } from '../../lib/catalog';
import { sitePath } from '../../lib/url';
import type { CatalogCollection } from '../../catalog/types';

export function getStaticPaths() {
  return catalog.collections
    .filter((collection) => collection.type === 'game')
    .map((collection) => ({ params: { slug: collection.slug }, props: { collection } }));
}

interface Props { collection: CatalogCollection }
const { collection } = Astro.props;
const officialItems = collection.itemIds.flatMap((id) => itemById.get(id) ?? []);
const groups = Map.groupBy(officialItems, (item) => item.collectionLinks.find((link) => link.slug === collection.slug)?.groupHe ?? 'חומרים רשמיים');
---

<BaseLayout title={`${collection.titleHe} — ארכיון גיליוטין`} description={collection.summaryHe}>
  <article class="game-page">
    <header class="game-intro">
      <div class="cover-frame">
        {collection.coverUrl ? <img src={sitePath(collection.coverUrl)} alt={`עטיפת ${collection.titleHe}`} /> : <span>{collection.titleHe}</span>}
      </div>
      <div>
        <p class="eyebrow">משחק של גיליוטין</p>
        <h1>{collection.titleHe}</h1>
        <p>{collection.descriptionHe ?? collection.summaryHe}</p>
        {collection.year && <p><strong>שנה:</strong> {collection.year}</p>}
      </div>
    </header>
    <aside class="drive-note">הקבצים נשמרים ב־Google Drive. קבצים גדולים עשויים להציג מסך אישור של Drive לפני ההורדה.</aside>
    {[...groups.entries()].map(([group, items]) => <section><FileList heading={group} items={items} /></section>)}
  </article>
</BaseLayout>

<style>
  .game-intro { display: grid; grid-template-columns: minmax(180px, 300px) 1fr; gap: 2rem; align-items: center; }
  .eyebrow { font-weight: 900; color: var(--pink); }
  h1 { font-size: clamp(2.5rem, 7vw, 5rem); margin: .2rem 0; }
  .drive-note { margin: 2rem 0; padding: 1rem; border-inline-start: 6px solid var(--pink); background: white; }
  section + section { margin-top: 2rem; }
  @media (max-width: 650px) { .game-intro { grid-template-columns: 1fr; } .cover-frame { max-width: 260px; } }
</style>
```

- [ ] **Step 5: Add complete category browsing**

Append the stable category mapping to `src/lib/url.ts`:

```ts
const CATEGORY_SLUGS: Record<string, string> = {
  'משחקים מלאים': 'games',
  'סרטונים': 'videos',
  'עיתונות': 'press',
  'פרטי אספנות': 'collectibles',
  'משחקי מעריצים': 'fan-games',
  'דמואים': 'demos',
  'גרפיקה': 'graphics',
  'פתרונות': 'solutions',
  'שירים': 'music',
};

export function categorySlug(category: string): string {
  const slug = CATEGORY_SLUGS[category];
  if (!slug) throw new Error(`missing stable category slug for ${category}`);
  return slug;
}
```

Create `src/pages/archive/index.astro`:

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
import { catalog } from '../../lib/catalog';
import { categorySlug, sitePath } from '../../lib/url';
---

<BaseLayout title="כל הארכיון">
  <h1>כל הארכיון</h1>
  <p>למי שיודע מה הוא רוצה, ולמי שהתייאש בכבוד מן החיפוש.</p>
  <ul class="category-grid">
    {catalog.categories.map((category) => <li><a href={sitePath(`archive/${categorySlug(category)}/`)}>{category}</a></li>)}
  </ul>
</BaseLayout>

<style>
  .category-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1rem; padding: 0; list-style: none; }
  .category-grid a { display: block; padding: 1.4rem; border: 3px solid var(--ink); border-radius: 1rem; background: var(--cyan); box-shadow: 4px 4px 0 var(--ink); font-size: 1.2rem; font-weight: 900; text-decoration: none; }
</style>
```

Create `src/pages/archive/[category].astro`:

```astro
---
import FileList from '../../components/FileList.astro';
import BaseLayout from '../../layouts/BaseLayout.astro';
import { catalog } from '../../lib/catalog';
import { categorySlug } from '../../lib/url';

export function getStaticPaths() {
  return catalog.categories.map((category) => ({ params: { category: categorySlug(category) }, props: { category } }));
}

interface Props { category: string }
const { category } = Astro.props;
const items = catalog.items.filter((item) => item.category === category);
---

<BaseLayout title={`${category} — ארכיון גיליוטין`}>
  <h1>{category}</h1>
  <FileList items={items} />
</BaseLayout>
```

Create `src/pages/about.astro`:

```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---

<BaseLayout title="על ארכיון גיליוטין">
  <article class="reading-page">
    <h1>על הארכיון</h1>
    <p>האתר מרכז משחקים וחומרים היסטוריים של גיליוטין ומקשר את הקבצים המקוריים השמורים ב־Google Drive.</p>
    <h2>איך מורידים?</h2>
    <p>כל כפתור צפייה או הורדה פותח את Drive. בקבצים גדולים Drive עשוי לבקש אישור נוסף; זו התנהגות רגילה.</p>
    <h2>מה שייך למה?</h2>
    <p>דפי משחק כוללים רק חומרים רשמיים של אותה מהדורה. עיתונות ויצירות מעריצים נשמרות כאוספים עצמאיים.</p>
  </article>
</BaseLayout>

<style>.reading-page { max-width: 70ch; line-height: 1.75; }</style>
```

- [ ] **Step 6: Run route tests and commit**

Run:

```bash
npm run sync:fixture
npm run build
npm run test:e2e -- --project=desktop-chromium --grep "Piposh 1|complete archive"
```

Expected: the game and archive navigation tests pass; the game page renders only `part-of-release` item IDs.

```bash
git add src/components/FileList.astro src/pages src/lib/url.ts tests/e2e/archive.spec.ts
git commit -m "feat: add interlinked game and archive pages"
```

### Task 11: Add interactive Hebrew search and failure fallback

**Files:**
- Modify: `src/catalog/search.ts`
- Create: `src/components/ArchiveSearch.astro`
- Create: `src/scripts/search-client.ts`
- Create: `src/pages/search.astro`
- Modify: `tests/e2e/archive.spec.ts`

- [ ] **Step 1: Add failing search interaction tests**

Append to `tests/e2e/archive.spec.ts`:

```ts
test('Hebrew search ranks the collection before English-named files', async ({ page }) => {
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9%201');
  await expect(page.locator('[data-search-status]')).toContainText('תוצאות');
  const results = page.locator('[data-search-results] li');
  await expect(results.first()).toContainText('פיפוש 1');
  await expect(page.getByText('piposh1-english.exe')).toBeVisible();
});

test('Latin-only queries are outside supported search and show no results', async ({ page }) => {
  await page.goto('/search/?q=piposh');
  await expect(page.locator('[data-search-status]')).toContainText('החיפוש באתר הוא בעברית');
});

test('search load failure keeps browse navigation available', async ({ page }) => {
  await page.route('**/data/search-index.json', (route) => route.abort());
  await page.goto('/search/?q=%D7%A4%D7%99%D7%A4%D7%95%D7%A9');
  await expect(page.locator('[data-search-status]')).toContainText('לא הצלחנו לטעון');
  await expect(page.getByRole('link', { name: 'כל הארכיון' })).toBeVisible();
});

test('game, archive, and search pages have no automated accessibility violations', async ({ page }) => {
  for (const path of ['/games/piposh-1/', '/archive/', '/search/']) {
    await page.goto(path);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -- --project=desktop-chromium --grep "search"`

Expected: FAIL because `/search/` and the browser search component do not exist.

- [ ] **Step 3: Export the shared MiniSearch options**

In `src/catalog/search.ts`, rename `searchOptions` to the exported function below and update both internal calls to use `getSearchOptions()`:

```ts
export function getSearchOptions(): Options<SearchDocument> {
  return {
    fields: ['titleHe', 'aliasesHe', 'pathHe', 'tagsHe', 'textHe'],
    storeFields: ['kind', 'titleHe', 'href', 'category', 'filename', 'viewUrl', 'downloadUrl'],
    tokenize: extractHebrewTokens,
    processTerm: (term) => normalizeHebrew(term) || null,
    idField: 'id',
  };
}
```

- [ ] **Step 4: Create the search markup**

Create `src/components/ArchiveSearch.astro`:

```astro
---
import { catalog } from '../lib/catalog';
---

<section class="search-panel" data-search-root>
  <form class="search-form" role="search" data-search-form>
    <label for="archive-search">חיפוש בארכיון</label>
    <div>
      <input id="archive-search" name="q" type="search" autocomplete="off" placeholder="מה מחפשים? בעברית." data-search-input />
      <button type="submit">חיפוש</button>
    </div>
  </form>
  <div class="filters">
    <label for="category-filter">סוג חומר</label>
    <select id="category-filter" data-search-category>
      <option value="">הכול</option>
      {catalog.categories.map((value) => <option value={value}>{value}</option>)}
    </select>
  </div>
  <p aria-live="polite" data-search-status>כתבו משהו בעברית. המחשב כבר יילחץ בעצמו.</p>
  <ol class="search-results" data-search-results></ol>
</section>

<script>
  import '../scripts/search-client';
</script>

<style>
  .search-panel { padding: clamp(1rem, 4vw, 2rem); border: 3px solid var(--ink); border-radius: 1.2rem; background: var(--yellow); box-shadow: 6px 6px 0 var(--ink); }
  .search-form label, .filters label { display: block; margin-bottom: .4rem; font-weight: 900; }
  .search-form > div { display: flex; gap: .5rem; }
  .search-form input { flex: 1; min-width: 0; padding: .8rem 1rem; border: 3px solid var(--ink); border-radius: 999px; font: inherit; }
  button, select { padding: .7rem 1rem; border: 3px solid var(--ink); border-radius: 999px; background: white; font: inherit; font-weight: 850; }
  .filters { margin-top: 1rem; }
  .search-results { display: grid; gap: .7rem; padding: 0; list-style: none; }
  .search-results :global(li) { padding: 1rem; border: 2px solid var(--ink); border-radius: .8rem; background: white; }
  @media (max-width: 600px) { .search-form > div { flex-direction: column; } }
</style>
```

- [ ] **Step 5: Implement safe browser-side result rendering**

Create `src/scripts/search-client.ts`:

```ts
import MiniSearch, { type SearchResult } from 'minisearch';
import { createSearchEngine, extractHebrewTokens, getSearchOptions } from '../catalog/search';

const root = document.querySelector<HTMLElement>('[data-search-root]');
const form = root?.querySelector<HTMLFormElement>('[data-search-form]');
const input = root?.querySelector<HTMLInputElement>('[data-search-input]');
const category = root?.querySelector<HTMLSelectElement>('[data-search-category]');
const status = root?.querySelector<HTMLElement>('[data-search-status]');
const list = root?.querySelector<HTMLOListElement>('[data-search-results]');
const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;

function withBase(path: string): string {
  if (/^https?:\/\//u.test(path)) return path;
  return `${base}${path.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
}

function appendText(parent: HTMLElement, tag: 'strong' | 'small' | 'span', text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  parent.append(node);
  return node;
}

function renderResult(result: SearchResult): HTMLLIElement {
  const item = document.createElement('li');
  const title = result.kind === 'collection' ? String(result.titleHe) : String(result.filename);
  const link = document.createElement('a');
  link.href = withBase(String(result.href));
  if (result.kind === 'file') { link.target = '_blank'; link.rel = 'noopener'; }
  appendText(link, 'strong', title);
  item.append(link);
  appendText(item, 'small', result.kind === 'collection' ? 'דף משחק או אוסף' : String(result.category));
  if (result.kind === 'file' && result.downloadUrl) {
    const download = document.createElement('a');
    download.href = String(result.downloadUrl);
    download.target = '_blank';
    download.rel = 'noopener';
    download.textContent = `הורדה — ${title}`;
    item.append(download);
  }
  return item;
}

async function start(): Promise<void> {
  if (!form || !input || !category || !status || !list) return;
  try {
    const response = await fetch(`${base}data/search-index.json`);
    if (!response.ok) throw new Error(`search index returned ${response.status}`);
    const engine = createSearchEngine(MiniSearch.loadJSON(await response.text(), getSearchOptions()));
    const run = () => {
      const query = input.value.trim();
      list.replaceChildren();
      if (query && extractHebrewTokens(query).length === 0) { status.textContent = 'החיפוש באתר הוא בעברית.'; return; }
      if (!query) { status.textContent = 'כתבו משהו בעברית. המחשב כבר יילחץ בעצמו.'; return; }
      const matches = engine.search(query).filter((result) => !category.value || result.category === category.value);
      matches.sort((left, right) => left.kind === right.kind ? right.score - left.score : left.kind === 'collection' ? -1 : 1);
      for (const match of matches) list.append(renderResult(match));
      status.textContent = matches.length > 0 ? `${matches.length} תוצאות` : 'לא מצאנו. אפילו לא מתחת לשטיח.';
    };
    form.addEventListener('submit', (event) => { event.preventDefault(); run(); });
    category.addEventListener('change', run);
    input.value = new URLSearchParams(location.search).get('q') ?? '';
    run();
  } catch {
    status.textContent = 'לא הצלחנו לטעון את החיפוש. אפשר להמשיך דרך כל הארכיון ולנסות שוב.';
  }
}

void start();
```

- [ ] **Step 6: Create the search page**

Create `src/pages/search.astro`:

```astro
---
import ArchiveSearch from '../components/ArchiveSearch.astro';
import BaseLayout from '../layouts/BaseLayout.astro';
---

<BaseLayout title="חיפוש בארכיון גיליוטין">
  <h1>קיבינימאט, איפה שמנו את זה?</h1>
  <p>חיפוש אחד בכל החומרים שיש להם שם, תיאור או טקסט בעברית.</p>
  <ArchiveSearch />
</BaseLayout>
```

- [ ] **Step 7: Run unit, browser, and build checks**

Run:

```bash
npm run sync:fixture
npm test -- tests/catalog/search.test.ts
npm run build
npm run test:e2e -- --project=desktop-chromium --grep "search"
```

Expected: Hebrew queries find the collection and English-named edition, Latin-only input is rejected as unsupported, and the failure fallback remains navigable.

- [ ] **Step 8: Commit interactive search**

```bash
git add src/catalog/search.ts src/components/ArchiveSearch.astro src/scripts/search-client.ts src/pages/search.astro tests/e2e/archive.spec.ts
git commit -m "feat: add Hebrew archive search experience"
```

### Task 12: Preserve original character art with safe transparency

**Files:**
- Create: `src/assets/remove-edge-white.ts`
- Create: `scripts/process-character-assets.ts`
- Create: `tests/assets/remove-edge-white.test.ts`
- Create: `public/assets/characters/hezi.png`
- Modify: `src/pages/index.astro`
- Modify: `src/styles/global.css`

- [ ] **Step 1: Write the failing edge-connected background test**

Create `tests/assets/remove-edge-white.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { removeEdgeConnectedWhite } from '../../src/assets/remove-edge-white';

describe('removeEdgeConnectedWhite', () => {
  it('clears outside white while preserving enclosed white eyes', () => {
    const width = 5;
    const height = 5;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels.set([255, 255, 255, 255], index);
    }
    const black = (x: number, y: number) => pixels.set([0, 0, 0, 255], (y * width + x) * 4);
    for (let x = 1; x <= 3; x += 1) { black(x, 1); black(x, 3); }
    black(1, 2); black(3, 2);

    const result = removeEdgeConnectedWhite(pixels, width, height);
    expect(result[3]).toBe(0);
    expect(result[(2 * width + 2) * 4 + 3]).toBe(255);
    expect(result[(1 * width + 2) * 4 + 3]).toBe(255);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/assets/remove-edge-white.test.ts`

Expected: FAIL because the transparency module does not exist.

- [ ] **Step 3: Implement border flood fill instead of global white removal**

Create `src/assets/remove-edge-white.ts`:

```ts
function isNearWhite(pixels: Uint8ClampedArray, pixel: number, threshold: number): boolean {
  const offset = pixel * 4;
  return (pixels[offset] ?? 0) >= threshold && (pixels[offset + 1] ?? 0) >= threshold && (pixels[offset + 2] ?? 0) >= threshold;
}

export function removeEdgeConnectedWhite(source: Uint8ClampedArray, width: number, height: number, threshold = 245): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(source);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const enqueue = (pixel: number) => {
    if (pixel < 0 || pixel >= width * height || visited[pixel] || !isNearWhite(pixels, pixel, threshold)) return;
    visited[pixel] = 1;
    queue.push(pixel);
  };

  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 0; y < height; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }

  for (let head = 0; head < queue.length; head += 1) {
    const pixel = queue[head];
    if (pixel === undefined) continue;
    pixels[pixel * 4 + 3] = 0;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }
  return pixels;
}
```

- [ ] **Step 4: Implement the reproducible image-processing command**

Create `scripts/process-character-assets.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { removeEdgeConnectedWhite } from '../src/assets/remove-edge-white';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key && value) args.set(key, value);
}
const input = args.get('--input');
const output = args.get('--output');
if (!input || !output) throw new Error('usage: npm run assets:characters -- --input SOURCE --output DESTINATION');

const image = sharp(resolve(input)).ensureAlpha();
const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
const transparent = removeEdgeConnectedWhite(new Uint8ClampedArray(data), info.width, info.height);
await mkdir(dirname(resolve(output)), { recursive: true });
await sharp(Buffer.from(transparent), { raw: info }).png().toFile(resolve(output));
console.log(`wrote ${resolve(output)}`);
```

- [ ] **Step 5: Run the test and generate the approved character asset**

Run:

```bash
npm test -- tests/assets/remove-edge-white.test.ts
npm run assets:characters -- --input /Users/yonatankarp-rudin/Downloads/גיליוטין/archive/.superpowers/brainstorm/40060-1787726765/content/hezi.gif --output public/assets/characters/hezi.png
```

Expected: the test passes, the script writes `public/assets/characters/hezi.png`, outside background pixels are transparent, and enclosed eye/teeth whites remain opaque.

- [ ] **Step 6: Place the original character art in the homepage composition**

In `src/pages/index.astro`, add this image as the first child of the `.hero` section:

```astro
<img class="hero-character" src={sitePath('assets/characters/hezi.png')} alt="חזי פיפוש מציץ אל הארכיון" />
```

Append to `src/styles/global.css`:

```css
.hero { position: relative; overflow: hidden; }
.hero > :not(.hero-character) { position: relative; z-index: 1; }
.hero-character { position: absolute; inset-inline-end: clamp(-3rem, -2vw, -1rem); bottom: -1rem; width: min(32vw, 330px); height: auto; opacity: .96; }
@media (max-width: 720px) { .hero-character { opacity: .2; width: 60vw; } }
```

- [ ] **Step 7: Verify appearance and commit**

Run:

```bash
npm run sync:fixture
npm run build
npm run test:e2e -- --project=desktop-chromium --grep "homepage"
npm run test:e2e -- --project=mobile-chromium --grep "homepage"
```

Expected: both viewport tests pass, text remains readable, and the original art has no yellow tint or transparent enclosed eyes.

```bash
git add src/assets src/pages/index.astro src/styles/global.css scripts/process-character-assets.ts tests/assets public/assets/characters/hezi.png
git commit -m "feat: add faithful Piposh character artwork"
```

### Task 13: Add the daily GitHub Pages workflow and owner guidance

**Files:**
- Create: `.github/workflows/deploy-pages.yml`
- Create: `tests/workflows/deploy-pages.test.ts`
- Create: `docs/setup-google-drive.md`
- Create: `README.md`

- [ ] **Step 1: Write the failing workflow contract test**

Create `tests/workflows/deploy-pages.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('GitHub Pages deployment workflow', () => {
  it('syncs daily, supports manual runs, and deploys only after tests', async () => {
    const workflow = parse(await readFile('.github/workflows/deploy-pages.yml', 'utf8')) as Record<string, any>;
    expect(workflow.on.schedule[0].cron).toBe('17 3 * * *');
    expect(workflow.on.workflow_dispatch).toEqual({});
    const steps = workflow.jobs.deploy.steps.map((step: { name?: string }) => step.name);
    expect(steps.indexOf('Sync Google Drive')).toBeLessThan(steps.indexOf('Run tests'));
    expect(steps.indexOf('Run tests')).toBeLessThan(steps.indexOf('Build site'));
    expect(steps.indexOf('Build site')).toBeLessThan(steps.indexOf('Deploy GitHub Pages'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/workflows/deploy-pages.test.ts`

Expected: FAIL because the workflow file does not exist.

- [ ] **Step 3: Create the fail-safe daily deployment workflow**

Create `.github/workflows/deploy-pages.yml`:

```yaml
name: Sync archive and deploy Pages

on:
  workflow_dispatch: {}
  schedule:
    - cron: '17 3 * * *'
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    env:
      GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
      GOOGLE_DRIVE_FOLDER_ID: ${{ secrets.GOOGLE_DRIVE_FOLDER_ID }}
    steps:
      - name: Check out repository
        uses: actions/checkout@v7
      - name: Set up Node
        uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Install Chromium
        run: npx playwright install --with-deps chromium
      - name: Sync Google Drive
        run: npm run sync:drive
      - name: Run tests
        run: npm test
      - name: Build site
        run: npm run build
        env:
          SITE_URL: https://${{ github.repository_owner }}.github.io
          BASE_PATH: /${{ github.event.repository.name }}
      - name: Run browser tests
        run: npm run test:e2e -- --project=desktop-chromium
      - name: Upload curator report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: curator-report
          path: reports/curator-report.json
          if-no-files-found: ignore
      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: dist
      - name: Deploy GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
```

- [ ] **Step 4: Add the Google Drive setup guide**

Create `docs/setup-google-drive.md`:

```markdown
# Google Drive setup

The website reads archive metadata during GitHub Actions builds. Credentials never reach the browser.

1. In Google Cloud Console, create or select a project dedicated to this archive.
2. Enable the Google Drive API.
3. Create a service account. Do not grant it project roles.
4. Create one JSON key for the service account and download it to a secure local location.
5. In Google Drive, share only the public archive root folder with the service account email as Viewer.
6. Make the downloadable archive files public to anyone with the link.
7. In the GitHub repository, open Settings → Secrets and variables → Actions.
8. Create `GOOGLE_SERVICE_ACCOUNT_JSON` with the complete JSON key contents.
9. Create `GOOGLE_DRIVE_FOLDER_ID` with the root folder ID copied from the Drive folder URL.
10. Open Settings → Pages and select GitHub Actions as the deployment source.
11. Run “Sync archive and deploy Pages” manually from the Actions tab.

If synchronization fails, download the `curator-report` artifact from the workflow run. The previous successful Pages deployment remains online because deployment steps do not run after a failed sync, test, or build.

Rotate the service-account key if it is ever exposed. Removing the service account's folder share immediately revokes archive access.
```

- [ ] **Step 5: Add repository operating instructions**

Create `README.md`:

````markdown
# Guillotine Archive

A Hebrew RTL static archive for Guillotine games and related materials. Astro generates the site, Google Drive hosts original downloads, and GitHub Pages serves the public pages.

## Local development

```bash
npm install
npx playwright install chromium
npm run sync:fixture
npm run dev
```

## Quality checks

```bash
npm test
npm run build
npm run test:e2e -- --project=desktop-chromium
```

## Archive updates

GitHub Actions synchronizes Google Drive once per day. Run the workflow manually after a curator change. Edit `curator/collections.yml` to define official release relationships, topical relationships, Hebrew titles, aliases, tags, and selected cover IDs.

See [Google Drive setup](docs/setup-google-drive.md) for the one-time owner configuration.
````

- [ ] **Step 6: Run workflow and documentation checks**

Run:

```bash
npm test -- tests/workflows/deploy-pages.test.ts
npm run check
git diff --check
```

Expected: workflow test passes, Astro check passes, and Git reports no whitespace errors.

- [ ] **Step 7: Commit deployment automation and guidance**

```bash
git add .github README.md docs/setup-google-drive.md tests/workflows/deploy-pages.test.ts
git commit -m "ci: sync Drive and deploy GitHub Pages daily"
```

### Task 14: Configure real Drive content and select cover IDs

**Files:**
- Modify: `curator/collections.yml`
- Verify: `reports/curator-report.json`
- Verify: `src/generated/catalog.json`
- Verify: `public/generated/covers/*.webp`

- [ ] **Step 1: Configure secrets interactively**

Run these commands from an authenticated GitHub CLI session. Each command prompts for the secret value and avoids printing it:

```bash
gh secret set GOOGLE_SERVICE_ACCOUNT_JSON
gh secret set GOOGLE_DRIVE_FOLDER_ID
```

Expected: `gh secret list` displays both secret names without revealing values.

- [ ] **Step 2: Run the first real synchronization locally**

Set the two variables only in the current shell using values from the service-account file and Drive folder, then run:

```bash
npm run sync:drive
```

Expected: the command reports approximately the known archive size rather than zero files, and `reports/curator-report.json` contains no blocking errors.

- [ ] **Step 3: Pin cover images by Drive ID**

Open `src/generated/catalog.json`, locate the intended cover scan for each game by its `path`, and copy that record's `id` into the matching `coverFileId` field in `curator/collections.yml`. Run:

```bash
npm run sync:drive
```

Expected: one optimized WebP appears in `public/generated/covers/` for each configured cover ID and every game tile displays uncropped cover art.

- [ ] **Step 4: Review unclassified content without weakening boundaries**

Open `reports/curator-report.json`. Add path rules only when a file has a clear editorial relationship. Use `part-of-release` for official release contents, `about` for press, and `inspired-by` for fan works. Run:

```bash
npm run sync:drive
npm test
```

Expected: all tests pass; press and fan items remain absent from game attachment groups.

- [ ] **Step 5: Commit curator IDs and relationship refinements**

```bash
git add curator/collections.yml
git commit -m "content: curate Drive collection relationships"
```

### Task 15: Complete release verification

**Files:**
- Verify: all tracked project files

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm test
npm run check
npm run build
npm run test:e2e -- --project=desktop-chromium
npm run test:e2e -- --project=mobile-chromium
```

Expected: every unit, workflow, desktop, mobile, accessibility, type, and build check exits 0.

- [ ] **Step 2: Inspect the production artifact**

Run:

```bash
find dist -type f | sort
du -sh dist
```

Expected: game/category/search pages, the search index, selected WebP covers, and the character asset are present; original games, videos, audio, and scans are absent; total output remains far below 1 GB.

- [ ] **Step 3: Verify repository hygiene**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -15
```

Expected: no whitespace errors, only intentionally generated ignored files remain untracked, and the history contains one focused commit per task with no co-author trailers.

- [ ] **Step 4: Push and run the manual Pages workflow**

Run:

```bash
git push -u origin main
gh workflow run deploy-pages.yml
gh run watch
```

Expected: the workflow synchronizes Drive, passes all checks, deploys Pages, and reports the public Pages URL.

- [ ] **Step 5: Perform the public smoke test**

At the reported Pages URL, verify the Hebrew homepage, a Piposh 1 hub, the English-named edition reached through a Hebrew query, a direct Drive download, category browsing, mobile layout, keyboard focus, and the search failure message using browser network blocking.

Expected: all acceptance criteria in `docs/superpowers/specs/2026-08-26-guillotine-archive-design.md` are satisfied.
