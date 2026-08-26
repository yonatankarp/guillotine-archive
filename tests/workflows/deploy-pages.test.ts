import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

type UnknownRecord = Record<string, unknown>;

interface WorkflowStep extends UnknownRecord {
  name?: string;
  uses?: string;
  run?: string;
}

const actionPins: ReadonlyMap<string, readonly [sha: string, version: string]> = new Map([
  ['actions/checkout', ['de0fac2e4500dabe0009e67214ff5f5447ce83dd', 'v6.0.2']],
  ['actions/setup-node', ['820762786026740c76f36085b0efc47a31fe5020', 'v7.0.0']],
  ['actions/cache/restore', ['cdf6c1fa76f9f475f3d7449005a359c84ca0f306', 'v5.0.3']],
  ['actions/cache/save', ['cdf6c1fa76f9f475f3d7449005a359c84ca0f306', 'v5.0.3']],
  ['actions/upload-artifact', ['043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'v7.0.1']],
  ['actions/configure-pages', ['45bfe0192ca1faeb007ade9deae92b16b8254a0d', 'v6.0.0']],
  ['actions/upload-pages-artifact', ['fc324d3547104276b827a68afc52ff2a11cc49c9', 'v5.0.0']],
  ['actions/deploy-pages', ['cd2ce8fcbc39b97be8ca5fce6e763baed58fa128', 'v5.0.0']],
]);

function pinnedAction(action: string): string {
  const pin = actionPins.get(action);
  if (pin === undefined) throw new Error(`missing approved pin for ${action}`);
  return `${action}@${pin[0]}`;
}

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

function record(value: unknown, label: string): UnknownRecord {
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  expect(typeof value, label).toBe('object');
  return value as UnknownRecord;
}

function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe('string');
  return value as string;
}

function steps(job: UnknownRecord, label: string): WorkflowStep[] {
  expect(Array.isArray(job.steps), `${label}.steps`).toBe(true);
  return (job.steps as unknown[]).map((step, index) =>
    record(step, `${label}.steps[${index}]`) as WorkflowStep,
  );
}

function namedStep(jobSteps: WorkflowStep[], name: string): WorkflowStep {
  const matches = jobSteps.filter((step) => step.name === name);
  expect(matches, `step named ${name}`).toHaveLength(1);
  return matches[0]!;
}

function stepNames(jobSteps: WorkflowStep[]): string[] {
  return jobSteps.map((step) => requiredString(step.name, 'every build step has a name'));
}

async function loadWorkflow(): Promise<{ source: string; workflow: UnknownRecord }> {
  const source = await readFile('.github/workflows/deploy-pages.yml', 'utf8');
  const parsed: unknown = parse(source, { version: '1.2' });
  return { source, workflow: record(parsed, 'workflow') };
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
