import type { Page } from '@playwright/test';

/**
 * True when the page can genuinely be scrolled sideways.
 *
 * Deliberately behavioural rather than `scrollWidth > clientWidth`. This document is
 * `dir="rtl"`, and in RTL a nested horizontal scroller inflates
 * `documentElement.scrollWidth` even when the page itself cannot move: /missing/ measured
 * 1253 against a 320 viewport while `window.scrollX` refused to budge in either direction,
 * because the table was correctly contained inside a 299px `.scroll-x` box. That is a false
 * positive, and it fails the page for doing the right thing.
 *
 * Attempting the scroll is also a STRONGER check than the arithmetic it replaces: it asserts
 * the thing a visitor on a phone actually experiences, in either writing direction, and it
 * cannot be fooled by a descendant that legitimately scrolls itself.
 */
export function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const start = window.scrollX;
    window.scrollTo({ left: -100_000, top: window.scrollY, behavior: 'instant' });
    const leftmost = window.scrollX;
    window.scrollTo({ left: 100_000, top: window.scrollY, behavior: 'instant' });
    const rightmost = window.scrollX;
    window.scrollTo({ left: start, top: window.scrollY, behavior: 'instant' });

    return leftmost !== rightmost;
  });
}
