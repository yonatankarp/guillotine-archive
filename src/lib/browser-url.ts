const EXTERNAL_LIKE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

function decodeForSafety(path: string): string | null {
  let decoded = path;

  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
  } catch {
    return null;
  }

  return null;
}

function safeInternalPath(path: string): boolean {
  const decoded = decodeForSafety(path);
  if (decoded === null) return false;

  return !decoded
    .replace(/\\/gu, '/')
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

export function sitePathForBrowserBase(base: string, path: string): string | null {
  if (
    base.trim() !== base ||
    path.trim() !== path ||
    EXTERNAL_LIKE_URL.test(path)
  ) {
    return null;
  }

  const suffixIndex = path.search(/[?#]/u);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);
  if (!safeInternalPath(base) || !safeInternalPath(pathname)) return null;

  const normalizedBase = `/${base}`
    .replace(/\\/gu, '/')
    .replace(/\/{2,}/gu, '/')
    .replace(/\/+$/u, '');
  const normalizedPath = pathname
    .replace(/\\/gu, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/gu, '/');

  return `${normalizedBase || ''}/${normalizedPath}${suffix}`;
}

export function externalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() !== value || value.startsWith('//')) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
