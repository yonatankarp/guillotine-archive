# Guillotine Archive

A Hebrew RTL static archive for Guillotine games and related materials. Astro builds the site,
Google Drive stores the original files, and GitHub Pages serves the public pages. There is no
server runtime and no Google credential is sent to a visitor's browser.

## Requirements

- Node.js 22.12 or newer in the Node 22 release line
- npm (the lockfile is committed)
- Chromium for browser tests

## Local development with fixture data

Use the small deterministic fixture for normal development. It does not contact Google Drive or
need credentials.

```bash
npm ci
npx playwright install chromium
npm run sync:fixture
npm run dev
```

`npm ci` reproduces the committed lockfile. Use `npm install` only when intentionally changing
dependencies and commit the resulting `package-lock.json` update.

The sync commands write ignored generated artifacts under `src/generated`, `public/data`,
`public/generated`, and `reports`. Do not commit those artifacts.

## Quality checks

Generate fixture data before checks that build or open the site:

```bash
npm run sync:fixture
npm test
npm run check
npm run build
npm run test:e2e
```

For a faster desktop-only browser check, run:

```bash
npm run test:e2e -- --project="Desktop Chrome"
```

## Archive updates

Edit `curator/collections.yml` to define collection titles, aliases, tags, selected cover IDs, and
official-release relationships. Press coverage and fan works should remain separate unless an
explicit editorial relationship is intended. Validate curator changes locally with fixture data,
then run the GitHub workflow manually after merging them to `main`.

GitHub Actions is scheduled to synchronize Google Drive once per day at 03:17 UTC, and also runs
after a push to `main`. GitHub can automatically disable the schedule after 60 days without
repository activity in a public repository; the owner guide explains how to detect and re-enable
it. A failed sync or validation does not replace the previous successful Pages deployment.

See [Google Drive setup](docs/setup-google-drive.md) for the one-time owner configuration, the
first real import, daily operation, and troubleshooting.

## Deployment notes

The workflow builds a GitHub project Pages URL using
`https://OWNER.github.io/REPOSITORY/`. If the repository becomes an account Pages site or gains a
custom domain, update `SITE_URL` and `BASE_PATH` in `.github/workflows/deploy-pages.yml` to match
the published URL before deploying.

Third-party Actions are pinned to immutable commit SHAs. Their release tags and pins were checked
against the official action repositories on 2026-08-26. When updating an action, verify its
official release tag, replace the full SHA, and update the adjacent version comment together.
