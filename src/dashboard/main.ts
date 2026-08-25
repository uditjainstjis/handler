/**
 * The operator console.
 *
 * Two things a terminal cannot show well: the shape of a loss curve, and an
 * approval prompt you need to answer in five seconds with the evidence in front
 * of you. That is all this is for.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { latestIncident, listRuns, loadRun, readLog, readMetrics } from '../runs/store.ts';
import { isAlive } from '../runs/runner.ts';
<<<<<<< HEAD
import { chatUrlFor, decideApproval, isUp, pendingApprovals, sessionSnapshot } from '../trueforge/client.ts';
=======
import { chatUrlFor, decideApproval, isUp, pendingApprovals } from '../trueforge/client.ts';
import { lastTurnOutcome } from '../watcher/retry.ts';
>>>>>>> origin/main

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HANDLER_DASHBOARD_PORT ?? 8812);

const app = express();
app.use(express.json());
app.use(express.static(path.join(HERE, 'public')));

app.get('/api/state', async (_req, res) => {
  const runs = await listRuns();
  const trueforgeUp = await isUp();

  const detailed = await Promise.all(
    runs.map(async run => {
      const [metrics, incident] = await Promise.all([readMetrics(run.id), latestIncident(run.id)]);
      // Downsample for the sparkline; 400 points in a 200px box is wasted bytes.
      const stride = Math.max(1, Math.ceil(metrics.length / 120));
      const curve = metrics
        .filter((_, index) => index % stride === 0)
        .map(row => ({ step: row.step, loss: row.loss, val: row.val_loss ?? null }));
      const last = metrics[metrics.length - 1];

      let approvals: Awaited<ReturnType<typeof pendingApprovals>> = [];
      // "The agent is thinking" and "the agent is wedged on a spent quota" look
      // identical on a dashboard that only renders approvals. Say which.
      let stalled: string | null = null;
      if (trueforgeUp && run.sessionId) {
        try {
          approvals = await pendingApprovals(run.sessionId);
          if (approvals.length === 0) {
            const outcome = await lastTurnOutcome(run.sessionId);
            if (outcome.state === 'rate-limited') stalled = 'waiting on the model provider (rate limited)';
            else if (outcome.state === 'error') stalled = `turn failed: ${outcome.message.slice(0, 140)}`;
          }
        } catch {
          // A session the harness has since forgotten is not an error here.
        }
      }

      return {
        id: run.id,
        name: run.name,
        status: run.status,
        alive: isAlive(run.pid),
        startedAt: run.startedAt,
        exitCode: run.exitCode,
        command: run.command.join(' '),
        config: run.config,
        budgetUsd: run.budgetUsd,
        sessionId: run.sessionId,
        sessionUrl: run.sessionId ? chatUrlFor(run.sessionId) : null,
        lastStep: last?.step ?? 0,
        lastLoss: last?.loss ?? null,
        lastVal: last?.val_loss ?? null,
        curve,
        stalled,
        incident: incident
          ? {
              id: incident.id,
              detector: incident.detector,
              summary: incident.summary,
              rootCause: incident.rootCause ?? null,
              recommendation: incident.recommendation ?? null,
              confidence: (incident.evidence as { confidence?: string })?.confidence ?? null,
              agentEvidence: (incident.evidence as { agent?: string })?.agent ?? null,
              resolvedAt: incident.resolvedAt ?? null,
            }
          : null,
        approvals,
      };
    }),
  );

  res.json({ trueforgeUp, runs: detailed });
});

app.get('/api/logs/:runId', async (req, res) => {
  res.type('text/plain').send(await readLog(req.params.runId, 200));
});

app.post('/api/decide', async (req, res) => {
  const { runId, threadId, toolCallId, allow, reason } = req.body as {
    runId: string;
    threadId: string;
    toolCallId: string;
    allow: boolean;
    reason?: string;
  };
  const run = await loadRun(runId);
  if (!run?.sessionId) {
    res.status(404).json({ error: 'no session for that run' });
    return;
  }
  try {
    await decideApproval(
      run.sessionId,
      threadId,
      toolCallId,
      allow ? { status: 'allow' } : { status: 'deny', reason: reason || 'rejected by operator' },
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.listen(PORT, () => {
  process.stdout.write(`HANDLER console on http://localhost:${PORT}\n`);
});
