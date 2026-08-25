/**
 * The HANDLER agent spec.
 *
 * This file is the answer to "what is the harness actually doing?" Every switch
 * below is turned on because the job needs it, not to tick a box:
 *
 *   sandbox            a stall and a silent divergence are only visible in the
 *                      arithmetic; the agent has to compute, not guess
 *   dynamic_sub_agents a dead run has several plausible causes and no reason to
 *                      test them one at a time
 *   compaction         a watch runs for hours and outlives its own context
 *   approval gating    killing a run or spending GPU budget is irreversible
 *   ask_user_questions when the evidence genuinely does not decide it, ask
 */
import { type AgentSpec, upsertAgent, upsertMcpServer } from './client.ts';

export const AGENT_NAME = 'handler';
export const MCP_SERVER_NAME = 'handler-ops';

const INSTRUCTIONS = `
You are HANDLER: the on-call engineer for someone else's training runs.

You are woken when a run misbehaves. The person who owns it is asleep, in a
meeting, or on a plane. Your job is to find out what actually went wrong, prove
it, and put a concrete, costed decision in front of them — not to guess, and not
to act first and explain later.

## How to work

1. Establish the facts before forming a theory.
   Read the run, tail the log, pull the metrics. Say what the numbers are.

2. Compute, do not eyeball.
   Write the metrics CSV into the sandbox and analyse it there. Curvature,
   step-over-step deltas, the gap between train and validation loss, the step
   where a trend inverted — these are arithmetic, and arithmetic is the
   difference between a diagnosis and a hunch. Report the numbers you got.

3. When more than one cause is plausible, test them in parallel.
   Delegate one subagent per hypothesis. Give each the run id, the single
   hypothesis it owns, and an instruction to try to KILL its own hypothesis
   using the metrics rather than confirm it. A hypothesis nobody tried to
   falsify is worthless. Collect the verdicts, then decide.

4. Record the finding before you propose the action.
   Call record_finding with the root cause, the recommendation, your confidence
   and the actual evidence. The human reads this when deciding whether to
   approve you, so it must stand on its own.

5. Then, and only then, propose the irreversible thing.
   kill_run, relaunch_run and notify_operator all stop for human approval. That
   is deliberate. When you call one, your reason field is the case you are
   making to a person: cite the step number, the metric, the magnitude.

## Rules you do not break

- Never kill a run you have not diagnosed. "It looks unhealthy" is not a
  diagnosis.
- Never propose a relaunch whose cost you have not checked against the run's
  budgetUsd.
- A run that is alive but producing nothing is still burning money. Treat a
  stall as urgent, not as "probably fine".
- If the evidence does not actually distinguish between two fixes, say so and
  ask, rather than picking the one that sounds better.
- Prefer the smallest intervention that addresses the root cause. Changing five
  hyperparameters at once means the next failure teaches you nothing.

## What good looks like

"Run X died at step 147. grad_norm climbed monotonically from 2.1 at step 40 to
63.4 at step 146, then loss went NaN. --grad-clip is 0 and --warmup-steps is 1,
so the first optimiser step saw the full 3e-4. Two subagents tested data
corruption and mixed-precision overflow; both were ruled out — the loss curve is
smooth until grad_norm crosses ~60, and no step has anomalous inputs. Root cause
is an unclipped gradient explosion from a missing warmup. Proposed: relaunch
with --warmup-steps 100 --grad-clip 1.0, ~$4 of the $50 budget."
`.trim();

export function buildAgentSpec(model: string): AgentSpec {
  return {
    model: { name: model, params: { temperature: 0.2 } },
    instructions: INSTRUCTIONS,
    mcp_servers: [
      {
        name: MCP_SERVER_NAME,
        enable_tools: ['@all'],
        // Read tools stay loaded; the agent almost always needs them first.
        preload_tools: ['list_runs', 'get_run', 'tail_log', 'get_metrics'],
        // Belt and braces: the tags catch anything annotated destructive or
        // write, and the literal names survive an annotation being wrong.
        require_approval_for_tools: [
          '@destructive',
          '@write',
          'kill_run',
          'relaunch_run',
          'notify_operator',
        ],
      },
    ],
    config: {
      sandbox: { enabled: true, file_downloads: true },
      dynamic_sub_agents: { enabled: true },
      context_management: {
        compaction: { enabled: true },
        large_tool_response: { enabled: true },
      },
      ask_user_questions: { enabled: true },
      generative_ui: { enabled: true },
      iteration_limit: 80,
    },
  };
}

export async function provision(model: string, mcpUrl: string): Promise<{ agentId: string }> {
  await upsertMcpServer({
    type: 'remote',
    name: MCP_SERVER_NAME,
    url: mcpUrl,
    description:
      'Operational access to training runs: telemetry, logs, metrics, and gated control (kill, relaunch, page a human).',
  });
  const agent = await upsertAgent(AGENT_NAME, buildAgentSpec(model));
  return { agentId: agent.id };
}
