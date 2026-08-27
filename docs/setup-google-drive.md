# Google Drive and GitHub Pages setup

The production workflow reads public archive metadata from Google Drive, validates and builds the
static site, and publishes the result to GitHub Pages. Google credentials are available only to the
Drive sync step and never become part of the built website.

## 1. Create the Google Cloud identity

1. In Google Cloud Console, create or select a project dedicated to this archive.
2. Enable the Google Drive API for that project.
3. Create a service account for the archive sync.
4. Do not grant the service account any Google Cloud project roles. Folder sharing in Drive is the
   only access it needs.
5. Create one JSON key for the service account and download it to a secure local location.

Treat the JSON key as a password. Keep it out of this repository, shell history, screenshots,
issue reports, build logs, and chat messages. Do not place it in `.env` files that might be shared.
If it is exposed, disable or delete that key, create a replacement, update the GitHub secret, and
run the workflow manually. After a successful run with the replacement, remove any superseded key.

## 2. Share only the archive

1. Copy the service account email from its Google Cloud details.
2. In Google Drive, share only the archive root folder with that email as **Viewer**. Do not share a
   broader personal or team Drive folder.
3. Give the public archive content **Anyone with the link — Viewer** access. The service-account
   share lets the build read metadata; public link access is separately required for visitor view
   and download links.
4. Test a representative file's Drive view and download links in a signed-out browser window. An
   organization policy can prevent public sharing even when the UI appears configured.

Copy the root folder ID from its Drive URL. For a URL shaped like
`https://drive.google.com/drive/folders/FOLDER_ID`, use only `FOLDER_ID`.

## 3. Add the GitHub Actions secrets

In the GitHub repository, open **Settings → Secrets and variables → Actions** and create exactly
these repository secrets:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: the complete contents of the downloaded JSON key.
- `GOOGLE_DRIVE_FOLDER_ID`: the archive root folder ID.

Keep both values in GitHub Secrets so operational configuration is scoped to the `Sync Google
Drive` step and is not interpolated into shell commands. Only `.github/workflows/sync.yml` reads
them; the deployment workflow holds no Drive credentials at all. The JSON credentials are never
written to generated data or published.

The catalog is committed to the repository and served from it, so it must not carry the folder ID.
Catalog records deliberately omit `parentIds`, and `parents` is not requested from the Drive API,
because the scanner navigates with an `in parents` query instead. Per-file `viewUrl` and
`downloadUrl` values do contain Drive file IDs, which is unchanged: those are already public in the
published search index for files the archive intends to share. Treat `GOOGLE_DRIVE_FOLDER_ID` as
operational configuration and keep it out of commits, workflow files and generated data.

## 4. Enable Pages and perform the first import

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. Merge the workflow and curator configuration to `main`.
4. Open **Actions → Sync archive and deploy Pages → Run workflow** and select `main`.
5. Review the build and deployment jobs and open the URL reported by the deployment environment.

The workflow is intentionally limited to `main`, including manual runs. It also runs on pushes to
`main` and is scheduled once per day at `17 3 * * *`, which is 03:17 UTC. GitHub may start a
scheduled workflow later than the nominal minute during periods of high load, so the cron entry is
not a guarantee of uninterrupted daily execution.

GitHub automatically disables scheduled workflows in a public repository after 60 days without
repository activity. This matters for a largely complete archive that may go months without a
commit. Check **Actions → Sync archive and deploy Pages** if daily runs disappear. A disabled
workflow shows an **Enable workflow** control; enable it, then use **Run workflow** on `main` to
perform an immediate sync. See GitHub's official guide to
[disabling and enabling workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows).
After a long inactive period, the baseline cache may have expired. The first restored run may
therefore have no historical shrink comparison; `minimumFileCount: 1000` remains the absolute
first protection. If uninterrupted synchronization is operationally important, an external monitor
may alert when the expected workflow run is missing, but it is not required to operate the site.

The default workflow builds a project Pages URL:
`https://OWNER.github.io/REPOSITORY/`. For a custom domain or an account Pages repository, adjust
the `SITE_URL` and `BASE_PATH` values in the workflow to the real public URL. A custom domain may
also require the repository's normal Pages DNS and domain configuration; the workflow does not
create that configuration.

## 5. Understand the validation gates

The build job runs in this order:

1. check out the repository without retaining Git credentials;
2. install Node 22 dependencies and Chromium;
3. restore `.astro/archive-baseline.json` from the newest successful main-branch cache;
4. synchronize Drive and generate the catalog, search index, covers, and curator report;
5. run unit tests;
6. build the production site with its project Pages base path;
7. preview the already-built `dist` directory with the same project base path and run every
   configured Chromium viewport project against that artifact without rebuilding it;
