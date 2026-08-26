const HOMEPAGE_SUMMARIES: Readonly<Record<string, string>> = {
  'piposh-1':
    'פיפוש עולה למטוס, התעלומה עולה איתו, ועכשיו גם הקבצים מצטרפים לחקירה.',
};

export function homepageGameSummary(slug: string, curatedSummary: string): string {
  return HOMEPAGE_SUMMARIES[slug] ?? curatedSummary;
}

export function catalogItemCountLabel(officialCount: number): string {
  return officialCount === 0 ? '0 קבצים מקוטלגים' : `${officialCount} פריטים רשמיים`;
}
