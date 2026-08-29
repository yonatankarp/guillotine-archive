import { describe, expect, test } from 'vitest';
import {
  actionPins,
  loadWorkflow as loadWorkflowAt,
  namedStep,
  pinnedAction,
  record,
  requiredString,
  stepNames,
  steps,
  type UnknownRecord,
} from '../support/workflow';

const actionByStepName: ReadonlyMap<string, string> = new Map([
  ['Check out repository', pinnedAction('actions/checkout')],
  ['Set up Node', pinnedAction('actions/setup-node')],
  ['Upload curator report', pinnedAction('actions/upload-artifact')],
  ['Configure GitHub Pages', pinnedAction('actions/configure-pages')],
  ['Upload Pages artifact', pinnedAction('actions/upload-pages-artifact')],
  ['Deploy GitHub Pages', pinnedAction('actions/deploy-pages')],
]);

async function loadWorkflow(): Promise<{ source: string; workflow: UnknownRecord }> {
  return loadWorkflowAt('.github/workflows/deploy-pages.yml');
}

describe('GitHub Pages deployment workflow', () => {
  test('deploys on demand and on main, never on a schedule', async () => {
    const { workflow } = await loadWorkflow();
    const triggers = record(workflow.on, 'on');

    expect(new Set(Object.keys(triggers))).toEqual(new Set(['workflow_dispatch', 'push']));
    expect(triggers.workflow_dispatch).toEqual({});
    expect(triggers.push).toEqual({ branches: ['main'] });
    expect(workflow.concurrency).toEqual({ group: 'pages', 'cancel-in-progress': false });
  });

  test('pins only the approved actions to immutable SHAs with maintainable version comments', async () => {
    const { source, workflow } = await loadWorkflow();
    const jobs = record(workflow.jobs, 'jobs');
    const allSteps = Object.entries(jobs).flatMap(([name, job]) =>
      steps(record(job, `jobs.${name}`), `jobs.${name}`),
    );
    const usedActions = allSteps.filter((step) => step.uses !== undefined);

    expect(usedActions.length).toBeGreaterThan(0);
    for (const step of usedActions) {
      const use = requiredString(step.uses, `${step.name}.uses`);
      expect(use).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u);
      const separator = use.lastIndexOf('@');
      const action = use.slice(0, separator);
      const sha = use.slice(separator + 1);
      const approved = actionPins.get(action);
      expect(approved, `${action} is approved`).toBeDefined();
      if (approved === undefined) throw new Error(`unapproved action: ${action}`);
      expect(sha, `${action} SHA`).toBe(approved[0]);
      const escapedUse = use.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      expect(source).toMatch(new RegExp(`uses: ${escapedUse}\\s+# ${approved[1]}(?:\\s|$)`, 'u'));
    }

    expect(new Set(usedActions.map(({ uses }) => uses?.split('@')[0]))).toEqual(
      new Set([
        'actions/checkout',
        'actions/setup-node',
        'actions/upload-artifact',
        'actions/configure-pages',
        'actions/upload-pages-artifact',
        'actions/deploy-pages',
      ]),
    );
  });

  test('binds every named action step to its intended action and approved SHA', async () => {
    const { workflow } = await loadWorkflow();
    const jobs = record(workflow.jobs, 'jobs');
    const allSteps = Object.entries(jobs).flatMap(([name, job]) =>
      steps(record(job, `jobs.${name}`), `jobs.${name}`),
    );
    const actionSteps = allSteps.filter(({ uses }) => uses !== undefined);

    expect(actionSteps).toHaveLength(actionByStepName.size);
    expect(new Set(actionSteps.map(({ name }) => name))).toEqual(new Set(actionByStepName.keys()));
    for (const [stepName, expectedAction] of actionByStepName) {
      expect(namedStep(actionSteps, stepName).uses, stepName).toBe(expectedAction);
    }
  });

  test('uses two least-privilege jobs and cannot deploy before the complete build succeeds', async () => {
    const { workflow } = await loadWorkflow();
    expect(workflow.permissions).toEqual({});
    const jobs = record(workflow.jobs, 'jobs');
    expect(new Set(Object.keys(jobs))).toEqual(new Set(['build', 'deployment']));
    const build = record(jobs.build, 'jobs.build');
    const deployment = record(jobs.deployment, 'jobs.deployment');

    expect(build['runs-on']).toBe('ubuntu-latest');
    expect(build.permissions).toEqual({ contents: 'read', pages: 'read' });
    expect(build.if).toBe("github.ref == 'refs/heads/main'");
    expect(deployment.needs).toBe('build');
    expect(deployment['runs-on']).toBe('ubuntu-latest');
    expect(deployment.if).toBe("success() && github.ref == 'refs/heads/main'");
    expect(deployment.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
    expect(deployment.environment).toEqual({
      name: 'github-pages',
      url: '${{ steps.deployment.outputs.page_url }}',
    });
    expect(steps(deployment, 'jobs.deployment')).toEqual([
      expect.objectContaining({
        name: 'Deploy GitHub Pages',
        id: 'deployment',
        uses: `actions/deploy-pages@${actionPins.get('actions/deploy-pages')?.[0]}`,
      }),
    ]);
  });

  test('orders the archive guard, validation, report, and Pages upload fail-safely', async () => {
    const { workflow } = await loadWorkflow();
    const build = record(record(workflow.jobs, 'jobs').build, 'jobs.build');
    const buildSteps = steps(build, 'jobs.build');

    expect(stepNames(buildSteps)).toEqual([
      'Check out repository',
      'Set up Node',
      'Install dependencies',
      'Install Chromium',
      'Verify the committed archive is present',
      'Run unit tests',
      // Ahead of the build, which reads its `origin` and `base_path` outputs so the absolute
      // canonical and og:url tags name the URL Pages actually serves — this site answers on a
      // custom domain that the <owner>.github.io address only redirects to.
      'Configure GitHub Pages',
      'Build production site',
      'Run browser tests',
      'Upload curator report',
      'Upload Pages artifact',
    ]);

    expect(namedStep(buildSteps, 'Upload curator report')).toMatchObject({
      if: 'always()',
    });
    expect(namedStep(buildSteps, 'Upload curator report').with).toEqual({
      name: 'curator-report',
      path: 'reports/curator-report.json',
      'if-no-files-found': 'ignore',
      'retention-days': 7,
    });
    for (const stepName of ['Configure GitHub Pages', 'Upload Pages artifact']) {
      expect(namedStep(buildSteps, stepName).if, `${stepName} remains blocked after failures`).toBe(
        'success()',
      );
    }
    expect(namedStep(buildSteps, 'Upload Pages artifact').with).toEqual({ path: 'dist' });
  });

  test('refuses to build when the committed archive is missing, instead of syncing', async () => {
    const { workflow } = await loadWorkflow();
    const buildSteps = steps(
      record(record(workflow.jobs, 'jobs').build, 'jobs.build'),
      'jobs.build',
    );

    const guard = requiredString(
      namedStep(buildSteps, 'Verify the committed archive is present').run,
      'guard.run',
    );
    expect(guard).toContain('set -euo pipefail');
    expect(guard).toContain('src/generated/catalog.json');
    expect(guard).toContain('public/data/search-index.json');
    expect(guard).toContain('exit 1');
    expect(guard, 'names the workflow that fixes it').toContain('Sync archive from Drive');

    // The guard has to precede anything that reads the catalog.
    const names = stepNames(buildSteps);
    expect(names.indexOf('Verify the committed archive is present')).toBeLessThan(
      names.indexOf('Run unit tests'),
    );
  });

  test('holds no Drive credentials anywhere and builds the project Pages base path', async () => {
    const { source, workflow } = await loadWorkflow();
    expect(workflow.env).toBeUndefined();
    const build = record(record(workflow.jobs, 'jobs').build, 'jobs.build');
    expect(build.env).toBeUndefined();
    const buildSteps = steps(build, 'jobs.build');

    // Syncing moved to its own workflow, so a Drive secret appearing here is a
    // regression: this one only ever builds what is committed.
    expect(source).not.toContain('GOOGLE_SERVICE_ACCOUNT_JSON');
    expect(source).not.toContain('GOOGLE_DRIVE_FOLDER_ID');
    expect(source).not.toContain('sync:drive');
    expect(stepNames(buildSteps)).not.toContain('Sync Google Drive');

    for (const stepName of ['Build production site', 'Run browser tests']) {
      expect(namedStep(buildSteps, stepName).env).toMatchObject({
        SITE_URL: '${{ steps.pages.outputs.origin }}',
        BASE_PATH: '${{ steps.pages.outputs.base_path }}',
      });
    }
  });

  test('uses reproducible installs, every configured Playwright project, and no credential persistence', async () => {
    const { workflow } = await loadWorkflow();
    const buildSteps = steps(
      record(record(workflow.jobs, 'jobs').build, 'jobs.build'),
      'jobs.build',
    );

    expect(namedStep(buildSteps, 'Check out repository').with).toEqual({
      'persist-credentials': false,
    });
    expect(namedStep(buildSteps, 'Set up Node').with).toEqual({
      'node-version': '22',
      cache: 'npm',
    });
    expect(namedStep(buildSteps, 'Install dependencies').run).toBe('npm ci');
    expect(namedStep(buildSteps, 'Install Chromium').run).toBe(
      'npx playwright install --with-deps chromium',
    );
    expect(namedStep(buildSteps, 'Run unit tests').run).toBe('npm test');
    expect(namedStep(buildSteps, 'Run browser tests').run).toBe('npm run test:e2e');
    expect(namedStep(buildSteps, 'Run browser tests').env).toEqual({
      PLAYWRIGHT_USE_DIST: '1',
      SITE_URL: '${{ steps.pages.outputs.origin }}',
      BASE_PATH: '${{ steps.pages.outputs.base_path }}',
    });
  });
});
