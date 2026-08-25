/**
 * Turns that die on a provider rate limit.
 *
 * A watch is a long-lived, low-urgency workload pointed at whatever model
 * provider the operator happened to configure — including free tiers that
 * allow a handful of requests per minute. An incident that gives up because
 * the provider said "retry in 32s" is worse than useless: it looks like a
 * diagnosis that failed rather than one that never ran.
 *
 * So the watcher treats a rate-limited turn as unfinished work and picks it up
 * again, honouring the delay the provider asked for.
 */
import { listTurns, listSessionEvents, postTurn } from '../trueforge/client.ts';

const RATE_LIMITED = /\b429\b|rate.?limit|quota/i;

export type TurnOutcome =
  | { state: 'running' }
  | { state: 'done' }
  | { state: 'rate-limited'; retryAfterMs: number; message: string }
  | { state: 'error'; message: string };

/** Providers phrase this differently; take the first plausible seconds value. */
export function parseRetryAfterMs(message: string): number {
  const explicit = /retry (?:in|after)\s+([\d.]+)\s*s/i.exec(message);
  if (explicit) return Math.ceil(Number(explicit[1]) * 1000);
  return 45_000;
}

export async function lastTurnOutcome(sessionId: string): Promise<TurnOutcome> {
  const [events, turns] = await Promise.all([listSessionEvents(sessionId), listTurns(sessionId)]);
  if (turns.length === 0) return { state: 'done' };

  // Scope to the CURRENT turn. Taking the last turn.done in the whole session
  // means a 429 from three turns ago still reads as "rate limited" — and the
  // caller would then post "carry on" into a session that is actually sitting
  // on an approval gate, waiting for a human. Nudging an agent mid-gate is a
  // good way to lose the decision a person was about to make.
  const currentTurnId = turns[turns.length - 1]?.id;
  const done = events.find(
    event => event.type === 'turn.done' && (event as { turn_id?: string }).turn_id === currentTurnId,
  ) as { state?: { status?: string; message?: string } } | undefined;

  // No terminal event for the current turn: it is still running, which includes
  // being paused on an approval. Leave it alone.
  if (!done) return { state: 'running' };

  const status = done.state?.status;
  const message = done.state?.message ?? '';
  if (status === 'error' && RATE_LIMITED.test(message)) {
    return { state: 'rate-limited', retryAfterMs: parseRetryAfterMs(message), message };
  }
  if (status === 'error') return { state: 'error', message };
  return { state: 'done' };
}

/**
 * Nudges a session whose last turn died on a rate limit. Returns true when a
 * retry was actually posted, so the caller can log it honestly.
 */
export async function retryIfRateLimited(
  sessionId: string,
  attempt: number,
  maxAttempts: number,
): Promise<{ retried: boolean; waitedMs?: number; reason?: string }> {
  const outcome = await lastTurnOutcome(sessionId);
  if (outcome.state !== 'rate-limited') return { retried: false, reason: outcome.state };
  if (attempt >= maxAttempts) return { retried: false, reason: 'attempts exhausted' };

  const wait = outcome.retryAfterMs;
  await new Promise(resolve => setTimeout(resolve, wait));
  await postTurn(sessionId, [
    {
      type: 'user.message',
      content:
        'The previous turn was cut off by a provider rate limit, not by anything you did. ' +
        'Carry on from where you were. Prefer fewer, larger tool calls — pull the whole metrics ' +
        'CSV once rather than sampling it repeatedly — because model calls are the scarce resource here.',
    },
  ]);
  return { retried: true, waitedMs: wait };
}
