import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  base: process.env.BASE_PATH ?? '/',
  /**
   * Every internal link already ends in a slash and the build already emits directory-style
   * pages, so this changes no emitted output. What it changes is the route pattern: 'always'
   * compiles routes to require the slash, so the next link written without one 404s in dev
   * instead of resolving locally and silently taking a 301 on GitHub Pages. Astro has no
   * build-time check for this, so a failing dev-server request is the enforcement available.
   */
  trailingSlash: 'always',
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
