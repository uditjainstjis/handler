/**
 * The servers must answer, not merely start.
 *
 * `tests/imports.test.ts` was added because a file with merge conflict markers
 * reached `main`. It checks that every module *loads* — and that is exactly as
 * far as it goes. A later refactor made the MCP token lazy and left one stale
 * `TOKEN` reference in the `/healthz` handler. The module loaded. The server
 * bound its port and printed its startup line. Every single request then threw
 * `ReferenceError: TOKEN is not defined`.
 *
 * So the process looked healthy, the logs looked healthy, and the doctor
 * correctly refused to spend quota against it — twice, on two separate days,
 * before anyone read the server's own log.
 *
 * Loading is not serving. This tests serving.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

process.env.HANDLER_HOME = await mkdtemp(path.join(tmpdir(), 'handler-serving-'));
process.env.HANDLER_MCP_TOKEN = 'test-token-for-serving';

const { buildApp } = await import('../src/mcp/main.ts');
const mcpApp = buildApp();
const { app: consoleApp } = await import('../src/dashboard/main.ts');

/** Start an app on an ephemeral port and hand back its base URL. */
async function serve(app: unknown): Promise<{ base: string; stop: () => void }> {
  const server = (app as { listen: (p: number, h: string, cb: () => void) => { address: () => { port: number }; close: () => void } })
    .listen(0, '127.0.0.1', () => undefined);
  await new Promise(resolve => setTimeout(resolve, 120));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

test('the MCP health endpoint answers without throwing', async () => {
  const { base, stop } = await serve(mcpApp);
  try {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200, 'healthz must not 500');
    const body = (await response.json()) as { ok: boolean; server: string; authenticated: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.server, 'handler-ops');
    // The exact field whose stale reference threw on every request.
    assert.equal(body.authenticated, true);
  } finally {
    stop();
  }
});

test('the MCP endpoint refuses an unauthenticated call and accepts a good one', async () => {
  const { base, stop } = await serve(mcpApp);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  try {
    const anonymous = await fetch(`${base}/mcp`, { method: 'POST', headers, body });
    assert.equal(anonymous.status, 401, 'no token must be refused, not accepted or crashed');

    const authorised = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'x-handler-token': process.env.HANDLER_MCP_TOKEN! },
      body,
    });
    assert.equal(authorised.status, 200, 'a correct token must be served');
  } finally {
    stop();
  }
});

test('the operator console serves its state endpoint', async () => {
  const { base, stop } = await serve(consoleApp);
  try {
    const response = await fetch(`${base}/api/state`);
    assert.equal(response.status, 200, '/api/state must not 500');
    const state = (await response.json()) as { runs: unknown[] };
    assert.ok(Array.isArray(state.runs), 'state must carry a runs array');
  } finally {
    stop();
  }
});
