const SUPPORTED_EXTERNAL_URL = /^(?:https?:\/\/|mailto:|tel:)/iu;
const EXTERNAL_LIKE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

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
