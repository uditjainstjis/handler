/**
 * The kill path, exercised against real processes.
 *
 * This is the one behaviour where a unit test would have proved nothing. The
 * bug it locks down — killing the wrapper and orphaning the trainer — passed
 * every assertion you could write about the run record, because the record
 * said `killed` while the training process carried on burning GPU. Only
 * looking at the process table catches it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HOME = await mkdtemp(path.join(tmpdir(), 'handler-kill-'));
process.env.HANDLER_HOME = HOME;

const { startRun, killRun, isAlive, reconcile } = await import('../src/runs/runner.ts');
const { loadRun } = await import('../src/runs/store.ts');

const MARKER = `handler-kill-test-${process.pid}`;

function survivors(): number {
  const out = execSync(`ps -eo pid,command | grep ${MARKER} | grep -v grep | wc -l`).toString().trim();
  return Number(out);
}

test.after(async () => {
  execSync(`pkill -9 -f ${MARKER} 2>/dev/null || true`);
  await rm(HOME, { recursive: true, force: true });
});

test('killing a run terminates the actual work, not just the wrapper', async () => {
  const run = await startRun({
    name: 'kill-test',
    // sh -c so there is a shell between the wrapper and the sleeper, matching
    // the real shape: recorded pid is never the process doing the work.
    command: ['/bin/sh', '-c', `exec sleep 120 # ${MARKER}`],
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.ok(survivors() > 0, 'the work should be running before we kill it');

  await killRun(run.id, 'test');
  await new Promise(resolve => setTimeout(resolve, 2500));

  assert.equal(survivors(), 0, 'killing the run must reach the process doing the work');
  const after = await loadRun(run.id);
  assert.equal(after?.status, 'killed');
});

test('a killed run is not reconciled back into failed', async () => {
  // The operator's decision is recorded against the run; the wrapper's exit
  // code must not overwrite it.
  const run = await startRun({
    name: 'reconcile-test',
    command: ['/bin/sh', '-c', `exec sleep 120 # ${MARKER}`],
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  await killRun(run.id, 'test');
  await new Promise(resolve => setTimeout(resolve, 2000));

  const killed = await loadRun(run.id);
  assert.equal(killed?.status, 'killed');
  const reconciled = await reconcile(killed!);
  assert.equal(reconciled.status, 'killed', 'reconcile must leave an operator decision alone');
});

test('killing a run that already finished does not signal a recycled pid', async () => {
  const run = await startRun({ name: 'finished-test', command: ['/bin/sh', '-c', 'exit 0'] });
  await new Promise(resolve => setTimeout(resolve, 1500));

  const settled = await reconcile((await loadRun(run.id))!);
  assert.equal(settled.status, 'succeeded');
  assert.equal(settled.exitCode, 0);

  // The pid may since belong to something else entirely; killRun must not
  // signal it. It should still record the operator's intent.
  const after = await killRun(run.id, 'test');
  assert.equal(after.status, 'killed');
});

test('isAlive is false for a pid that never existed', () => {
  assert.equal(isAlive(undefined), false);
  assert.equal(isAlive(0), false);
});
