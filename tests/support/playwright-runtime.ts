const PREVIEW_ORIGIN = 'http://127.0.0.1:4321';

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface TestSite {
  basePath: string;
  baseURL: string;
  route(relative?: string): string;
  url(relative?: string): string;
}

export interface PlaywrightRuntime {
  useDist: boolean;
  webServerCommand: string;
  webServerEnvironment?: Readonly<Record<string, string>>;
  reuseExistingServer: boolean;
  site: TestSite;
}

function throwInvalid(name: string): never {
  throw new Error(`invalid ${name}`);
}

function normalizeBasePath(source: string): string {
  if (source === '/') return '/';
  if (
    source.length === 0 ||
    source.trim() !== source ||
    !source.startsWith('/') ||
    source.startsWith('//') ||
    source.includes('//') ||
    source.includes('\\') ||
    source.includes('?') ||
    source.includes('#') ||
    source.includes('%')
  ) {
    return throwInvalid('BASE_PATH');
  }

  const normalized = source.endsWith('/') ? source.slice(0, -1) : source;
  const segments = normalized.slice(1).split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._-]+$/u.test(segment),
    )
  ) {
    return throwInvalid('BASE_PATH');
  }
  return normalized;
}

function assertSiteUrl(source: string | undefined): void {
  if (!source?.trim()) throw new Error('SITE_URL is required in dist-preview mode');
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return throwInvalid('SITE_URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return throwInvalid('SITE_URL');
  }
}

function createTestSite(basePath: string): TestSite {
  const prefix = basePath === '/' ? '/' : `${basePath}/`;
  const baseURL = `${PREVIEW_ORIGIN}${prefix}`;

  function urlFor(relative = ''): URL {
    if (relative.startsWith('/') || relative.includes('\\') || relative.includes('//')) {
      throw new Error('test route must stay inside BASE_PATH');
    }
    const url = new URL(relative || '.', baseURL);
    if (url.origin !== PREVIEW_ORIGIN || !url.pathname.startsWith(prefix)) {
      throw new Error('test route must stay inside BASE_PATH');
    }
    return url;
  }

  return {
    basePath,
    baseURL,
    route(relative = '') {
      const url = urlFor(relative);
      return `${url.pathname}${url.search}${url.hash}`;
    },
    url(relative = '') {
      return urlFor(relative).href;
    },
  };
}

export function createPlaywrightRuntime(environment: RuntimeEnvironment): PlaywrightRuntime {
  const flag = environment.PLAYWRIGHT_USE_DIST;
  if (flag !== undefined && flag !== '1') {
    throw new Error('PLAYWRIGHT_USE_DIST must be 1 when enabled');
  }
  const useDist = flag === '1';
  let basePath = '/';
  if (useDist) {
    if (environment.BASE_PATH === undefined) {
      throw new Error('BASE_PATH is required in dist-preview mode');
    }
    assertSiteUrl(environment.SITE_URL);
    basePath = normalizeBasePath(environment.BASE_PATH);
  }

  return {
    useDist,
    webServerCommand: useDist
      ? 'npm run preview -- --host 127.0.0.1'
      : 'npm run dev -- --host 127.0.0.1',
    // Astro auto-backgrounds under detected coding agents. A nonempty value suppresses that
    // detection; without --background, the server process then remains attached to Playwright.
    webServerEnvironment: useDist
      ? { ASTRO_PREVIEW_BACKGROUND: '0' }
      : { ASTRO_DEV_BACKGROUND: '0' },
    reuseExistingServer: !useDist && !environment.CI,
    site: createTestSite(basePath),
  };
}

export const playwrightRuntime = createPlaywrightRuntime(process.env);
