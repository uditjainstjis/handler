/**
 * HANDLER Ops — the tools the agent reaches through MCP.
 *
 * The split that matters is the annotation, not the name. TrueForge derives its
 * approval tags straight from MCP annotations (`toolSelectors.ts`):
 *
 *   readOnlyHint === true                          -> @read-only
 *   readOnlyHint === false && !destructiveHint     -> @write
 *   destructiveHint === true                       -> @destructive
 *
 * So every tool below declares what it really is, and the agent spec asks the
 * harness to gate `@write` and `@destructive`. Nothing that touches a live run
 * or pages a human can execute without a person saying yes first.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  type Incident,
  latestIncident,
  listIncidents,
  listRuns,
  loadRun,
  readLog,
  readMetrics,
  runDir,
  saveIncident,
  saveRun,
} from '../runs/store.ts';
import { isAlive, killRun, relaunchRun } from '../runs/runner.ts';
import { listConfigs } from '../runs/config.ts';
import { openFixPullRequest } from './pullRequest.ts';

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Summary statistics the agent would otherwise burn a sandbox turn computing. */
function summarise(rows: Awaited<ReturnType<typeof readMetrics>>) {
  if (rows.length === 0) return { steps: 0 };
  const losses = rows.map(r => r.loss).filter((v): v is number => typeof v === 'number');
  const last = rows[rows.length - 1];
  return {
    steps: rows.length,
    lastStep: last.step,
    lastLoss: last.loss,
    lastValLoss: last.val_loss,
    minLoss: losses.length ? Math.min(...losses) : null,
    nanSteps: rows.filter(r => r.loss === null).length,
    peakGradNorm: Math.max(...rows.map(r => r.grad_norm ?? 0)),
    peakMemGb: Math.max(...rows.map(r => r.mem_gb ?? 0)),
    secondsSinceLastStep: Math.round(Date.now() / 1000 - last.ts),
  };
}

