import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import { parse } from 'yaml';

export type UnknownRecord = Record<string, unknown>;

export interface WorkflowStep extends UnknownRecord {
  name?: string;
  uses?: string;
  run?: string;
}

/**
 * Third-party Actions are pinned to immutable commit SHAs. Both workflows read
 * this map so a pin can never drift between them, and adding an action here is
 * the deliberate step that admits it to the repository.
 */
export const actionPins: ReadonlyMap<string, readonly [sha: string, version: string]> = new Map([
  ['actions/checkout', ['de0fac2e4500dabe0009e67214ff5f5447ce83dd', 'v6.0.2']],
  ['actions/setup-node', ['820762786026740c76f36085b0efc47a31fe5020', 'v7.0.0']],
  ['actions/cache/restore', ['cdf6c1fa76f9f475f3d7449005a359c84ca0f306', 'v5.0.3']],
  ['actions/cache/save', ['cdf6c1fa76f9f475f3d7449005a359c84ca0f306', 'v5.0.3']],
  ['actions/upload-artifact', ['043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'v7.0.1']],
  ['actions/configure-pages', ['45bfe0192ca1faeb007ade9deae92b16b8254a0d', 'v6.0.0']],
  ['actions/upload-pages-artifact', ['fc324d3547104276b827a68afc52ff2a11cc49c9', 'v5.0.0']],
  ['actions/deploy-pages', ['cd2ce8fcbc39b97be8ca5fce6e763baed58fa128', 'v5.0.0']],
]);

export function pinnedAction(action: string): string {
  const pin = actionPins.get(action);
  if (pin === undefined) throw new Error(`missing approved pin for ${action}`);
  return `${action}@${pin[0]}`;
}

export function record(value: unknown, label: string): UnknownRecord {
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  expect(typeof value, label).toBe('object');
  return value as UnknownRecord;
}

export function requiredString(value: unknown, label: string): string {
  expect(typeof value, label).toBe('string');
  return value as string;
}

export function steps(job: UnknownRecord, label: string): WorkflowStep[] {
  expect(Array.isArray(job.steps), `${label}.steps`).toBe(true);
  return (job.steps as unknown[]).map((step, index) =>
    record(step, `${label}.steps[${index}]`) as WorkflowStep,
  );
}

export function namedStep(jobSteps: WorkflowStep[], name: string): WorkflowStep {
  const matches = jobSteps.filter((step) => step.name === name);
  expect(matches, `step named ${name}`).toHaveLength(1);
  return matches[0]!;
}

export function stepNames(jobSteps: WorkflowStep[]): string[] {
  return jobSteps.map((step) => requiredString(step.name, 'every step has a name'));
}

export function allSteps(workflow: UnknownRecord): WorkflowStep[] {
  const jobs = record(workflow.jobs, 'jobs');
  return Object.entries(jobs).flatMap(([name, job]) =>
    steps(record(job, `jobs.${name}`), `jobs.${name}`),
  );
}

export async function loadWorkflow(
  path: string,
): Promise<{ source: string; workflow: UnknownRecord }> {
  const source = await readFile(path, 'utf8');
  const parsed: unknown = parse(source, { version: '1.2' });
  return { source, workflow: record(parsed, 'workflow') };
}

/**
 * Every `uses:` in the workflow resolves to an approved action at its approved
 * SHA, and carries the adjacent version comment that makes the pin updatable.
 */
export function expectApprovedPins(source: string, workflow: UnknownRecord): WorkflowStep[] {
  const usedActions = allSteps(workflow).filter((step) => step.uses !== undefined);
  expect(usedActions.length).toBeGreaterThan(0);

  for (const step of usedActions) {
    const use = requiredString(step.uses, `${step.name ?? 'step'}.uses`);
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

  return usedActions;
}
