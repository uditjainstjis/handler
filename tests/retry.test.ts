import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRetryAfterMs } from '../src/watcher/retry.ts';

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
