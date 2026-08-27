import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  base: process.env.BASE_PATH ?? '/',
  build: {
    /**
     * Inline the stylesheet into every page instead of linking one hashed file.
     *
     * GitHub Pages serves HTML with `max-age=600` and cannot be configured, so a
     * browser can hold a page for ten minutes after a deploy. The stylesheet name
     * is content-hashed, so a deploy that touches CSS renames it and deletes the
     * old one: the cached HTML then requests a file that is gone, gets a 404, and
     * the site renders completely unstyled until a manual refresh. That was
     * reported in the wild, not theorised.
     *
     * Inlined, stale HTML carries stale CSS — slightly outdated styling instead
     * of none — and there is no separate file to go missing. The cost is 19KB
     * raw, 4.6KB gzipped, repeated per page instead of cached across pages, and
     * one fewer round trip before first paint.
     */
    inlineStylesheets: 'always',
  },
});
