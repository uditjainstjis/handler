import assert from 'node:assert/strict';
import test from 'node:test';

import { backoffMs, parseRetryAfterMs } from '../src/watcher/retry.ts';

test('honours the delay the provider actually asked for', () => {
  const gemini =
    'Request failed (429): You exceeded your current quota. ' +
    '* Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, model: gemini-3.6-flash\n' +
    'Please retry in 32.344760212s.';
  assert.equal(parseRetryAfterMs(gemini), 32345);
});

test('accepts the "retry after" phrasing too', () => {
  assert.equal(parseRetryAfterMs('rate limited, please retry after 12s'), 12000);
});

test('falls back to a conservative wait when no delay is given', () => {
  // Backing off too little against a per-minute quota just burns the next
  // request on another 429.
  assert.equal(parseRetryAfterMs('429 Too Many Requests'), 45_000);
  assert.ok(parseRetryAfterMs('quota exceeded') >= 30_000);
});

test('a sub-second delay still rounds up to a real wait', () => {
  assert.equal(parseRetryAfterMs('please retry in 0.5s'), 500);
});

test('a stale 429 from an earlier turn does not look like the current one', async () => {
  // The hazard: the watcher sees an old rate-limit turn.done, decides the
  // session is stalled, and posts "carry on" into a session that is actually
  // holding on an approval gate waiting for a human.
  const { createServer } = await import('node:http');
  const events = [
    { turn_id: 'turn_old', event: { id: 'e1', type: 'turn.done', created_at: '2026-08-25T18:00:00Z',
      state: { status: 'error', message: 'Request failed (429): quota. Please retry in 57s.' } } },
    { turn_id: 'turn_new', event: { id: 'e2', type: 'tool.approval_required', created_at: '2026-08-25T18:05:00Z',
      thread_id: 'main', tool_calls: [{ id: 'call_1', source_event_id: 'e0' }] } },
  ];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/events')) return res.end(JSON.stringify({ data: events }));
    if (req.url?.includes('/turns')) {
      return res.end(JSON.stringify({ data: [{ id: 'turn_old' }, { id: 'turn_new' }] }));
    }
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    process.env.TRUEFORGE_URL = `http://127.0.0.1:${port}`;
    const { lastTurnOutcome } = await import('../src/watcher/retry.ts?case=stale');
    const outcome = await lastTurnOutcome('s1');
    assert.equal(outcome.state, 'running', 'the current turn is live — do not nudge it');
  } finally {
    server.close();
  }
});

test('the first retry trusts the provider, later ones stop believing it', () => {
  // A per-minute limit and a spent daily quota produce the same 429 and the
  // same "retry in ~57s". Only whether retrying works tells them apart.
  assert.equal(backoffMs(57_000, 0), 57_000);
  assert.equal(backoffMs(57_000, 1), 57_000);
  assert.equal(backoffMs(57_000, 2), 114_000);
  assert.equal(backoffMs(57_000, 3), 228_000);
});

test('backoff is capped so a watch never goes silent for hours', () => {
  assert.equal(backoffMs(57_000, 20), 30 * 60 * 1000);
  assert.ok(backoffMs(45_000, 99) <= 30 * 60 * 1000);
});