export function registerTools(server: McpServer): void {
  // ---------------------------------------------------------------- read-only

  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description:
        'Every training run HANDLER knows about, newest first, with status and liveness. Start here.',
      inputSchema: {},
      annotations: { title: 'List runs', ...READ_ONLY },
    },
    async () => {
      const runs = await listRuns();
      return text(
        runs.map(r => ({
          id: r.id,
          name: r.name,
          status: r.status,
          alive: isAlive(r.pid),
          startedAt: r.startedAt,
          exitCode: r.exitCode,
          sessionId: r.sessionId,
        })),
      );
    },
  );

  server.registerTool(
    'get_run',
    {
      title: 'Get run detail',
      description:
        'Full detail for one run: command line, hyperparameters, budget, status, and a statistical summary of its metrics.',
      inputSchema: { run_id: z.string().describe('Run id from list_runs') },
      annotations: { title: 'Get run detail', ...READ_ONLY },
    },
    async ({ run_id }) => {
      const run = await loadRun(run_id);
      if (!run) return text(`No run ${run_id}.`);
      const rows = await readMetrics(run_id);
      return text({ ...run, alive: isAlive(run.pid), metrics: summarise(rows) });
    },
  );

  server.registerTool(
    'tail_log',
    {
      title: 'Tail run log',
      description: 'Last N lines of a run\'s stdout/stderr, including any traceback.',
      inputSchema: {
        run_id: z.string(),
        lines: z.number().int().min(1).max(2000).default(80),
      },
      annotations: { title: 'Tail run log', ...READ_ONLY },
    },
    async ({ run_id, lines }) => text(await readLog(run_id, lines)),
  );

  server.registerTool(
    'search_log',
    {
      title: 'Search run log',
      description:
        'Grep a run log with a regular expression. Cheaper than tailing thousands of lines when you already know the signature you are looking for.',
      inputSchema: {
        run_id: z.string(),
        pattern: z.string().describe('JavaScript regular expression'),
        max_matches: z.number().int().min(1).max(200).default(25),
      },
      annotations: { title: 'Search run log', ...READ_ONLY },
    },
    async ({ run_id, pattern, max_matches }) => {
      const log = await readLog(run_id, 100000);
      let re: RegExp;
      try {
        re = new RegExp(pattern, 'i');
      } catch (error) {
        return text(`Invalid regular expression: ${(error as Error).message}`);
      }
      const hits = log
        .split('\n')
        .map((line, index) => ({ line: index + 1, textLine: line }))
        .filter(entry => re.test(entry.textLine))
        .slice(0, max_matches);
      return text(hits.length ? hits : `No line matched /${pattern}/.`);
    },
  );

  server.registerTool(
    'get_metrics',
    {
      title: 'Get run metrics',
      description:
        'Metrics as CSV, ready to write straight into a sandbox file and analyse. Use `stride` to downsample a long run instead of pulling every step.',
      inputSchema: {
        run_id: z.string(),
        stride: z.number().int().min(1).max(100).default(1).describe('Keep every Nth step'),
        last_n: z.number().int().min(1).max(5000).optional().describe('Only the final N steps'),
      },
      annotations: { title: 'Get run metrics', ...READ_ONLY },
    },
    async ({ run_id, stride, last_n }) => {
      const rows = await readMetrics(run_id, last_n);
      const kept = rows.filter((_, index) => index % stride === 0);
      const header = 'step,loss,val_loss,lr,grad_norm,mem_gb,batch_size,ts';
      const body = kept
        .map(r =>
          [r.step, r.loss ?? 'nan', r.val_loss ?? '', r.lr ?? '', r.grad_norm ?? '', r.mem_gb ?? '', r.batch_size ?? '', r.ts].join(','),
        )
        .join('\n');
      return text(`${header}\n${body}`);
    },
  );

  server.registerTool(
    'compare_runs',
    {
      title: 'Compare two runs',
      description:
        'Config diff and metric-summary diff between two runs. The fastest way to find what actually changed between a run that worked and one that did not.',
      inputSchema: { run_id_a: z.string(), run_id_b: z.string() },
      annotations: { title: 'Compare two runs', ...READ_ONLY },
    },
    async ({ run_id_a, run_id_b }) => {
      const [a, b] = await Promise.all([loadRun(run_id_a), loadRun(run_id_b)]);
      if (!a || !b) return text('One of those run ids does not exist.');
      const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)]);
      const configDiff: Record<string, { a: unknown; b: unknown }> = {};
      for (const key of keys) {
        if (JSON.stringify(a.config[key]) !== JSON.stringify(b.config[key])) {
          configDiff[key] = { a: a.config[key], b: b.config[key] };
        }
      }
      const [ra, rb] = await Promise.all([readMetrics(run_id_a), readMetrics(run_id_b)]);
      return text({
        commandA: a.command.join(' '),
        commandB: b.command.join(' '),
        configDiff,
        metricsA: summarise(ra),
        metricsB: summarise(rb),
      });
    },
  );

  server.registerTool(
    'list_run_files',
    {
      title: 'List run files',
      description: 'Files inside a run directory (checkpoints, configs, incident records).',
      inputSchema: { run_id: z.string() },
      annotations: { title: 'List run files', ...READ_ONLY },
    },
    async ({ run_id }) => {
      const dir = runDir(run_id);
      if (!existsSync(dir)) return text(`No run directory for ${run_id}.`);
      const entries = await readdir(dir, { withFileTypes: true });
      return text(entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)));
    },
  );

  server.registerTool(
    'read_run_file',
    {
      title: 'Read a run file',
      description: 'Read one file from a run directory. Paths are confined to that directory.',
      inputSchema: { run_id: z.string(), file: z.string(), max_bytes: z.number().int().default(20000) },
      annotations: { title: 'Read a run file', ...READ_ONLY },
    },
    async ({ run_id, file, max_bytes }) => {
      const dir = path.resolve(runDir(run_id));
      const target = path.resolve(dir, file);
      // A tool the model drives is exactly where a path-traversal bug would land.
      if (!target.startsWith(dir + path.sep)) return text('Refused: path escapes the run directory.');
      if (!existsSync(target)) return text(`No such file: ${file}`);
      const content = await readFile(target, 'utf8');
      return text(content.slice(0, max_bytes));
    },
  );

  server.registerTool(
    'list_incidents',
    {
      title: 'List incidents',
      description: 'Incidents opened against a run, including any root cause already recorded.',
      inputSchema: { run_id: z.string() },
      annotations: { title: 'List incidents', ...READ_ONLY },
    },
    async ({ run_id }) => text(await listIncidents(run_id)),
  );

  // -------------------------------------------------------------------- write

  server.registerTool(
    'record_finding',
    {
      title: 'Record a finding',
      description:
        'Write the diagnosis onto the incident: root cause, recommendation, confidence, and the evidence you actually used. Do this BEFORE proposing any irreversible action — the human approving the action reads this.',
      inputSchema: {
        run_id: z.string(),
        root_cause: z.string(),
        recommendation: z.string(),
        confidence: z.enum(['low', 'medium', 'high']),
        evidence: z.string().describe('Concrete numbers, log lines or sandbox output. Not prose.'),
      },
      annotations: { title: 'Record a finding', ...WRITES },
    },
    async ({ run_id, root_cause, recommendation, confidence, evidence }) => {
      const incident = (await latestIncident(run_id)) ?? {
        id: `inc_${randomUUID().slice(0, 8)}`,
        runId: run_id,
        detector: 'agent',
        summary: 'Opened by the agent',
        evidence: {},
        openedAt: new Date().toISOString(),
      };
      incident.rootCause = root_cause;
      incident.recommendation = recommendation;
      incident.evidence = { ...incident.evidence, agent: evidence, confidence };
      await saveIncident(incident satisfies Incident);
      return text(`Recorded on ${incident.id}.`);
    },
  );

  server.registerTool(
    'propose_patch',
    {
      title: 'Propose a patch',
      description:
        'Save a proposed fix as a file in the run directory so a human can read it before anything is applied. This does not change any running job.',
      inputSchema: {
        run_id: z.string(),
        filename: z.string().describe('e.g. fix-grad-clip.patch or config.fixed.json'),
        contents: z.string(),
      },
      annotations: { title: 'Propose a patch', ...WRITES },
    },
    async ({ run_id, filename, contents }) => {
      const dir = path.resolve(runDir(run_id), 'patches');
      const target = path.resolve(dir, filename);
      if (!target.startsWith(dir + path.sep)) return text('Refused: path escapes the patches directory.');
      await mkdir(dir, { recursive: true });
      await writeFile(target, contents);
      return text(`Wrote ${path.relative(runDir(run_id), target)} (${contents.length} bytes). Nothing has been applied.`);
    },
  );

  // --------------------------------------------------------------- destructive

  server.registerTool(
    'kill_run',
    {
      title: 'Kill a run',
      description:
        'Terminate a live training run. Irreversible: the GPU-hours already spent are gone and any un-checkpointed progress is lost. Say what evidence justifies it.',
      inputSchema: {
        run_id: z.string(),
        reason: z.string().describe('Shown to the human approving this. Cite the numbers.'),
      },
      annotations: { title: 'Kill a run', ...DESTRUCTIVE },
    },
    async ({ run_id, reason }) => {
      const run = await killRun(run_id, reason);
      return text({ killed: run.id, status: run.status, reason });
    },
  );

  server.registerTool(
    'relaunch_run',
    {
      title: 'Relaunch a run',
      description:
        'Start a new run from an existing one with hyperparameter overrides. Spends real GPU budget, so it is gated. Overrides map to command-line flags: {"grad_clip": 1.0} becomes --grad-clip 1.0.',
      inputSchema: {
        run_id: z.string(),
        overrides: z.record(z.string(), z.union([z.string(), z.number()])),
        rationale: z.string().describe('Why these values, tied to the evidence.'),
      },
      annotations: { title: 'Relaunch a run', ...DESTRUCTIVE },
    },
    async ({ run_id, overrides, rationale }) => {
      const child = await relaunchRun(run_id, overrides);
      const incident = await latestIncident(run_id);
      if (incident) {
        incident.evidence = { ...incident.evidence, relaunchedAs: child.id, rationale };
        await saveIncident(incident);
      }
      return text({ newRun: child.id, command: child.command.join(' '), rationale });
    },
  );

  server.registerTool(
    'notify_operator',
    {
      title: 'Notify the operator',
      description:
        'Send a message outward to a human channel. Gated because it leaves the machine and cannot be unsent.',
      inputSchema: {
        channel: z.enum(['console', 'file']),
        message: z.string(),
      },
      annotations: { title: 'Notify the operator', ...DESTRUCTIVE },
    },
    async ({ channel, message }) => {
      const line = `[${new Date().toISOString()}] ${message}`;
      if (channel === 'console') {
        process.stdout.write(`\nHANDLER NOTIFY: ${line}\n`);
      } else {
        const file = path.join(process.env.HANDLER_HOME ?? path.join(process.cwd(), '.handler'), 'notifications.log');
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${line}\n`, { flag: 'a' });
      }
      return text(`Sent on ${channel}.`);
    },
  );

  server.registerTool(
    'open_fix_pull_request',
    {
      title: 'Open a pull request with the fix',
      description:
        'Turn the diagnosis into a pull request against the training config that caused the failure, so a human and a code reviewer see the patch before it reaches anyone else. Only lr, warmup_steps, grad_clip, batch_size, weight_decay and steps can be changed. Prefer the smallest change that addresses the root cause — a PR that alters five knobs teaches nobody anything when the next run fails.',
      inputSchema: {
        run_id: z.string(),
        config_name: z.string().describe('Config the run was launched from, e.g. "baseline"'),
        changes: z.record(z.string(), z.number()),
        title: z.string().describe('PR title — one line, states the fix'),
        rationale: z.string().describe('The case for this change, citing the numbers you measured.'),
      },
      annotations: { title: 'Open a pull request with the fix', ...DESTRUCTIVE },
    },
    async ({ run_id, config_name, changes, title, rationale }) => {
      try {
        const result = await openFixPullRequest({ runId: run_id, configName: config_name, changes, title, rationale });
        const incident = await latestIncident(run_id);
        if (incident) {
          incident.evidence = { ...incident.evidence, pullRequest: result.url ?? result.note };
          await saveIncident(incident);
        }
        return text(result);
      } catch (error) {
        return text(`Could not open the pull request: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    'list_configs',
    {
      title: 'List training configs',
      description: 'The checked-in training configs runs are launched from.',
      inputSchema: {},
      annotations: { title: 'List training configs', ...READ_ONLY },
    },
    async () => text(await listConfigs()),
  );

  server.registerTool(
    'resolve_incident',
    {
      title: 'Resolve an incident',
      description: 'Close the incident once the run is healthy again or the human has the answer.',
      inputSchema: { run_id: z.string(), note: z.string() },
      annotations: { title: 'Resolve an incident', ...WRITES },
    },
    async ({ run_id, note }) => {
      const incident = await latestIncident(run_id);
      if (!incident) return text('No open incident.');
      incident.resolvedAt = new Date().toISOString();
      incident.evidence = { ...incident.evidence, resolution: note };
      await saveIncident(incident);
      const run = await loadRun(run_id);
      if (run) {
        run.incidentOpenedAt = undefined;
        await saveRun(run);
      }
      return text(`Resolved ${incident.id}.`);
    },
  );
}
