import { describe, expect, test } from 'vitest';
import { sitePathForBase } from '../../src/lib/url';

describe('sitePathForBase', () => {
  test('builds root and nested paths at the domain root', () => {
    expect(sitePathForBase('/', '')).toBe('/');
    expect(sitePathForBase('/', '/games/piposh-1/')).toBe('/games/piposh-1/');
  });

  test('prefixes internal paths with a normalized GitHub Pages base', () => {
    expect(sitePathForBase('/guillotine-archive', '')).toBe('/guillotine-archive/');
    expect(sitePathForBase('/guillotine-archive/', '/search/?q=פיפוש#results')).toBe(
      '/guillotine-archive/search/?q=פיפוש#results',
    );
    expect(sitePathForBase('//guillotine-archive//', '/games//piposh-1/')).toBe(
      '/guillotine-archive/games/piposh-1/',
    );
  });

  test.each([
    'https://drive.google.com/file/d/one/view',
    'http://example.com/archive',
    'mailto:archive@example.com',
    'tel:+9721234567',
  ])('leaves external URL %s untouched', (url) => {
    expect(sitePathForBase('/guillotine-archive/', url)).toBe(url);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,archive',
    'ftp://example.com/archive',
    '//drive.google.com/file/d/one/view',
    'https:example.com/archive',
  ])('rejects unsupported external-looking URL %s', (url) => {
    expect(() => sitePathForBase('/guillotine-archive/', url)).toThrow('unsupported URL');
  });

  test.each([
    '/../secret',
    '/games/./secret',
    '/games/%2e%2e/secret',
    '/games/%2E./secret',
    '/games/.%2e/secret',
    '/games/%252e%252e/secret',
    '/games/%2e%2e%2fsecret',
    '/games/%2e%2e%5csecret',
    '/games\\..\\secret',
  ])('rejects unsafe dot-segment path %s', (path) => {
    expect(() => sitePathForBase('/guillotine-archive/', path)).toThrow(
      'unsafe internal path',
    );
  });

  test('rejects an unsafe configured base path', () => {
    expect(() => sitePathForBase('/archive/%2e%2e/escape/', '/games/')).toThrow(
      'unsafe internal path',
    );
  });

  test('supports same-page query and fragment references deliberately', () => {
    expect(sitePathForBase('/guillotine-archive/', '?q=פיפוש')).toBe('?q=פיפוש');
    expect(sitePathForBase('/guillotine-archive/', '#results')).toBe('#results');
  });

  test('does not alter slashes inside a query or fragment', () => {
    expect(sitePathForBase('/archive/', '/search/?next=/one//../two#part//three')).toBe(
      '/archive/search/?next=/one//../two#part//three',
    );
  });
});
