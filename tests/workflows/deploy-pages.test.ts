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
  type WorkflowStep,
} from '../support/workflow';

const actionByStepName: ReadonlyMap<string, string> = new Map([
  ['Check out repository', pinnedAction('actions/checkout')],
  ['Set up Node', pinnedAction('actions/setup-node')],
  ['Restore archive baseline', pinnedAction('actions/cache/restore')],
  ['Upload curator report', pinnedAction('actions/upload-artifact')],
  ['Save archive baseline', pinnedAction('actions/cache/save')],
  ['Configure GitHub Pages', pinnedAction('actions/configure-pages')],
  ['Upload Pages artifact', pinnedAction('actions/upload-pages-artifact')],
  ['Deploy GitHub Pages', pinnedAction('actions/deploy-pages')],
]);

async function loadWorkflow(): Promise<{ source: string; workflow: UnknownRecord }> {
  return loadWorkflowAt('.github/workflows/deploy-pages.yml');
}

describe('GitHub Pages deployment workflow', () => {
  test('uses the exact daily, manual, and main-branch triggers with safe concurrency', async () => {
    const { workflow } = await loadWorkflow();
    const triggers = record(workflow.on, 'on');

    expect(new Set(Object.keys(triggers))).toEqual(
      new Set(['workflow_dispatch', 'schedule', 'push']),
    );
    expect(triggers.workflow_dispatch).toEqual({});
    expect(triggers.schedule).toEqual([{ cron: '17 3 * * *' }]);
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
      new Set(actionPins.keys()),
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

  test('orders sync, validation, report, baseline persistence, and Pages upload fail-safely', async () => {
    const { workflow } = await loadWorkflow();
    const build = record(record(workflow.jobs, 'jobs').build, 'jobs.build');
    const buildSteps = steps(build, 'jobs.build');

    expect(stepNames(buildSteps)).toEqual([
      'Check out repository',
      'Set up Node',
      'Install dependencies',
      'Install Chromium',
      'Restore archive baseline',
      'Sync Google Drive',
      'Run unit tests',
      'Build production site',
      'Run browser tests',
      'Upload curator report',
      'Save archive baseline',
      'Configure GitHub Pages',
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
    for (const stepName of [
      'Save archive baseline',
      'Configure GitHub Pages',
      'Upload Pages artifact',
    ]) {
      expect(namedStep(buildSteps, stepName).if, `${stepName} remains blocked after failures`).toBe(
        'success()',
      );
    }
    expect(namedStep(buildSteps, 'Upload Pages artifact').with).toEqual({ path: 'dist' });
  });

  test('restores only the versioned main baseline and saves a unique validated successor', async () => {
    const { workflow } = await loadWorkflow();
    const buildSteps = steps(
      record(record(workflow.jobs, 'jobs').build, 'jobs.build'),
      'jobs.build',
    );

    const restore = namedStep(buildSteps, 'Restore archive baseline');
    expect(restore.with).toEqual({
      path: '.astro/archive-baseline.json',
      key: 'archive-baseline-v1-main-${{ github.run_id }}-${{ github.run_attempt }}',
      'restore-keys': 'archive-baseline-v1-main-',
    });
    const save = namedStep(buildSteps, 'Save archive baseline');
    expect(save.with).toEqual({
      path: '.astro/archive-baseline.json',
      key: 'archive-baseline-v1-main-${{ github.run_id }}-${{ github.run_attempt }}',
    });
    expect(stepNames(buildSteps).indexOf('Restore archive baseline')).toBeLessThan(
      stepNames(buildSteps).indexOf('Sync Google Drive'),
    );
    expect(stepNames(buildSteps).indexOf('Run browser tests')).toBeLessThan(
      stepNames(buildSteps).indexOf('Save archive baseline'),
    );
  });

  test('scopes Drive secrets to the sync step and builds the project Pages base path', async () => {
    const { source, workflow } = await loadWorkflow();
    expect(workflow.env).toBeUndefined();
    const build = record(record(workflow.jobs, 'jobs').build, 'jobs.build');
    expect(build.env).toBeUndefined();
    const buildSteps = steps(build, 'jobs.build');

    const sync = namedStep(buildSteps, 'Sync Google Drive');
    expect(sync.run).toBe('npm run sync:drive');
    expect(sync.env).toEqual({
      GOOGLE_SERVICE_ACCOUNT_JSON: '${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}',
      GOOGLE_DRIVE_FOLDER_ID: '${{ secrets.GOOGLE_DRIVE_FOLDER_ID }}',
    });
    for (const step of buildSteps.filter(({ name }) => name !== 'Sync Google Drive')) {
      const environment = JSON.stringify(step.env ?? {});
      expect(environment, `${step.name} service-account secret-free`).not.toContain(
        'GOOGLE_SERVICE_ACCOUNT_JSON',
      );
      expect(environment, `${step.name} folder-ID secret-free`).not.toContain(
        'GOOGLE_DRIVE_FOLDER_ID',
      );
    }
    for (const command of buildSteps.flatMap(({ run }) => (run === undefined ? [] : [run]))) {
      expect(command).not.toMatch(/secrets\.|GOOGLE_(?:SERVICE_ACCOUNT_JSON|DRIVE_FOLDER_ID)/u);
    }
    expect(source.match(/\$\{\{\s*secrets\./gu)).toHaveLength(2);

    const buildSite = namedStep(buildSteps, 'Build production site');
    expect(buildSite.run).toBe('npm run build');
    expect(buildSite.env).toEqual({
      SITE_URL: 'https://${{ github.repository_owner }}.github.io',
      BASE_PATH: '/${{ github.event.repository.name }}',
    });
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
      SITE_URL: 'https://${{ github.repository_owner }}.github.io',
      BASE_PATH: '/${{ github.event.repository.name }}',
    });
  });
});
