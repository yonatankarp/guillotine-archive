import { createHash } from 'node:crypto';

const SUPPORTED_EXTERNAL_URL = /^(?:https?:\/\/|mailto:|tel:)/iu;
const EXTERNAL_LIKE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

const CATEGORY_SLUGS = new Map<string, string>([
  ['משחקים מלאים', 'games'],
  ['סרטונים', 'videos'],
  ['עיתונות', 'press'],
  ['פרטי אספנות', 'collectibles'],
  ['משחקי מעריצים', 'fan-games'],
  ['דמואים', 'demos'],
  ['גרפיקה', 'graphics'],
  ['פתרונות', 'solutions'],
  ['שירים', 'music'],
  ['אחר', 'other'],
]);

function decodePath(path: string): string {
  let decoded = path;

  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
  } catch {
    throw new Error('unsafe internal path');
  }

  throw new Error('unsafe internal path');
}

function assertSafeInternalPath(path: string): void {
  const browserNormalizedPath = decodePath(path).replace(/\\/gu, '/');
  if (browserNormalizedPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('unsafe internal path');
  }
}

function normalizeBase(base: string): string {
  assertSafeInternalPath(base);
  const normalized = `/${base}`.replace(/\/{2,}/gu, '/').replace(/\/+$/u, '');
  return normalized === '' ? '/' : `${normalized}/`;
}

export function sitePathForBase(base: string, path = ''): string {
  if (path.startsWith('#') || path.startsWith('?') || SUPPORTED_EXTERNAL_URL.test(path)) {
    return path;
  }
  if (EXTERNAL_LIKE_URL.test(path)) throw new Error('unsupported URL');

  const queryOrHashIndex = path.search(/[?#]/u);
  const pathname = queryOrHashIndex === -1 ? path : path.slice(0, queryOrHashIndex);
  const suffix = queryOrHashIndex === -1 ? '' : path.slice(queryOrHashIndex);
  assertSafeInternalPath(pathname);
  const normalizedPath = pathname.replace(/^\/+/, '').replace(/\/{2,}/gu, '/');

  return `${normalizeBase(base)}${normalizedPath}${suffix}`;
}

export function sitePath(path = ''): string {
  return sitePathForBase(import.meta.env.BASE_URL, path);
}

function categoryDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

export function categorySlug(category: string): string {
  return CATEGORY_SLUGS.get(category) ?? `category-${categoryDigest(category)}`;
}

export function categoryRoutes(
  categories: readonly string[],
): Array<{ category: string; slug: string }> {
  const usedSlugs = new Set<string>();

  return categories.map((category) => {
    const slug = categorySlug(category);
    if (usedSlugs.has(slug)) throw new Error(`duplicate archive category slug: ${slug}`);
    usedSlugs.add(slug);
    return { category, slug };
  });
}
