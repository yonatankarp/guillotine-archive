import { describe, expect, test } from 'vitest';
import { parseCurator } from '../../src/catalog/curator';

describe('parseCurator', () => {
  test('parses collection metadata and path-prefix rules', () => {
    const config = parseCurator(`
minimumFileCount: 1000
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    year: 1999
    summaryHe: המשחק המקורי
    aliasesHe:
      - פיפוש הראשון
    tagsHe:
      - הרפתקה
    rules:
      - match: path-prefix
        value: משחקים מלאים/פיפוש 1
        relationship: part-of-release
`);

    expect(config.minimumFileCount).toBe(1000);
    expect(config.collections[0]).toMatchObject({
      slug: 'piposh-1',
      titleHe: 'פיפוש 1',
      rules: [
        {
          match: 'path-prefix',
          value: 'משחקים מלאים/פיפוש 1',
          relationship: 'part-of-release',
        },
      ],
    });
  });

  test('rejects duplicate collection slugs', () => {
    expect(() =>
      parseCurator(`
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    summaryHe: המשחק המקורי
  - slug: piposh-1
    titleHe: פיפוש 1 נוסף
    type: game
    summaryHe: משחק נוסף
`),
    ).toThrow('duplicate collection slug: piposh-1');
  });

  test.each(['aliasesHe', 'tagsHe'])('rejects an empty %s entry', (field) => {
    expect(() =>
      parseCurator(`
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    summaryHe: המשחק המקורי
    ${field}:
      - ""
`),
    ).toThrow();
  });

  test('rejects unknown top-level and collection keys', () => {
    expect(() =>
      parseCurator(`
minimumFilesCount: 1000
collections: []
`),
    ).toThrow();

    expect(() =>
      parseCurator(`
collections:
  - slug: piposh-1
    titleHe: פיפוש 1
    type: game
    summaryHe: המשחק המקורי
    rulez: []
`),
    ).toThrow();
  });

  test.each([
    ['titleHe', 'titleHe: "   "'],
    ['summaryHe', 'summaryHe: "   "'],
    ['aliasesHe entry', 'aliasesHe:\n      - "   "'],
    ['tagsHe entry', 'tagsHe:\n      - "   "'],
    [
      'rule value',
      'rules:\n      - match: path-prefix\n        value: "   "\n        relationship: about',
    ],
    [
      'rule groupHe',
      'rules:\n      - match: path-prefix\n        value: valid\n        relationship: about\n        groupHe: "   "',
    ],
    ['descriptionHe', 'descriptionHe: "   "'],
    ['coverFileId', 'coverFileId: "   "'],
  ])('rejects whitespace-only %s', (field, fieldYaml) => {
    const titleYaml = field === 'titleHe' ? '' : 'titleHe: פיפוש 1';
    const summaryYaml = field === 'summaryHe' ? '' : 'summaryHe: המשחק המקורי';
    expect(() =>
      parseCurator(`
collections:
  - slug: piposh-1
    ${titleYaml}
    type: game
    ${summaryYaml}
    ${fieldYaml}
`),
    ).toThrow();
  });
});
