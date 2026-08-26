import { afterEach, describe, expect, test, vi } from 'vitest';

const environmentNames = ['PLAYWRIGHT_USE_DIST', 'SITE_URL', 'BASE_PATH'] as const;
const originalEnvironment = new Map(
  environmentNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of environmentNames) {
    const value = originalEnvironment.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

async function loadConfig(environment: Partial<Record<(typeof environmentNames)[number], string>>) {
  for (const name of environmentNames) {
    const value = environment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  return (await import('../../playwright.config')).default;
}

function webServer(config: Awaited<ReturnType<typeof loadConfig>>) {
  expect(config.webServer).toBeDefined();
  expect(Array.isArray(config.webServer)).toBe(false);
  return config.webServer as Exclude<typeof config.webServer, undefined | readonly unknown[]>;
}

describe('Playwright server mode', () => {
  test('keeps local development at the root with the Astro dev server', async () => {
    const config = await loadConfig({});

    expect(webServer(config)).toMatchObject({
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4321/',
      env: { ASTRO_DEV_BACKGROUND: '0' },
    });
    expect(config.use?.baseURL).toBe('http://127.0.0.1:4321/');
  });

  test('previews the existing project-base dist without rebuilding it', async () => {
    const config = await loadConfig({
      PLAYWRIGHT_USE_DIST: '1',
      SITE_URL: 'https://example.github.io',
      BASE_PATH: '/guillotine-archive',
    });
    const server = webServer(config);

    expect(server).toMatchObject({
      command: 'npm run preview -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4321/guillotine-archive/',
      reuseExistingServer: false,
      env: { ASTRO_PREVIEW_BACKGROUND: '0' },
    });
    expect(server.command).not.toContain('build');
    expect(config.use?.baseURL).toBe('http://127.0.0.1:4321/guillotine-archive/');
  });

  test.each([
    ['missing leading slash', 'repo'],
    ['protocol-relative path', '//evil.example'],
    ['double slash', '/repo//nested'],
    ['literal traversal', '/repo/../outside'],
    ['encoded traversal', '/repo/%2e%2e/outside'],
    ['query', '/repo?outside=true'],
    ['fragment', '/repo#outside'],
  ])('rejects an invalid BASE_PATH with %s', async (_case, basePath) => {
    await expect(
      loadConfig({
        PLAYWRIGHT_USE_DIST: '1',
        SITE_URL: 'https://example.github.io',
        BASE_PATH: basePath,
      }),
    ).rejects.toThrow('invalid BASE_PATH');
  });

  test.each(['yes', 'true', '2'])('rejects ambiguous preview flag %s', async (flag) => {
    await expect(loadConfig({ PLAYWRIGHT_USE_DIST: flag })).rejects.toThrow(
      'PLAYWRIGHT_USE_DIST must be 1 when enabled',
    );
  });

  test('requires the production build environment in dist-preview mode', async () => {
    await expect(
      loadConfig({ PLAYWRIGHT_USE_DIST: '1', BASE_PATH: '/repo' }),
    ).rejects.toThrow('SITE_URL is required');
    await expect(
      loadConfig({ PLAYWRIGHT_USE_DIST: '1', SITE_URL: 'https://example.github.io' }),
    ).rejects.toThrow('BASE_PATH is required');
  });
});
