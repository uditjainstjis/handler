/**
 * `handler` — the operator-facing command line.
 *
 * Enough to start a run, see what HANDLER thinks about it, and answer the
 * approval prompts without opening a browser.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureRoot, latestIncident, listRuns, loadRun, readLog, readMetrics } from './runs/store.ts';
import { isAlive, reconcile, startRun } from './runs/runner.ts';
import { commandFor, listConfigs, loadConfig } from './runs/config.ts';
import { doctor } from './doctor.ts';
import { transcript } from './transcript.ts';
import { AGENT_NAME, provision } from './trueforge/agent.ts';
import {
  chatUrlFor,
  createSession,
  decideApproval,
  isUp,
  listModels,
  pendingApprovals,
  postTurn,
  sessionExists,
} from './trueforge/client.ts';
import { AGENT_NAME as HANDLER_AGENT } from './trueforge/agent.ts';
import { saveRun } from './runs/store.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRAINER = path.resolve(HERE, '..', 'fixtures', 'trainer.py');

const FAIL_MODES = ['healthy', 'nan-loss', 'oom', 'stall', 'silent-degrade'] as const;
type FailMode = (typeof FAIL_MODES)[number];

/** Hyperparameters chosen so each mode fails for a findable reason. */
const DEMO_PRESETS: Record<FailMode, { args: string[]; config: Record<string, unknown>; label: string }> = {
  healthy: {
    label: 'converges cleanly',
    args: ['--warmup-steps', '100', '--grad-clip', '1.0', '--steps', '400'],
    config: { lr: 3e-4, warmup_steps: 100, grad_clip: 1.0, batch_size: 32 },
  },
  'nan-loss': {
    label: 'gradient explosion — no warmup, no clipping',
    args: ['--warmup-steps', '1', '--grad-clip', '0', '--steps', '400'],
    config: { lr: 3e-4, warmup_steps: 1, grad_clip: 0, batch_size: 32 },
  },
  oom: {
    label: 'CUDA OOM as the batch ramps',
    args: ['--batch-size', '96', '--warmup-steps', '100', '--steps', '400'],
    config: { lr: 3e-4, warmup_steps: 100, grad_clip: 1.0, batch_size: 96 },
  },
  stall: {
    label: 'dataloader deadlock — alive, producing nothing',
    args: ['--warmup-steps', '100', '--grad-clip', '1.0', '--steps', '400'],
    config: { lr: 3e-4, warmup_steps: 100, grad_clip: 1.0, batch_size: 32 },
  },
  'silent-degrade': {
    label: 'overfitting — nothing crashes, validation quietly diverges',
    args: ['--warmup-steps', '100', '--grad-clip', '1.0', '--weight-decay', '0', '--steps', '400'],
    config: { lr: 3e-4, warmup_steps: 100, grad_clip: 1.0, weight_decay: 0, batch_size: 32 },
  },
};

function python(): string {
  return process.env.HANDLER_PYTHON ?? 'python3';
}

async function cmdDemo(mode: string, stepSeconds: string): Promise<void> {
  if (!FAIL_MODES.includes(mode as FailMode)) {
    console.error(`Unknown mode "${mode}". Pick one of: ${FAIL_MODES.join(', ')}`);
    process.exit(1);
  }
  const preset = DEMO_PRESETS[mode as FailMode];
  await ensureRoot();
  const run = await startRun({
    name: `demo:${mode}`,
    command: [
      python(),
      TRAINER,
      '--fail-mode',
      mode,
      '--step-seconds',
      stepSeconds,
      ...preset.args,
    ],
    config: { ...preset.config, failMode: mode },
    budgetUsd: 50,
  });
  console.log(`started ${run.id}  (${preset.label})`);
  console.log(`  ${run.command.join(' ')}`);
}

async function cmdRun(configName: string, stepSeconds: string): Promise<void> {
  if (!configName) {
    console.log(`configs: ${(await listConfigs()).join(', ') || '(none)'}`);
    return;
  }
  const config = await loadConfig(configName);
  await ensureRoot();
  const run = await startRun({
    name: config.name,
    command: commandFor(config, Number(stepSeconds || 0.25)),
    config: { ...config },
    budgetUsd: config.budget_usd,
    configName,
  });
  console.log(`started ${run.id}  from config "${configName}"`);
  if (config.description) console.log(`  ${config.description}`);
}

async function cmdList(): Promise<void> {
  const runs = await listRuns();
  if (runs.length === 0) {
    console.log('No runs yet. Try:  npm run handler -- demo nan-loss');
    return;
  }
  for (const raw of runs) {
    const run = await reconcile(raw);
    const metrics = await readMetrics(run.id);
    const last = metrics[metrics.length - 1];
    const incident = await latestIncident(run.id);
    const alive = isAlive(run.pid) ? 'alive' : 'dead ';
    console.log(
      `${run.id}  ${run.status.padEnd(9)} ${alive}  step ${String(last?.step ?? 0).padStart(4)}  ` +
        `${run.name}${incident && !incident.resolvedAt ? `  [${incident.detector}]` : ''}`,
    );
    if (incident?.rootCause) console.log(`    root cause: ${incident.rootCause}`);
    if (run.sessionId) console.log(`    session: ${chatUrlFor(run.sessionId)}`);
  }
}

async function cmdLogs(runId: string, lines: string): Promise<void> {
  console.log(await readLog(runId, Number(lines || 60)));
}

