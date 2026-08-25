/**
 * Regression tests for the issues Qodo's review surfaced. Each one names the
 * finding it locks down, so nobody quietly reintroduces it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

process.env.HANDLER_HOME ??= path.join(tmpdir(), 'handler-tests');

const { assertRunId, runDir } = await import('../src/runs/store.ts');

test('run ids that walk out of the storage root are refused', () => {
  // "Run IDs escape storage root" — run_id reaches these tools from the model.
  assert.throws(() => assertRunId('../../etc'), /valid run id/);
  assert.throws(() => assertRunId('run_x/../../..'), /valid run id/);
  assert.throws(() => assertRunId(''), /valid run id/);
  assert.throws(() => assertRunId('/etc/passwd'), /valid run id/);
});

test('a genuine run id is accepted and stays under the storage root', () => {
  const id = 'run_mt8txn0i_84bfb3';
  assert.equal(assertRunId(id), id);
  assert.ok(runDir(id).endsWith(path.join('runs', id)));
});

test('a symlink cannot redirect a confined write out of its directory', async () => {
  // "Symlink redirects patch writes" — path.resolve alone cannot see this,
  // because the resolved string still starts with the root.
  const root = await mkdtemp(path.join(tmpdir(), 'confine-'));
  const inside = path.join(root, 'patches');
  const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
  await mkdir(inside, { recursive: true });
  await writeFile(path.join(outside, 'secret'), 'do not touch');
  await symlink(outside, path.join(inside, 'escape'));

  const naive = path.resolve(inside, 'escape/secret');
  assert.ok(
    naive.startsWith(inside + path.sep),
    'the string check passes, which is exactly why it is not sufficient',
  );

  const { realpath } = await import('node:fs/promises');
  const real = await realpath(naive);
  assert.ok(!real.startsWith((await realpath(inside)) + path.sep), 'realpath sees through the symlink');
});

test('the escalation brief quarantines run output instead of fencing it', async () => {
  // "Logs can inject agent instructions" — training code controls stdout, so a
  // log line closing a Markdown fence escapes the evidence framing.
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/watcher/main.ts', import.meta.url), 'utf8'),
  );
  assert.ok(source.includes('quarantine('), 'brief must quarantine untrusted text');
  assert.ok(
    !/'```'\s*,\s*\n\s*logText/.test(source),
    'the raw log must not go straight into a Markdown fence',
  );
});

test('a quarantine delimiter cannot collide with its own content', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/watcher/main.ts', import.meta.url), 'utf8'),
  );
  // The delimiter is extended until it no longer appears in the content, so a
  // log line that literally prints the marker still cannot break out.
  assert.ok(
    source.includes("while (content.includes(fence)) fence += 'X';"),
    'the fence must be derived from the content it wraps',
  );
});

test('search_log refuses patterns with a quantified group', async () => {
  // "Regex can block event loop" — the pattern is model-supplied and compiled
  // into a backtracking engine, and this process runs the whole watch.
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/mcp/tools.ts', import.meta.url), 'utf8'),
  );
  assert.ok(source.includes('pattern.length > 200'), 'pattern length must be bounded');
  assert.ok(/\\\)\[\+\*\{\]/.test(source), 'a quantified group must be refused');

  // A quantified GROUP is the precondition both catastrophic shapes share.
  // Character classes are linear, so the guard deliberately ignores them.
  const guard = /\)[+*{]/;
  assert.ok(guard.test('(a+)+'), 'nested quantifier is caught');
  assert.ok(guard.test('(a|a)*'), 'alternation with an outer star is caught');
  assert.ok(guard.test('(x|y){10}'), 'a counted repeated group is caught');
  assert.ok(!guard.test('OutOfMemoryError'), 'ordinary patterns still work');
  assert.ok(!guard.test('grad_norm.*[0-9]+'), 'a normal log search still works');
  assert.ok(!guard.test('Traceback|RuntimeError'), 'plain alternation is fine');
});
