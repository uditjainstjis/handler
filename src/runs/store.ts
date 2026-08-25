/**
 * The run registry.
 *
 * One JSON file per run under `.handler/runs/<id>/`, plus the logs and metrics
 * the run itself writes. Deliberately boring: a judge should be able to `cat`
 * any of it, and HANDLER should survive its own restart without a database.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'killed' | 'stalled';

export type Run = {
  id: string;
  name: string;
  command: string[];
  cwd: string;
  status: RunStatus;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  /** Hyperparameters, so the agent can diff a failed run against a healthy one. */
  config: Record<string, unknown>;
  /** Cost guardrail the agent must respect when proposing a relaunch. */
  budgetUsd?: number;
  /** Checked-in config this run was launched from, so a fix can patch it. */
  configName?: string;
  /** TrueForge session watching this run. Survives a harness restart. */
  sessionId?: string;
  /** Set once a watcher has escalated, so a flapping run cannot spam sessions. */
  incidentOpenedAt?: string;
};

export type Incident = {
  id: string;
  runId: string;
  detector: string;
  summary: string;
  evidence: Record<string, unknown>;
  openedAt: string;
  /** Written by the agent through `record_finding`. */
  rootCause?: string;
  recommendation?: string;
  resolvedAt?: string;
};

const ROOT = process.env.HANDLER_HOME ?? path.join(process.cwd(), '.handler');

export function runsRoot(): string {
  return path.join(ROOT, 'runs');
}

export function runDir(runId: string): string {
  return path.join(runsRoot(), runId);
}

export function metricsPath(runId: string): string {
  return path.join(runDir(runId), 'metrics.jsonl');
}

export function logPath(runId: string): string {
  return path.join(runDir(runId), 'stdout.log');
}

export async function ensureRoot(): Promise<void> {
  await mkdir(runsRoot(), { recursive: true });
}

export async function saveRun(run: Run): Promise<void> {
  await mkdir(runDir(run.id), { recursive: true });
  await writeFile(path.join(runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
}

export async function loadRun(runId: string): Promise<Run | undefined> {
  const file = path.join(runDir(runId), 'run.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, 'utf8')) as Run;
}

export async function listRuns(): Promise<Run[]> {
  await ensureRoot();
  const ids = await readdir(runsRoot(), { withFileTypes: true });
  const runs: Run[] = [];
  for (const entry of ids) {
    if (!entry.isDirectory()) continue;
    const run = await loadRun(entry.name);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export type MetricRow = {
  step: number;
  loss: number | null;
  val_loss?: number;
  lr?: number;
  grad_norm?: number;
  mem_gb?: number;
  batch_size?: number;
  ts: number;
};

/** Reads metrics.jsonl, skipping partially-written trailing lines. */
export async function readMetrics(runId: string, limit?: number): Promise<MetricRow[]> {
  const file = metricsPath(runId);
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  const rows: MetricRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as MetricRow);
    } catch {
      // A run writing its current step while we read is normal, not an error.
    }
  }
  return limit ? rows.slice(-limit) : rows;
}

export async function readLog(runId: string, lastLines = 100): Promise<string> {
  const file = logPath(runId);
  if (!existsSync(file)) return '';
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  return lines.slice(-lastLines).join('\n');
}

export async function saveIncident(incident: Incident): Promise<void> {
  const dir = path.join(runDir(incident.runId), 'incidents');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${incident.id}.json`), JSON.stringify(incident, null, 2));
}

export async function listIncidents(runId: string): Promise<Incident[]> {
  const dir = path.join(runDir(runId), 'incidents');
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const out: Incident[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    out.push(JSON.parse(await readFile(path.join(dir, f), 'utf8')) as Incident);
  }
  return out.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export async function latestIncident(runId: string): Promise<Incident | undefined> {
  const all = await listIncidents(runId);
  return all[all.length - 1];
}
