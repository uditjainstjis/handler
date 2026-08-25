/**
 * Starting, killing and reaping training runs.
 *
 * Runs are detached child processes so they outlive whichever HANDLER component
 * started them. That is the whole point: the watcher may restart, the harness
 * may restart, the run keeps going.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { type Run, exitCodePath, loadRun, metricsPath, logPath, runDir, saveRun } from './store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(HERE, '..', '..', 'scripts', 'run-with-exitcode.sh');

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

  // Hand the child a file descriptor, not a pipe. A pipe's read end lives in
  // THIS process: when HANDLER exits the pipe closes, and the run's next log
  // write gets EPIPE and kills it. A run that dies when its watcher restarts is
  // the opposite of what 'detached' is for.
  // A leftover exitcode file from a previous occupant of this directory would
  // make reconcile() classify this run before it has even finished.
  if (existsSync(exitCodePath(id))) await rm(exitCodePath(id), { force: true });

  const logFd = openSync(logPath(id), 'a');
  let child;
  try {
    // Wrapped so the exit code lands in a file. `run.command` stays the real
    // command, because that is what a human — and the agent — needs to see.
    child = spawn('/bin/sh', [WRAPPER, exitCodePath(id), ...options.command], {
      cwd: run.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, HANDLER_RUN_ID: id, HANDLER_METRICS_PATH: metricsPath(id) },
    });
  } finally {
    // The child holds its own duplicate; ours would otherwise leak per run.
    closeSync(logFd);
  }

  // spawn() reports a missing interpreter asynchronously. Without this the
  // 'error' event is unhandled and takes the whole process down — so a typo in
  // a command line kills the watcher rather than failing one run.
  child.on('error', async (error: Error) => {
    const current = await loadRun(id);
    if (!current) return;
    current.status = 'failed';
    current.endedAt = new Date().toISOString();
    current.config = { ...current.config, spawnError: error.message };
    await saveRun(current);
  });

  run.pid = child.pid;
  // Record the start time from the OS's point of view so a recycled pid cannot
  // later be mistaken for this run.
  run.config = { ...run.config, spawnedAt: Date.now() };
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

/**
 * Kill the run's whole process group, not just the pid we recorded.
 *
 * The recorded pid is the wrapper shell, and the trainer is its child. Signal
 * the shell alone and the trainer is orphaned — it keeps running, keeps
 * writing metrics, and keeps costing money, while the console cheerfully shows
 * the run as killed. Verified: after `kill -TERM <recorded pid>` the trainer
 * carried on stepping.
 *
 * `detached: true` makes the child a process-group leader, so its pgid equals
 * its pid and a negative pid signals the group.
 */
async function terminateGroup(pid: number): Promise<void> {
  const signal = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        // No group (or already reaped) — fall back to the single process.
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  if (!signal('SIGTERM')) return;

  // Give it a moment to shut down cleanly, then insist. A training process
  // ignoring SIGTERM is common — frameworks trap it to flush checkpoints.
  for (let waited = 0; waited < 5000; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!isAlive(pid)) return;
  }
  signal('SIGKILL');
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

  // Only signal a run we still believe is ours. A finished run's pid gets
  // recycled, and killing whatever inherited it would be the single worst
  // thing this tool could do. The exitcode file is proof the wrapper already
  // exited, so the pid is no longer ours to signal.
  const finished =
    Boolean(run.endedAt) || run.status !== 'running' || existsSync(exitCodePath(run.id));
  if (run.pid && !finished) {
    await terminateGroup(run.pid);
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

/**
 * Bring a run's recorded status back in line with reality.
 *
 * A detached run outlives the process that spawned it, so the 'exit' handler
 * above fires only when HANDLER happens to still be alive. The wrapper's
 * exitcode file is the durable record, and this is what reads it — which is
 * why a run that finished while the watcher was down still gets a status.
 */
export async function reconcile(run: Run): Promise<Run> {
  // Only a run we still think is running can be reconciled. A killed run has
  // an operator's decision recorded against it, and the wrapper's exit code
  // must not overwrite that with 'failed'.
  if (run.status !== 'running') return run;
  if (isAlive(run.pid) && !existsSync(exitCodePath(run.id))) return run;

  let code: number | undefined;
  if (existsSync(exitCodePath(run.id))) {
    const raw = (await readFile(exitCodePath(run.id), 'utf8')).trim();
    if (/^\d+$/.test(raw)) code = Number(raw);
  }
  // Still running and merely slow to flush — leave it alone.
  if (code === undefined && isAlive(run.pid)) return run;

  run.exitCode = code;
  run.endedAt = run.endedAt ?? new Date().toISOString();
  // No exit code and no process means it was killed or died without the
  // wrapper getting to write. Either way it is not succeeded.
  run.status = code === 0 ? 'succeeded' : 'failed';
  await saveRun(run);
  return run;
}
