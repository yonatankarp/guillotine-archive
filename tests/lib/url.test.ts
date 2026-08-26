import { describe, expect, test } from 'vitest';
import { categoryRoutes, categorySlug, sitePathForBase } from '../../src/lib/url';

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

describe('archive category routes', () => {
  test.each([
    ['משחקים מלאים', 'games'],
    ['פתרונות', 'solutions'],
    ['אחר', 'other'],
  ])('uses the stable slug for %s', (category, slug) => {
    expect(categorySlug(category)).toBe(slug);
  });

  test('encodes unknown categories into deterministic ASCII without merging them', () => {
    const first = categorySlug('חומר חדש');
    const second = categorySlug('חומר חדש!');

    expect(first).toMatch(/^category-[a-f0-9]+$/u);
    expect(categorySlug('חומר חדש')).toBe(first);
    expect(second).not.toBe(first);
    expect(categoryRoutes(['חומר חדש', 'חומר חדש!'])).toEqual([
      { category: 'חומר חדש', slug: first },
      { category: 'חומר חדש!', slug: second },
    ]);
  });

  test('treats inherited object property names as unknown categories', () => {
    expect(categorySlug('toString')).toMatch(/^category-[a-f0-9]+$/u);
    expect(categorySlug('__proto__')).toMatch(/^category-[a-f0-9]+$/u);
  });

  test('bounds long and adversarial unknown category slugs below filesystem limits', () => {
    const longHebrew = 'א'.repeat(127);
    const adversarialUnicode = `${'🗂️'.repeat(80)}\u0000/../%2e%2e/\u202e`;
    const longSlug = categorySlug(longHebrew);
    const adversarialSlug = categorySlug(adversarialUnicode);

    for (const slug of [longSlug, adversarialSlug]) {
      expect(Buffer.byteLength(slug, 'utf8')).toBeLessThanOrEqual(64);
      expect(slug).toMatch(/^category-[a-f0-9]+$/u);
    }
    expect(categorySlug(longHebrew)).toBe(longSlug);
    expect(adversarialSlug).not.toBe(longSlug);
    expect(adversarialSlug).not.toBe(categorySlug('אחר'));
  });

  test('rejects a slug collision instead of silently merging category pages', () => {
    expect(() => categoryRoutes(['משחקים מלאים', 'משחקים מלאים'])).toThrow(
      'duplicate archive category slug: games',
    );
  });
});