async function cmdApprovals(): Promise<void> {
  const runs = await listRuns();
  let found = 0;
  for (const run of runs) {
    if (!run.sessionId) continue;
    const pending = await pendingApprovals(run.sessionId);
    for (const item of pending) {
      found += 1;
      console.log(`\n${run.id}  ${item.name}`);
      console.log(`  ${JSON.stringify(item.arguments)}`);
      console.log(`  approve:  npm run handler -- approve ${run.id}`);
      console.log(`  reject :  npm run handler -- reject ${run.id} "not convinced"`);
    }
  }
  if (found === 0) console.log('Nothing is waiting for you.');
}

async function decide(runId: string, allow: boolean, reason: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run?.sessionId) {
    console.error(`Run ${runId} has no session.`);
    process.exit(1);
  }
  const pending = await pendingApprovals(run.sessionId);
  if (pending.length === 0) {
    console.log('Nothing pending on that run.');
    return;
  }
  for (const item of pending) {
    await decideApproval(
      run.sessionId,
      item.threadId,
      item.toolCallId,
      allow ? { status: 'allow' } : { status: 'deny', reason },
    );
    console.log(`${allow ? 'approved' : 'rejected'} ${item.name}`);
  }
}

/**
 * Ask HANDLER a follow-up about a run it is already watching.
 *
 * This is the operator's way back into an incident — "why that threshold?",
 * "what about the batch size?" — without opening the harness UI. It goes
 * through the same resume path the watcher uses, so it also demonstrates the
 * thing that is otherwise hard to see: the conversation survives everything
 * underneath it restarting.
 */
async function cmdPoke(runId: string, message: string[]): Promise<void> {
  const run = await loadRun(runId);
  if (!run) {
    console.error(`No run ${runId}.`);
    process.exit(1);
  }

  const resumed = Boolean(run.sessionId) && (await sessionExists(run.sessionId!));
  let sessionId = run.sessionId;
  if (!resumed) {
    sessionId = await createSession(HANDLER_AGENT);
    run.sessionId = sessionId;
    await saveRun(run);
  }

  console.log(
    resumed
      ? `resumed existing session ${sessionId} — everything it already worked out is still there`
      : `no session survived, started a new one: ${sessionId}`,
  );

  const text = message.join(' ') || 'Where had you got to on this run?';
  await postTurn(sessionId!, [{ type: 'user.message', content: text }]);
  console.log(`  ${chatUrlFor(sessionId!)}`);
}

async function cmdProvision(): Promise<void> {
  if (!(await isUp())) {
    console.error('TrueForge is not running. Start it with: npx @truefoundry/trueforge');
    process.exit(1);
  }
  const models = await listModels();
  if (models.length === 0) {
    console.error(
      'TrueForge has no model provider configured yet.\n' +
        'Open http://localhost:8790 -> Settings -> Models and add one, then run this again.',
    );
    process.exit(1);
  }
  const wanted = process.env.HANDLER_MODEL;
  const model = wanted ?? models[0].name;
  await provision(model, process.env.HANDLER_MCP_URL ?? 'http://localhost:8811/mcp');
  console.log(`agent "${AGENT_NAME}" provisioned on ${model}`);
  console.log(`available models: ${models.map(m => m.name).join(', ')}`);
}

function usage(): void {
  console.log(`handler — the agent that watches your training runs

  run <config> [step-seconds]  launch a run from a checked-in config
                               (no arg lists available configs)
  demo <mode> [step-seconds]   start a demo run
                               modes: ${FAIL_MODES.join(' | ')}
  ls                           list runs, incidents and root causes
  logs <run-id> [lines]        tail a run's output
  transcript <run-id> [file]   export what HANDLER did, as readable markdown
  poke <run-id> [message]      ask HANDLER a follow-up; resumes its session
  approvals                    show what HANDLER is waiting on you for
  approve <run-id>             allow the pending action
  reject <run-id> [reason]     deny it
  provision                    register the MCP server and agent with TrueForge
  doctor                       check every moving part and name what is missing
`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'run':
      return cmdRun(rest[0], rest[1]);
    case 'demo':
      return cmdDemo(rest[0] ?? 'nan-loss', rest[1] ?? '0.05');
    case 'ls':
      return cmdList();
    case 'logs':
      return cmdLogs(rest[0], rest[1]);
    case 'approvals':
      return cmdApprovals();
    case 'approve':
      return decide(rest[0], true, '');
    case 'reject':
      return decide(rest[0], false, rest.slice(1).join(' ') || 'rejected by operator');
    case 'transcript': {
      const { writeFile } = await import('node:fs/promises');
      const markdown = await transcript(rest[0]);
      if (rest[1]) {
        await writeFile(rest[1], markdown);
        console.log(`wrote ${rest[1]} (${markdown.length} bytes)`);
      } else {
        console.log(markdown);
      }
      return;
    }
    case 'poke':
      return cmdPoke(rest[0], rest.slice(1));
    case 'provision':
      return cmdProvision();
    case 'doctor':
      process.exitCode = await doctor();
      return;
    default:
      usage();
  }
}

// Only run when executed directly. Importing this module — a test, a tool,
// another entry point — must not start a server or a trading loop.
// pathToFileURL, not string concatenation: argv[1] containing a space, a
// symlink, or a Windows drive letter never equals `file://` + the raw path,
// and the entry point would silently refuse to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
