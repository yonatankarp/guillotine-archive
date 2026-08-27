import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

import {
  allSteps,
  expectApprovedPins,
  loadWorkflow,
  namedStep,
  pinnedAction,
  record,
  requiredString,
  stepNames,
  steps,
} from '../support/workflow';

const run = promisify(execFile);

/** A repository whose archive artifacts exist but have never been committed. */
async function repositoryWithUntrackedArchive(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sync-guard-'));
  await run('git', ['init', '--quiet'], { cwd: root });
  await mkdir(join(root, 'src/generated'), { recursive: true });
  await writeFile(join(root, 'src/generated/catalog.json'), '{"items":[]}\n');
  await run('git', ['commit', '--quiet', '--allow-empty', '-m', 'root'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  return root;
}

const WORKFLOW = '.github/workflows/sync.yml';
const ARTIFACT_PATHS = 'src/generated public/data public/generated';

async function load() {
  return loadWorkflow(WORKFLOW);
}

async function syncJob() {
  const { workflow } = await load();
  const job = record(record(workflow.jobs, 'jobs').sync, 'jobs.sync');
  return { job, jobSteps: steps(job, 'jobs.sync') };
}

describe('archive sync workflow', () => {
  test('runs only when a person asks for it', async () => {
    const { workflow } = await load();
    const triggers = record(workflow.on, 'on');

    expect(new Set(Object.keys(triggers))).toEqual(new Set(['workflow_dispatch']));
    expect(triggers.workflow_dispatch).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: 'archive-sync',
      'cancel-in-progress': false,
    });
  });

  test('is the only workflow holding Drive credentials, and never deploys', async () => {
    const { source, workflow } = await load();
    const { workflow: deploy } = await loadWorkflow('.github/workflows/deploy-pages.yml');

    expect(source).toContain('secrets.GOOGLE_SERVICE_ACCOUNT_JSON');
    expect(source).toContain('secrets.GOOGLE_DRIVE_FOLDER_ID');

    const deployJobs = Object.keys(record(deploy.jobs, 'jobs'));
    expect(deployJobs).not.toContain('sync');

    const names = stepNames(allSteps(workflow));
    for (const forbidden of ['Configure GitHub Pages', 'Upload Pages artifact', 'Deploy GitHub Pages']) {
      expect(names, 'sync never touches Pages').not.toContain(forbidden);
    }
  });

  test('grants only the permissions needed to open a pull request', async () => {
    const { workflow } = await load();
    expect(workflow.permissions).toEqual({});

    const { job } = await syncJob();
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  });

  test('pins every action to an approved immutable SHA', async () => {
    const { source, workflow } = await load();
    const used = expectApprovedPins(source, workflow);

    expect(new Set(used.map((step) => requiredString(step.uses, 'uses').split('@')[0]))).toEqual(
      new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact']),
    );
    expect(namedStep(used, 'Check out repository').uses).toBe(pinnedAction('actions/checkout'));
    expect(namedStep(used, 'Set up Node').uses).toBe(pinnedAction('actions/setup-node'));
    expect(namedStep(used, 'Upload curator report').uses).toBe(
      pinnedAction('actions/upload-artifact'),
    );
  });

  test('syncs, proves the site still builds, then opens the pull request last', async () => {
    const { jobSteps } = await syncJob();

    expect(stepNames(jobSteps)).toEqual([
      'Check out repository',
      'Set up Node',
      'Install dependencies',
      'Sync Google Drive',
      'Build production site',
      'Upload curator report',
      'Open sync pull request',
    ]);

    expect(namedStep(jobSteps, 'Sync Google Drive').env).toEqual({
      GOOGLE_SERVICE_ACCOUNT_JSON: '${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}',
      GOOGLE_DRIVE_FOLDER_ID: '${{ secrets.GOOGLE_DRIVE_FOLDER_ID }}',
    });
    expect(namedStep(jobSteps, 'Upload curator report')).toMatchObject({ if: 'always()' });
  });

  test('keeps the checkout credentials the push needs, and nothing more', async () => {
    const { jobSteps } = await syncJob();
    const checkout = namedStep(jobSteps, 'Check out repository');

    expect(record(checkout.with, 'checkout.with')['persist-credentials']).toBe(true);
  });

  test('commits only archive artifacts, and only when the archive actually changed', async () => {
    const { jobSteps } = await syncJob();
    const open = requiredString(namedStep(jobSteps, 'Open sync pull request').run, 'run');

    expect(open).toContain('set -euo pipefail');
    expect(open).toContain(`git add -- ${ARTIFACT_PATHS}`);
    expect(open).toContain('gh pr create');
    expect(open, 'never a blanket add').not.toMatch(/git add\s+(-A|--all|\.)/u);
    expect(open, 'never pushes straight to the default branch').not.toMatch(/git push[^\n]*\bmain\b/u);
  });

  test('puts a census in the pull request body, because the binary diff is unreadable', async () => {
    const { jobSteps } = await syncJob();
    const open = requiredString(namedStep(jobSteps, 'Open sync pull request').run, 'run');

    expect(open).toContain('src/generated/catalog.json');
    expect(open).toMatch(/items\.length/u);
    expect(open).toMatch(/collections\.length/u);
    expect(open).toContain('generatedAt');
    // Also to the run summary, so a refused pull request never loses the census.
    expect(open).toContain('GITHUB_STEP_SUMMARY');
  });

  test('does not lose the sync when the repository forbids Actions opening pull requests', async () => {
    const { jobSteps } = await syncJob();
    const open = requiredString(namedStep(jobSteps, 'Open sync pull request').run, 'run');

    // The push happens before the pull request is attempted, and a refusal is
    // handled rather than left to `set -e`.
    expect(open.indexOf('git push')).toBeLessThan(open.indexOf('gh pr create'));
    expect(open).toMatch(/if\s+printf[^\n]*\|\s*gh pr create/u);
    expect(open).toContain('compare/main...');
    expect(open).toContain('GITHUB_SERVER_URL');
  });

  test('detects a first-run archive that is untracked rather than modified', async () => {
    const root = await repositoryWithUntrackedArchive();
    const paths = ['src/generated', 'public/data', 'public/generated'];

    // What the guard uses: untracked artifacts count as a change.
    const { stdout } = await run('git', ['status', '--porcelain', '--', ...paths], { cwd: root });
    expect(stdout.trim(), 'porcelain sees the untracked catalog').not.toBe('');

    // Why `git diff` was wrong: it reports tracked changes only, so on the very
    // first sync it declares the archive unchanged and the run is thrown away.
    await expect(
      run('git', ['diff', '--quiet', '--', ...paths], { cwd: root }),
    ).resolves.toBeTruthy();
  });

  test('decides on changes with porcelain status, never with git diff', async () => {
    const { jobSteps } = await syncJob();
    const open = requiredString(namedStep(jobSteps, 'Open sync pull request').run, 'run');

    expect(open).toContain(`git status --porcelain -- ${ARTIFACT_PATHS}`);
    expect(open, 'git diff cannot see an untracked catalog').not.toContain('git diff --quiet');
  });

  test('authenticates the pull request with the job token only', async () => {
    const { jobSteps } = await syncJob();
    expect(namedStep(jobSteps, 'Open sync pull request').env).toEqual({
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });
});
