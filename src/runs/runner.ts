/**
 * Starting, killing and reaping training runs.
 *
 * Runs are detached child processes so they outlive whichever HANDLER component
 * started them. That is the whole point: the watcher may restart, the harness
 * may restart, the run keeps going.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { type Run, loadRun, metricsPath, logPath, runDir, saveRun } from './store.ts';

export type StartRunOptions = {
  name: string;
  command: string[];
  cwd?: string;
  config?: Record<string, unknown>;
  budgetUsd?: number;
  configName?: string;
};

export async function startRun(options: StartRunOptions): Promise<Run> {
  const id = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const dir = runDir(id);
  await mkdir(dir, { recursive: true });

  const run: Run = {
    id,
    name: options.name,
    command: options.command,
    cwd: options.cwd ?? process.cwd(),
    status: 'running',
    startedAt: new Date().toISOString(),
    config: options.config ?? {},
    budgetUsd: options.budgetUsd,
    configName: options.configName,
  };

  const out = createWriteStream(logPath(id), { flags: 'a' });
  const [bin, ...args] = options.command;
  const child = spawn(bin, args, {
    cwd: run.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HANDLER_RUN_ID: id, HANDLER_METRICS_PATH: metricsPath(id) },
  });

  child.stdout.pipe(out);
  child.stderr.pipe(out);
  run.pid = child.pid;
  await saveRun(run);

  child.on('exit', async (code, signal) => {
    const current = await loadRun(id);
    if (!current) return;
    // A kill we asked for is already recorded; do not overwrite it with 'failed'.
    if (current.status === 'killed') return;
    current.exitCode = code ?? undefined;
    current.endedAt = new Date().toISOString();
    current.status = code === 0 ? 'succeeded' : 'failed';
    if (signal) current.status = 'killed';
    await saveRun(current);
  });

  child.unref();
  return run;
}

/** True when the OS still has this pid. Used to tell a stall from a crash. */
export function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killRun(runId: string, reason: string): Promise<Run> {
  const run = await loadRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  if (run.pid && isAlive(run.pid)) {
    try {
      process.kill(run.pid, 'SIGTERM');
    } catch {
      // Already gone between the liveness check and the signal. Fine.
    }
  }
  run.status = 'killed';
  run.endedAt = new Date().toISOString();
  run.config = { ...run.config, killReason: reason };
  await saveRun(run);
  return run;
}

/**
 * Relaunches a run with hyperparameter overrides, recording which run it came
 * from so the lineage is inspectable afterwards.
 */
export async function relaunchRun(
  runId: string,
  overrides: Record<string, string | number>,
): Promise<Run> {
  const parent = await loadRun(runId);
  if (!parent) throw new Error(`unknown run ${runId}`);

  const command = applyOverrides(parent.command, overrides);
  const child = await startRun({
    name: `${parent.name} (retry)`,
    command,
    cwd: parent.cwd,
    config: { ...parent.config, ...overrides, relaunchedFrom: parent.id },
    budgetUsd: parent.budgetUsd,
    configName: parent.configName,
  });
  return child;
}

/**
 * Rewrites `--flag value` pairs in an argv array. Flags not already present are
 * appended, so the agent can add `--grad-clip` to a command that never had one.
 */
export function applyOverrides(
  command: string[],
  overrides: Record<string, string | number>,
): string[] {
  const out = [...command];
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'relaunchedFrom') continue;
    const flag = `--${key.replace(/_/g, '-')}`;
    const at = out.indexOf(flag);
    if (at >= 0 && at + 1 < out.length) {
      out[at + 1] = String(value);
    } else {
      out.push(flag, String(value));
    }
  }
  return out;
}

export function metricsFileFor(runId: string): string {
  return path.resolve(metricsPath(runId));
}
