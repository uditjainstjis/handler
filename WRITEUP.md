# HANDLER — what it does and how it uses TrueForge

*Submission write-up · The Agent Harness Hackathon · Double-O track*

## The job

A training run dies at 03:14. Nobody notices until 09:00. The GPU bills for six
hours of producing nothing, and the person who owns the run starts their day
reconstructing what happened from a log file.

That is the job HANDLER is given: **be the on-call engineer for someone else's
training runs.** Not "summarise this log" — actually work out why the run died,
prove it with the numbers, and put a costed decision in front of a human who is
asleep.

It is a real job because the failure is expensive, the diagnosis is
mechanical enough to delegate, and the actions that fix it are irreversible
enough that you would never let software take them alone. That combination is
exactly what an agent harness is for.

## What it actually does

```
detector fires  →  subagents falsify hypotheses  →  sandbox proves the cause
     →  HUMAN APPROVAL GATE  →  pull request  →  code review  →  human merges
```

1. **A watcher polls the runs.** Five detectors, no model calls: non-zero exit,
   NaN loss, CUDA OOM, stall (alive but producing nothing), and validation
   divergence (nothing crashes at all). Waking the agent costs tokens, so the
   bar to wake it is a real signal with evidence attached.

2. **The agent establishes facts before forming a theory** — reads the run,
   tails the log, pulls the metrics.

3. **It computes rather than eyeballs.** The metrics go into the sandbox as CSV
   and get analysed there: step deltas, where a trend inverted, the train/val
   gap. A stall and a silent divergence do not exist in the log — only in the
   arithmetic.

4. **Competing causes are tested in parallel.** One subagent per hypothesis,
   each instructed to *falsify* the hypothesis it owns rather than confirm it.
   A hypothesis nobody attacked is worth nothing.

5. **It records the finding before proposing the action** — root cause,
   recommendation, confidence, evidence. This is what the human reads when
   deciding whether to approve, so it has to stand on its own.

6. **Then it stops.** `kill_run`, `relaunch_run`, `notify_operator` and
   `open_fix_pull_request` all pause for human approval. The `reason` field is
   the agent's case to a person: step number, metric, magnitude.

7. **Approved, it opens a pull request** against the config that caused the
   failure — and a code reviewer reads the agent's patch the same way it would
   read a human's.

## How TrueForge is used

Not as a chat wrapper. Every harness feature is load bearing — remove any one
and the product stops working:

**MCP.** `handler-ops` is a remote MCP server over streamable HTTP exposing 17
tools. TrueForge's `MCPServerType` enum has one member, `remote`, so this was
never going to be stdio.

**Approval gates built from annotations.** This is the piece I would keep.
TrueForge derives its approval tags directly from MCP tool annotations
(`toolSelectors.ts:35-43`): `readOnlyHint` → `@read-only`, `destructiveHint` →
`@destructive`. So declaring a tool honestly *is* the safety mechanism — the
gate is a property of the tool rather than a rule bolted on beside it. Ten
read-only tools, three writes, four destructive; the spec gates `@destructive`
and `@write` plus the literal names, so a wrong annotation cannot silently open
a gate.

**Sandbox.** `config.sandbox.enabled` — the agent writes analysis code and runs
it. Verified live: it authored `analyze.py` and executed it against a real run's
metrics.

**Subagents.** `config.dynamic_sub_agents.enabled` — parallel hypothesis
testing. Serial testing wastes the window in which the GPU is idle and billing.

**Session persistence.** The session id lives on the run record on disk. Kill
the watcher mid-incident, kill the harness, bring both back: the next escalation
rejoins the *same* conversation with everything the agent already established.
That is not a demo trick — a watch runs for hours and both processes will
restart inside one.

**Compaction.** A long incident outlives its own context window.

## Two things the harness taught me

**Deferred tool loading is a trade, not a default.** The agent's first three
model calls were `list_tools` and two `get_tool_info` calls — it had not looked
at the incident yet and had already spent most of a minute's quota. The cause
was mine: setting `preload_tools: [...]` to name four tools eagerly *implies
`preload: false`*, which defers the other thirteen. The intent was "load these
first"; the effect was "defer everything else". With one server and 17 tools,
`preload: true` is simply correct. It is the right default for an agent facing
many servers with hundreds of tools, and the wrong one here.

**A rate-limited turn is unfinished work, not failed work.** Running against a
free tier capped at five requests per minute made every wasted model call
visible. The watcher now parses the delay the provider asks for, waits it out,
and resumes the session. An incident that gives up because the provider said
"retry in 32s" is worse than useless — in the console it looks like a diagnosis
that failed rather than one that never ran, and an operator who sees a failed
diagnosis stops trusting the next one.

## Control and safety

- Nothing irreversible executes without a human. Not "logs a warning" — the
  harness holds the tool call.
- Rejections carry a reason back to the agent. A bare "no" teaches it nothing
  and it proposes the same thing again.
- Pull requests are off unless `HANDLER_ALLOW_PR=1`. With it unset the tool
  still returns the exact patch it *would* have opened, so the capability is
  inspectable without being granted.
- HANDLER never holds a credential — it shells out to `gh`, so a PR is
  attributable to the human whose machine it ran on.
- Six config keys are patchable, allow-listed. Anything else needs a human to
  edit the file.
- Path handling in `read_run_file` and `propose_patch` resolves and
  bounds-checks. A model-driven file tool is the obvious place for a traversal
  bug, and `tests/safety.test.ts` covers it.

## Reproducing it

Node ≥ 22.18 and Python 3. No Docker, no GPU, no Daytona — TrueForge's local
sandbox fallback covers macOS and Linux.

```bash
npx @truefoundry/trueforge          # harness, :8790, add a model provider
git clone https://github.com/uditjainstjis/handler && cd handler && npm install
npm run mcp & npm run dashboard & npm run watch &
npm run handler -- run baseline     # dies at step 62; watch :8812
```

`fixtures/trainer.py` is seeded and dependency-free, so every number in the
README is one a judge can reproduce. The failure modes are mechanisms rather
than timers: `nan-loss` is a genuine compounding feedback loop, and *either*
warmup or gradient clipping fixes it independently (measured: 1.9 and 1.0 peak
grad_norm respectively, versus 60.6 and a NaN at step 62 with neither). That is
deliberate — it forces a real argument about which intervention is minimal
instead of pattern-matching one.

## Honest limits

- The trainer is a fixture, not PyTorch. The detectors and the diagnosis work on
  real `metrics.jsonl` and real logs, but I have not pointed it at a multi-day
  job on a real cluster.
- Detectors are threshold-based. They are cheap and legible, and I would rather
  a human tunes `HANDLER_STALL_SECONDS` than have a model decide when to wake
  itself.
- Free-tier rate limits shape the pacing of a live demo. The retry path handles
  it correctly, but a paid key is a materially better experience.

## AI assistance

Built with Claude Code (Claude Opus 5) as a pair programmer, which felt like the
right way to build an agent-harness project. Every architectural decision and
every measured number here was reviewed and verified by me before it landed, and
each pull request carries the reasoning rather than just a diff. The failure
mechanics in `fixtures/trainer.py` took three iterations because the first two
produced failures that were not physically coherent — the numbers above come
from re-running each configuration, not from a model asserting them.
