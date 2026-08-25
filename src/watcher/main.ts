/**
 * The watcher: the thing that is awake when you are not.
 *
 * It polls the runs, and when a detector trips it hands the incident to the
 * agent running on TrueForge. The part that matters for a watch that lasts
 * hours is what happens on restart: the session id lives on the run record, so
 * a watcher that dies and comes back rejoins the *same* conversation rather
 * than starting a new one and losing everything the agent had worked out.
 */
import { randomUUID } from 'node:crypto';

import {
  type Run,
  ensureRoot,
  listRuns,
  loadRun,
  readLog,
  readMetrics,
  saveIncident,
  saveRun,
} from '../runs/store.ts';
import { isAlive } from '../runs/runner.ts';
import { detect } from './detectors.ts';
import { retryIfRateLimited } from './retry.ts';
import { AGENT_NAME, MCP_SERVER_NAME, provision } from '../trueforge/agent.ts';
import { chatUrlFor, createSession, isUp, postTurn, sessionExists } from '../trueforge/client.ts';

const POLL_MS = Number(process.env.HANDLER_POLL_MS ?? 3000);
const STALL_SECONDS = Number(process.env.HANDLER_STALL_SECONDS ?? 25);
const MODEL = process.env.HANDLER_MODEL ?? 'anthropic/claude-sonnet-4-6';
const MCP_URL = process.env.HANDLER_MCP_URL ?? 'http://localhost:8811/mcp';
const MAX_RATE_LIMIT_RETRIES = Number(process.env.HANDLER_RATE_LIMIT_RETRIES ?? 8);

/** Retry counters per session, so a permanently throttled key cannot loop forever. */
const retryAttempts = new Map<string, number>();

function log(message: string): void {
  process.stdout.write(`[watcher ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

/**
 * Returns a session for this run, resuming the existing one when it is still
 * there. This is the whole reconnect story in one function.
 */
async function sessionFor(run: Run): Promise<{ id: string; resumed: boolean }> {
  if (run.sessionId && (await sessionExists(run.sessionId))) {
    return { id: run.sessionId, resumed: true };
  }
  const id = await createSession(AGENT_NAME);
  run.sessionId = id;
  await saveRun(run);
  return { id, resumed: false };
}

async function escalate(run: Run, detection: ReturnType<typeof detect>): Promise<void> {
  if (!detection) return;

  const incidentId = `inc_${randomUUID().slice(0, 8)}`;
  await saveIncident({
    id: incidentId,
    runId: run.id,
    detector: detection.detector,
    summary: detection.summary,
    evidence: detection.evidence,
    openedAt: new Date().toISOString(),
  });

  run.incidentOpenedAt = new Date().toISOString();
  await saveRun(run);

  const { id: sessionId, resumed } = await sessionFor(run);

  const brief = [
    `INCIDENT ${incidentId} on run \`${run.id}\` (${run.name}).`,
    ``,
    `Detector: ${detection.detector} (${detection.severity})`,
    `Summary: ${detection.summary}`,
    ``,
    `Evidence the detector captured:`,
    '```json',
    JSON.stringify(detection.evidence, null, 2),
    '```',
    ``,
    `Command: \`${run.command.join(' ')}\``,
    run.budgetUsd ? `Remaining budget: $${run.budgetUsd}.` : `No budget recorded for this run.`,
    ``,
    `Diagnose it. Use the sandbox for the arithmetic, delegate parallel subagents`,
    `if more than one cause is plausible, record your finding, then propose the`,
    `action. I will approve or reject anything irreversible.`,
  ].join('\n');

  await postTurn(sessionId, [{ type: 'user.message', content: brief }]);
  log(
    `escalated ${run.id} (${detection.detector}) -> session ${sessionId}` +
      `${resumed ? ' [resumed existing session]' : ' [new session]'}`,
  );
  log(`   ${chatUrlFor(sessionId)}`);
}

async function tick(): Promise<void> {
  const runs = await listRuns();
  const now = Date.now();

  for (const summary of runs) {
    const run = await loadRun(summary.id);
    if (!run) continue;

    // One open incident per run. A flapping run must not spawn a session per poll.
    if (run.incidentOpenedAt) continue;
    if (run.status === 'succeeded' || run.status === 'killed') continue;

    const [metrics, logText] = await Promise.all([readMetrics(run.id), readLog(run.id, 400)]);
    const detection = detect({
      run,
      alive: isAlive(run.pid),
      metrics,
      log: logText,
      stallSeconds: STALL_SECONDS,
      now,
    });
    if (detection) {
      await escalate(run, detection);
      // One escalation per tick. Two incidents opening at once doubles the
      // request rate at the model provider, and the second one is what gets
      // throttled — so it would arrive looking like a failed diagnosis.
      return;
    }
  }

  await resumeRateLimited();
}

/**
 * Incidents whose turn died on a provider rate limit are unfinished, not
 * failed. Pick them back up rather than leaving a half-written diagnosis.
 */
async function resumeRateLimited(): Promise<void> {
  for (const summary of await listRuns()) {
    const run = await loadRun(summary.id);
    if (!run?.sessionId || !run.incidentOpenedAt) continue;

    const attempt = retryAttempts.get(run.sessionId) ?? 0;
    const result = await retryIfRateLimited(run.sessionId, attempt, MAX_RATE_LIMIT_RETRIES);
    if (result.retried) {
      retryAttempts.set(run.sessionId, attempt + 1);
      log(
        `resumed ${run.id} after a provider rate limit ` +
          `(waited ${Math.round((result.waitedMs ?? 0) / 1000)}s, attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
      );
      return;
    }
  }
}

async function main(): Promise<void> {
  await ensureRoot();

  if (!(await isUp())) {
    log(`TrueForge is not reachable at ${process.env.TRUEFORGE_URL ?? 'http://localhost:8790'}.`);
    log(`Start it with: npx @truefoundry/trueforge`);
    process.exit(1);
  }

  await provision(MODEL, MCP_URL);
  log(`agent "${AGENT_NAME}" provisioned on ${MODEL}, MCP server "${MCP_SERVER_NAME}" -> ${MCP_URL}`);
  log(`watching every ${POLL_MS}ms · stall threshold ${STALL_SECONDS}s`);

  // A failing tick must never take the watcher down — it is the component whose
  // entire value proposition is that it is still running at 3am.
  for (;;) {
    try {
      await tick();
    } catch (error) {
      log(`tick failed (continuing): ${(error as Error).message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

void main();
