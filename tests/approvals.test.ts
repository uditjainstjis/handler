/**
 * The approval queue, against the event shapes TrueForge actually emits.
 *
 * This is the one path that cannot be exercised cheaply end-to-end — reaching a
 * gate costs a full diagnosis — so the shapes are pinned here instead, taken
 * from the OpenAPI schema and from observed traffic:
 *
 *   ToolApprovalRequiredEvent.tool_calls  ->  { id, source_event_id }
 *                                             NO name, NO arguments
 *   model.message.tool_calls              ->  { id, function: { name, arguments } }
 *                                             arguments is a JSON *string*
 *
 * Reading `.name` off the ref yields undefined, and an approval card reading
 * "undefined" is worse than no card at all: the entire point of the gate is
 * that a person can see what they are being asked to allow.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

/** A stub harness that serves one fixed event list. */
async function withEvents(events: unknown[], run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/events')) {
      res.end(JSON.stringify({ data: events.map(event => ({ turn_id: 't1', event })) }));
      return;
    }
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const MODEL_MESSAGE = {
  id: 'evt_model_1',
  type: 'model.message',
  created_at: '2026-08-25T18:00:00.000Z',
  thread_id: 'main',
  tool_calls: [
    {
      id: 'call_777',
      type: 'function',
      function: {
        name: 'relaunch_run',
        arguments: '{"run_id":"run_abc","overrides":{"warmup_steps":100},"rationale":"grad_norm hit 60.6"}',
      },
    },
  ],
};

const APPROVAL_REQUIRED = {
  id: 'evt_gate_1',
  type: 'tool.approval_required',
  created_at: '2026-08-25T18:00:01.000Z',
  thread_id: 'main',
  // Exactly what ToolCallRef allows: id and source_event_id, nothing else.
  tool_calls: [{ id: 'call_777', source_event_id: 'evt_model_1' }],
};

test('an approval resolves its name and arguments through source_event_id', async () => {
  await withEvents([MODEL_MESSAGE, APPROVAL_REQUIRED], async base => {
    process.env.TRUEFORGE_URL = base;
    const { pendingApprovals } = await import(`../src/trueforge/client.ts?case=resolve`);
    const pending = await pendingApprovals('s1');

    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'relaunch_run', 'the name lives on the model.message, not the ref');
    assert.equal(pending[0].toolCallId, 'call_777');
    assert.equal(pending[0].threadId, 'main');

    // Arguments arrive as a JSON string and must be parsed, or the card renders
    // an escaped blob instead of readable fields.
    const args = pending[0].arguments as { run_id: string; overrides: Record<string, number> };
    assert.equal(args.run_id, 'run_abc');
    assert.equal(args.overrides.warmup_steps, 100);
  });
});

test('answering an approval clears it from the queue', async () => {
  const response = {
    id: 'evt_resp_1',
    type: 'tool.response',
    created_at: '2026-08-25T18:00:09.000Z',
    tool_call_id: 'call_777',
  };
  await withEvents([MODEL_MESSAGE, APPROVAL_REQUIRED, response], async base => {
    process.env.TRUEFORGE_URL = base;
    const { pendingApprovals } = await import(`../src/trueforge/client.ts?case=cleared`);
    assert.deepEqual(await pendingApprovals('s1'), [], 'an answered gate must leave the queue');
  });
});

test('an approval whose source event is missing still names something usable', async () => {
  // Compaction can drop the originating message. Rendering "undefined" would
  // be strictly worse than admitting we do not know.
  await withEvents([APPROVAL_REQUIRED], async base => {
    process.env.TRUEFORGE_URL = base;
    const { pendingApprovals } = await import(`../src/trueforge/client.ts?case=orphan`);
    const pending = await pendingApprovals('s1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'unknown tool');
    assert.notEqual(pending[0].name, undefined);
  });
});
