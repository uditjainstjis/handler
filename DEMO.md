# Demo script — ~3 minutes

Four windows, arranged before recording:

- **A** browser, HANDLER console, `localhost:8812`
- **B** terminal, watcher log (`npm run watch`)
- **C** browser, TrueForge chat on the live session
- **D** terminal, free for commands

Reset first so the run ids are clean:

```bash
rm -rf .handler && npm run handler -- run baseline
```

---

## 0:00 — the problem (15s)

> A training run dies at three in the morning. Nobody notices until nine. The
> GPU bills for six hours of producing nothing, and whoever owns the run starts
> their day reconstructing what happened from a log file.
>
> HANDLER is the on-call engineer for that.

**On screen:** console (A) with a run going, loss curve descending normally.

## 0:15 — it dies (15s)

**On screen:** the curve turns upward and the line stops. Status flips to
FAILED. Watcher (B) prints:

```
escalated run_… (process-exited-nonzero) -> session … [new session]
```

> Step 62. Loss went NaN. No human involved yet — a detector noticed, and
> detectors cost nothing, so the bar to wake the agent is a real signal.

## 0:30 — it establishes facts, then computes (35s)

**On screen:** TrueForge chat (C), tool calls scrolling.

> It reads the run, tails the log, pulls the metrics — then writes analysis code
> and runs it **in the sandbox**. That matters: a stall and a silent divergence
> don't exist in the log. They only exist in the arithmetic.

**Point at:** `exec` → `analyze.py`.

## 1:05 — three subagents, each told to be wrong (35s)

**On screen:** the three `create_sub_agent` calls, then a verdict.

> Three plausible causes, so three subagents in parallel — data corruption,
> gradient explosion, an unusable learning rate. Each one is told to **kill** the
> hypothesis it owns, not confirm it. A hypothesis nobody attacked is worth
> nothing.

**Point at:** `Verdict on Hypothesis A: KILLED (Falsified)`.

## 1:40 — the gate (35s)

**On screen:** switch to console (A). The amber approval card is at the top.

> Here it stops. `relaunch_run` is annotated destructive, and TrueForge derives
> its approval tags straight from the MCP annotation — so declaring the tool
> honestly *is* the safety mechanism. It cannot execute until I say so.
>
> And it has made its case: the step number, the gradient norm, the magnitude.

**Read the reason field aloud.** Then click **Reject** and type a reason.

> Rejections carry the reason back. A bare "no" teaches it nothing and it
> proposes the same thing again.

Then click **Approve** on the next proposal.

## 2:15 — kill the harness (25s)

**On screen:** terminal (D).

```bash
pkill -f trueforge/dist/main.js          # the harness itself, gone
npx @truefoundry/trueforge &             # bring it back
npm run handler -- poke <run-id> "Did you survive the restart?"
```

> A watch runs for hours, and the harness *will* restart inside one. The session
> id lives on the run record, on disk —

Terminal prints:

```
resumed existing session 01m0ww40n2jq3dcrkk7qxt959x —
everything it already worked out is still there
```

> — so it rejoins the same conversation. Nothing is re-derived.

**Verified, not staged:** this is a real kill of the TrueForge process and a
real reconnect afterwards.

## 2:40 — the loop closes (20s)

**On screen:** the pull request on GitHub.

> Approved, it opens a pull request against the config that caused the failure.
> Not a suggestion in a chat log someone has to retype at 3am — a diff they can
> merge. And Qodo reviews the agent's patch the same way it reviews mine.

## 3:00 — close (10s)

> Detector, sandbox, parallel falsification, a human gate, a reviewed pull
> request. Every one of those is a TrueForge feature doing actual work.
>
> HANDLER. It watches your runs so you can sleep.

---

## Notes

- The free Gemini tier allows five requests a minute, so cut the waits between
  beats. The retry path handles them correctly, but nobody wants to watch a
  backoff.
- Have a **second terminal with a finished incident** ready. If a 429 lands
  mid-take, cut to that rather than restarting the whole run.
- Don't show the API key panel in TrueForge settings on camera, and don't show
  `.handler/mcp-token`.
- `npm run handler -- transcript <run-id> artifacts/run.md` exports what
  happened, if you want a still to cut to.
- Record the reject-then-approve sequence in one take if possible — the
  rejection reason going back to the agent is the most convincing single beat.
