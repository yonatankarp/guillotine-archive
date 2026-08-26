import { describe, expect, it } from 'vitest';
import {
  externalHttpUrl,
  sitePathForBrowserBase,
} from '../../src/lib/browser-url';

describe('sitePathForBrowserBase', () => {
  it('resolves internal routes under root and GitHub Pages base paths', () => {
    expect(sitePathForBrowserBase('/', '/games/piposh-1/')).toBe('/games/piposh-1/');
    expect(
      sitePathForBrowserBase('/guillotine-archive/', '/games/piposh-1/'),
    ).toBe('/guillotine-archive/games/piposh-1/');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    '//unsafe.example/file',
    '../admin',
    '%2e%2e/admin',
    '%252e%252e/admin',
    String.raw`safe\..\admin`,
    '%E0%A4%A',
  ])('rejects unsafe internal route %s', (path) => {
    expect(sitePathForBrowserBase('/archive/', path)).toBeNull();
  });
});

describe('externalHttpUrl', () => {
  it('accepts only absolute HTTP(S) URLs', () => {
    expect(externalHttpUrl('https://drive.google.com/file/d/id/view')).toBe(
      'https://drive.google.com/file/d/id/view',
    );
    expect(externalHttpUrl('http://example.test/file')).toBe('http://example.test/file');
    expect(externalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(externalHttpUrl('data:text/html,unsafe')).toBeNull();
    expect(externalHttpUrl('//unsafe.example/file')).toBeNull();
    expect(externalHttpUrl('/relative/file')).toBeNull();
    expect(externalHttpUrl('not a URL')).toBeNull();
  });
});