8. upload only `reports/curator-report.json` as the short-lived `curator-report` artifact;
9. save the new baseline and upload the Pages artifact only after all validation succeeds;
10. deploy in a separate job that depends on the complete build job.

The baseline cache remembers the last validated archive size across fresh runners. Cache keys are
versioned and unique to a workflow run and attempt; restore uses the latest matching successful
main-branch entry. A cache miss on the first run is expected. On that run,
`minimumFileCount: 1000` in `curator/collections.yml` still prevents a suspiciously small import.
On later runs, validation also stops the build if a previously substantial archive falls below
half of its recorded file count. Do not lower these protections just to force a deployment; first
find the missing permission, wrong folder ID, or unexpected archive change.

The production code retains bounded downloads: Drive media responses are limited to 32 MiB, text
extraction has per-file and total budgets, and only explicitly selected covers are processed. The
workflow does not bypass those bounds.

If sync, tests, build, report upload, cache save, Pages configuration, or artifact upload fails,
the deployment job cannot run. The previous successful Pages deployment remains the active site;
the failed run does not publish its generated output.

## 6. Curator workflow and reports

Use `curator/collections.yml` for durable editorial decisions. Add or refine official release
relationships and cover IDs there, then check the change locally:

Exceptional files can receive Hebrew search metadata without being assigned to a collection. Add
an entry under `files:` keyed by the stable Drive file ID; `titleHe`, `descriptionHe`, `aliasesHe`,
and `tagsHe` are optional:

```yaml
files:
  DRIVE_FILE_ID:
    titleHe: כותרת עברית
    aliasesHe: [שם חלופי]
    tagsHe: [תגית]
```

The production sync validates every key. An override that references a missing Drive item ID fails
the build instead of silently leaving stale editorial metadata behind.

```bash
npm ci
npx playwright install chromium
npm run sync:fixture
npm test
npm run build
npm run test:e2e
```

To reproduce the GitHub project Pages artifact gate locally, build and preview with the same
environment values:

```bash
SITE_URL=https://example.github.io BASE_PATH=/guillotine-archive npm run build
PLAYWRIGHT_USE_DIST=1 SITE_URL=https://example.github.io BASE_PATH=/guillotine-archive npm run test:e2e
```

The fixture sync is deterministic, needs no Google credentials, and is the right default for local
development. It intentionally omits production cover selections and production file overrides
because those Drive IDs do not exist in the small local fixture; fixture pages therefore use the
same honest fallback covers as a game without a selected scan. This affects only fixture
synchronization. Production sync keeps the configured cover IDs and file overrides, and fails
instead of silently ignoring a missing or unreadable referenced file.

A real local import uses `npm run sync:drive` and requires the same two environment
values as GitHub. Keep those values in a secure local secret store and out of commands that may be
recorded. Never commit credentials, `.astro/archive-baseline.json`, generated catalog/search data,
downloaded cover output, or curator reports.

Every workflow run tries to upload `reports/curator-report.json` as `curator-report`, even when a
later validation step fails. It is retained for seven days. The report contains validation errors,
warnings, and unclassified Drive IDs; it does not contain the generated catalog, archive files,
credentials, or the baseline cache. If sync fails before it can create a report, the artifact may
be absent by design, so read the redacted step error in the job log.

## Troubleshooting

- **A required environment variable error:** confirm both GitHub secret names are exact and have
  non-empty values.
- **Drive permission or missing-folder errors:** confirm the folder ID and share that root folder,
  not a shortcut or an unrelated parent, with the service account as Viewer.
- **The site opens but downloads request access:** public link access is separate from the service
  account's Viewer share. Test the original file while signed out.
- **The archive is below its minimum or shrank unexpectedly:** inspect the folder ID, Drive share,
  organization policy, and actual archive contents. Use the curator report; do not weaken the
  count gates until the change is understood.
- **No baseline was restored:** this is normal on the first successful run or after a cache version
  change. The curator minimum still applies. A successful validated main run saves the successor.
- **Pages reports a missing configuration:** confirm **Settings → Pages → Source** is set to
  **GitHub Actions**, then rerun the workflow on `main`.
- **Links omit or duplicate the repository path:** verify `SITE_URL` and `BASE_PATH` against the
  actual Pages URL, especially after adding a custom domain.
- **A large file shows a Drive confirmation or quota screen:** Drive owns the original transfer and
  may show its own confirmation, scanning, access, or quota UI; that is not generated by this site.

## Maintaining pinned Actions

The action release tags and immutable SHAs in `deploy-pages.yml` were verified against the
official `actions/*` repositories on 2026-08-26. Full SHAs reduce the risk of a mutable tag changing
the code used by a privileged workflow. To update an action, verify a current official release,
review its Node/runtime and permission requirements, replace the 40-character SHA, update the
adjacent version comment, run the workflow contract test, and review the resulting workflow diff.
