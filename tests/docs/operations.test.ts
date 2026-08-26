import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('owner operations guidance', () => {
  test('documents GitHub scheduled-workflow inactivity and recovery', async () => {
    const [readme, setup] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('docs/setup-google-drive.md', 'utf8'),
    ]);

    expect(setup).toContain('60 days');
    expect(setup).toContain('Enable workflow');
    expect(setup).toContain('minimumFileCount: 1000');
    expect(setup).toContain(
      'https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows',
    );
    expect(setup).toMatch(/cache may have expired/iu);
    expect(readme).toMatch(/scheduled.+03:17 UTC/isu);
    expect(readme).not.toContain('synchronizes Google Drive once per day');
  });

  test('describes folder IDs in generated data without weakening credential hygiene', async () => {
    const setup = await readFile('docs/setup-google-drive.md', 'utf8');

    expect(setup).toMatch(/parentIds.+GOOGLE_DRIVE_FOLDER_ID/isu);
    expect(setup).toMatch(/generated.+ignored.+not uploaded/isu);
    expect(setup).toMatch(/JSON credentials.+never.+generated.+published/isu);
    expect(setup).not.toContain(
      'Do not put either value in repository variables, workflow files, commits, artifacts, or generated catalog data.',
    );
  });

  test('explains why fixture builds omit production cover selections', async () => {
    const setup = await readFile('docs/setup-google-drive.md', 'utf8');

    expect(setup).toMatch(/fixture.+omit.+production cover/isu);
    expect(setup).toMatch(/fallback cover/iu);
    expect(setup).toMatch(/production sync.+cover IDs/isu);
  });
});
