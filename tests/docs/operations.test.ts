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
    // The catalog is committed now, so the reason folder IDs stay private is
    // that they are no longer in it, not that the file is ignored.
    expect(setup).toMatch(/catalog is committed.+must not carry the folder ID/isu);
    expect(setup).toMatch(/omit `parentIds`/iu);
    expect(setup).toMatch(/deployment workflow holds no Drive credentials/iu);
    expect(setup).toMatch(/JSON credentials.+never.+written to generated data/isu);
    expect(setup).not.toContain(
      'Do not put either value in repository variables, workflow files, commits, artifacts, or generated catalog data.',
    );
  });

  test('explains why fixture builds omit production-only Drive references', async () => {
    const setup = await readFile('docs/setup-google-drive.md', 'utf8');

    expect(setup).toMatch(/fixture.+omit.+production cover/isu);
    expect(setup).toMatch(/fixture.+omit.+production file override/isu);
    expect(setup).toMatch(/fallback cover/iu);
    expect(setup).toMatch(/production sync.+cover IDs.+file overrides/isu);
  });

  test('documents Drive-ID file metadata overrides and their validation boundary', async () => {
    const setup = await readFile('docs/setup-google-drive.md', 'utf8');

    expect(setup).toContain('files:');
    expect(setup).toMatch(/Drive file ID.+titleHe.+aliasesHe.+tagsHe/isu);
    expect(setup).toMatch(/missing Drive item ID.+fails/iu);
  });
});
