# HANDLER

**The agent that watches your training runs.**

A training run dies at 03:14. Nobody notices until 09:00. The GPU bills for six
hours of nothing, and the person who has to fix it starts their day by
reconstructing what happened from a log file.

HANDLER is the on-call engineer for that. It watches your runs, and when one
misbehaves it works out *why* — with arithmetic, not vibes — and puts a costed,
evidence-backed decision in front of you. It never kills a run or spends your
budget without asking.

Built on [TrueForge](https://trueforge.dev), the open-source agent harness.

---

## The loop

```
  detector fires                    no model call — cheap, and the bar is a real signal
       │
       ▼
  subagents falsify hypotheses      one per plausible cause, in parallel, each
       │                            told to KILL its own hypothesis
       ▼
  sandbox proves the root cause     the metrics CSV, analysed as arithmetic
       │
       ▼
  ══ HUMAN APPROVAL GATE ══        kill / relaunch / page — none of it runs
       │                            until a person says yes
       ▼
  pull request opened               against the config that caused it
       │
       ▼
  code review reads the patch       Qodo reviews the agent's diff
       │
       ▼
  human merges
```

## Why this, on this harness

The Double-O brief asks for a harness that is *doing the work* rather than
sitting under a thin wrapper. Every TrueForge feature HANDLER turns on is load
bearing — remove it and the product stops working:

| harness feature | why the job needs it |
|---|---|
| **MCP tools** | The runs, their logs and their metrics live outside the model. `handler-ops` is a remote MCP server exposing 17 tools over streamable HTTP. |
| **Sandbox** | A stall and a silent divergence are only visible in the numbers — curvature, step deltas, the step a trend inverted. The agent writes the metrics into the sandbox and computes. It does not eyeball a log and guess. |
| **Subagents** | A dead run has several plausible causes and no reason to test them one at a time — the GPU is idle and billing while you do. |
| **Approval gates** | Killing a run destroys un-checkpointed work. Relaunching spends real money. Both are irreversible; both stop for a human. |
| **Session persistence** | A watch runs for hours. The watcher will restart, the harness will restart. The conversation has to survive both. |
| **Compaction** | A long incident outlives its own context window. |

### The approval gate is built out of MCP annotations

This is the part worth stealing. TrueForge derives its approval tags directly
from MCP tool annotations
([`toolSelectors.ts`](https://github.com/truefoundry/trueforge/blob/main/packages/trueforge-core/src/core/mcp/toolSelectors.ts)):

```
readOnlyHint === true                        →  @read-only
readOnlyHint === false && !destructiveHint   →  @write
destructiveHint === true                     →  @destructive
```

So declaring a tool honestly *is* the safety mechanism — the gate is a property
of the tool, not a rule bolted on next to it. HANDLER's 17 tools:

```
@read-only    list_runs · get_run · tail_log · search_log · get_metrics
              compare_runs · list_run_files · read_run_file · list_incidents
              list_configs
@write        record_finding · propose_patch · resolve_incident
@destructive  kill_run · relaunch_run · notify_operator · open_fix_pull_request
```

and the agent spec asks for `["@destructive", "@write", …]` plus the literal
names, so an annotation being wrong cannot silently open a gate.

### Session resume is one function

```ts
async function sessionFor(run: Run) {
  if (run.sessionId && (await sessionExists(run.sessionId))) {
    return { id: run.sessionId, resumed: true };   // rejoin the conversation
  }
  const id = await createSession(AGENT_NAME);
  run.sessionId = id;
  await saveRun(run);
  return { id, resumed: false };
}
```

The session id lives on the run record, on disk. Kill the watcher mid-incident,
kill the harness, bring both back — the next escalation lands in the *same*
conversation, with everything the agent had already established still in it.

---

## Try it

You need Node ≥ 22.18 and Python 3. Nothing else — no Docker, no GPU, no
Daytona. TrueForge's local sandbox fallback covers macOS and Linux.

```bash
# 1. the harness
npx @truefoundry/trueforge
#    → http://localhost:8790 · Settings → Models → add any provider key

# 2. HANDLER
git clone https://github.com/uditjainstjis/handler && cd handler
npm install
npm run mcp          # handler-ops MCP server   :8811
npm run dashboard    # operator console         :8812
npm run watch        # the watcher              (registers the agent on boot)

# 3. give it something to worry about
npm run handler -- run baseline
```

`fixtures/configs/baseline.json` is a config with a real bug in it: someone
removed the LR warmup while chasing a faster first epoch and never put it back.
The run dies at step 62. Watch :8812.

### Reproducing each failure

```bash
npm run handler -- demo healthy          # converges, nothing fires
npm run handler -- demo nan-loss         # gradient explosion → NaN at step 62
npm run handler -- demo oom              # CUDA OOM at step 114 as the batch ramps
npm run handler -- demo stall            # deadlocks alive at step 60
npm run handler -- demo silent-degrade   # never errors; validation quietly diverges
```

`fixtures/trainer.py` is a stand-in for a real training job — seeded, dependency
free, and identical on every machine, so every number in this README is one you
can reproduce.

**The failures are mechanisms, not timers.** `nan-loss` is a genuine compounding
feedback loop: a full-size LR applied before the model settles produces a large
gradient, which moves the weights further out, which makes the next step worse.
Warmup stops it starting; clipping breaks the loop. Measured:

| config | outcome | peak grad_norm |
|---|---|---|
| warmup only, no clipping | survives 400 steps | 1.9 |
| clipping only, no warmup | survives 400 steps | 1.0 |
| **neither** | **NaN at step 62** | **60.6** |

Either fix alone is sufficient — which is exactly why the diagnosis is worth
doing properly instead of changing five knobs and hoping.

### Answering an approval

In the console at :8812, or from the terminal:

```bash
npm run handler -- approvals
npm run handler -- approve <run-id>
npm run handler -- reject  <run-id> "not convinced — grad_norm was flat"
```

Rejections carry the reason back to the agent. A bare "no" teaches it nothing
and it will propose the same thing again.

### Letting it open pull requests

Off by default. An agent quietly acquiring push rights is not something anyone
should get by accident:

```bash
HANDLER_ALLOW_PR=1 npm run mcp
```

With it unset, `open_fix_pull_request` still returns the exact patch it *would*
have opened — the capability stays inspectable without being granted. It shells
out to `gh`, so HANDLER never holds a credential, and only six keys are
patchable (`lr`, `warmup_steps`, `grad_clip`, `batch_size`, `weight_decay`,
`steps`). Anything else needs a human to edit the file.

---

## Layout

```
src/runs/          registry, detached runner, checked-in training configs
src/mcp/           handler-ops MCP server — tools, annotations, the PR path
src/trueforge/     API client and the agent spec
src/watcher/       detectors and escalation (this is the piece that is awake)
src/dashboard/     operator console
fixtures/          the trainer and its configs
tests/             detectors and the safety guards
```

```bash
npm test                          # 29 tests
npm run handler -- doctor         # check every moving part, name what is missing
npm run handler -- transcript <run-id>   # export what HANDLER did, as markdown
npm run handler -- poke <run-id>         # follow-up question; resumes the session
```

The tests worth reading are `tests/safety.test.ts` — path traversal, the
patchable-key allow-list, and the guarantee that relaunch bookkeeping never
leaks onto a command line. Everything else is recoverable; those are not.

## Configuration

| variable | default | |
|---|---|---|
| `TRUEFORGE_URL` | `http://localhost:8790` | harness |
| `HANDLER_MODEL` | `anthropic/claude-sonnet-4-6` | any model TrueForge has a provider for |
| `HANDLER_MCP_PORT` | `8811` | |
| `HANDLER_DASHBOARD_PORT` | `8812` | |
| `HANDLER_POLL_MS` | `3000` | watcher interval |
| `HANDLER_STALL_SECONDS` | `25` | silence before a live run counts as stalled |
| `HANDLER_ALLOW_PR` | unset | `1` lets HANDLER push branches and open PRs |
| `HANDLER_MCP_TOKEN` | generated | shared secret; auto-created at `.handler/mcp-token` |
| `HANDLER_MCP_HOST` | `127.0.0.1` | these tools kill training runs — keep it on loopback |
| `HANDLER_HOME` | `./.handler` | run state |

## Qodo Code Review Evidence

Every substantive change goes through a pull request that Qodo reviews before
it merges; the only direct commit to `main` is the empty scaffold. Qodo raised
**31 findings**, and [#10](https://github.com/uditjainstjis/handler/pull/10)
acts on eight of them — including a prompt-injection path through training-run
logs that I had missed entirely.

See [**QODO.md**](QODO.md) for the full list and what each review changed.

## AI assistance

Built with Claude Code (Claude Opus 5) as a pair programmer — which felt like
the right way to build an agent harness project. Every design decision, every
measured number in this README, and the architecture itself were reviewed and
verified by me before landing, and each PR carries the reasoning in its
description rather than just a diff. The failure-mode mechanics in
`fixtures/trainer.py` went through three iterations because the first two
produced failures that were not physically coherent — the numbers in the table
above are from re-running each configuration, not from a model's assertion.

## Licence

MIT.
