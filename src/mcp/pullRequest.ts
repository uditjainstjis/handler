/**
 * The step that closes the loop: HANDLER turns its diagnosis into a pull
 * request against the config that caused the failure, and a code reviewer looks
 * at the agent's patch the same way it would look at a human's.
 *
 * Deliberately shells out to `gh` rather than holding a token. HANDLER never
 * sees a credential, and the PR is attributable to whoever's machine it ran on
 * — which is the honest thing for an agent opening a PR.
 *
 * Off unless HANDLER_ALLOW_PR=1. Cloning a repo and having an agent quietly
 * gain push rights is not a default anyone should get by accident.
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { REPO_ROOT, configPath, loadConfig, applyConfigChanges } from '../runs/config.ts';

const run = promisify(execFile);

async function git(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: REPO_ROOT });
  return stdout.trim();
}

export type PullRequestResult = {
  url?: string;
  branch: string;
  diff: string;
  rejectedKeys: string[];
  note?: string;
};

export function pullRequestsEnabled(): boolean {
  return process.env.HANDLER_ALLOW_PR === '1';
}

export async function openFixPullRequest(input: {
  runId: string;
  configName: string;
  changes: Record<string, number>;
  title: string;
  rationale: string;
}): Promise<PullRequestResult> {
  const { runId, configName, changes, title, rationale } = input;

  const current = await loadConfig(configName);
  const { next, rejected } = applyConfigChanges(current, changes);
  if (Object.keys(changes).length === rejected.length) {
    throw new Error(
      `None of those keys are patchable. Allowed: lr, warmup_steps, grad_clip, batch_size, weight_decay, steps.`,
    );
  }

  const file = configPath(configName);
  const branch = `handler/fix-${runId}`;
  const body = [
    `Opened by HANDLER after diagnosing \`${runId}\`.`,
    ``,
    `## Why`,
    ``,
    rationale,
    ``,
    `## Change`,
    ``,
    '```diff',
    ...Object.entries(changes)
      .filter(([key]) => !rejected.includes(key))
      .flatMap(([key, value]) => [
        `- "${key}": ${JSON.stringify((current as Record<string, unknown>)[key])}`,
        `+ "${key}": ${JSON.stringify(value)}`,
      ]),
    '```',
    ``,
    rejected.length ? `Ignored non-patchable keys: ${rejected.join(', ')}.` : '',
    ``,
    `---`,
    `A human approved the action that produced this PR. Review the reasoning, not just the diff.`,
  ]
    .filter(line => line !== undefined)
    .join('\n');

  const previousBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);

  if (!pullRequestsEnabled()) {
    // Still produce the exact diff, so the capability is inspectable without
    // handing an agent push rights to see what it would have done.
    return {
      branch,
      diff: JSON.stringify(next, null, 2),
      rejectedKeys: rejected,
      note: 'HANDLER_ALLOW_PR is not set, so nothing was pushed. This is the patch it would have opened.',
    };
  }

  try {
    await git(['checkout', '-B', branch]);
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
    await git(['add', file]);
    await git(['commit', '-m', `${title}\n\n${rationale}\n\nDiagnosed and proposed by HANDLER for run ${runId}.`]);
    await git(['push', '-u', 'origin', branch, '--force-with-lease']);

    const { stdout } = await run('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branch], {
      cwd: REPO_ROOT,
    });
    const url = stdout.trim().split('\n').filter(Boolean).pop();
    return { url, branch, diff: JSON.stringify(next, null, 2), rejectedKeys: rejected };
  } finally {
    // Never strand the working tree on the agent's branch.
    await git(['checkout', previousBranch]).catch(() => undefined);
  }
}
