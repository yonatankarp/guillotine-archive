import { describe, expect, test } from 'vitest';
import { catalogItemCountLabel, homepageGameSummary } from '../../src/lib/homepage';

describe('homepageGameSummary', () => {
  test('uses the deliberate Piposh 1 homepage summary', () => {
    expect(
      homepageGameSummary(
        'piposh-1',
        'פיפוש עולה למטוס, התעלומה עולה איתו, וקיבינימאט — עכשיו גם הקבצים מצטרפים לחקירה.',
      ),
    ).toBe('פיפוש עולה למטוס, התעלומה עולה איתו, ועכשיו גם הקבצים מצטרפים לחקירה.');
  });

  test('does not rewrite arbitrary curator copy', () => {
    const summary = 'קיבינימאט — זה טקסט אוצרותי מכוון.';

    expect(homepageGameSummary('future-game', summary)).toBe(summary);
  });
});

describe('catalogItemCountLabel', () => {
  test('reports a neutral zero instead of guessing synchronization state', () => {
    expect(catalogItemCountLabel(0)).toBe('0 קבצים מקוטלגים');
  });

  test('reports the factual official item count', () => {
    expect(catalogItemCountLabel(3)).toBe('3 פריטים רשמיים');
  });

  test('uses grammatical singular for one official item', () => {
    expect(catalogItemCountLabel(1)).toBe('פריט רשמי אחד');
  });
});
