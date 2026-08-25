/**
 * The guards that stop a model-driven tool doing something nobody asked for.
 * These are the tests worth having: everything else is recoverable.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { applyOverrides } from '../src/runs/runner.ts';
import { CONFIG_DIR, PATCHABLE_KEYS, applyConfigChanges, configPath } from '../src/runs/config.ts';
import type { TrainingConfig } from '../src/runs/config.ts';

const config: TrainingConfig = {
  name: 'baseline',
  fail_mode: 'nan-loss',
  steps: 400,
  lr: 0.0003,
  warmup_steps: 1,
  grad_clip: 0,
  batch_size: 32,
  weight_decay: 0,
  seed: 1337,
};

test('a config name cannot escape the config directory', () => {
  assert.throws(() => configPath('../../../etc/passwd'), /escapes/);
  assert.throws(() => configPath('../package'), /escapes/);
});

test('an ordinary config name resolves inside the config directory', () => {
  assert.equal(configPath('baseline'), path.join(CONFIG_DIR, 'baseline.json'));
  assert.equal(configPath('baseline.json'), path.join(CONFIG_DIR, 'baseline.json'));
});

test('only allow-listed keys can be patched', () => {
  const { next, rejected } = applyConfigChanges(config, {
    warmup_steps: 100,
    seed: 9999,
    fail_mode: 1 as unknown as number,
  });
  assert.equal(next.warmup_steps, 100);
  assert.equal(next.seed, 1337, 'seed must survive — changing it invalidates the comparison');
  assert.equal(next.fail_mode, 'nan-loss');
  assert.deepEqual(rejected.sort(), ['fail_mode', 'seed']);
});

test('the patchable set stays deliberately small', () => {
  // If this fails someone widened the blast radius. That should be a decision,
  // not a diff nobody noticed.
  assert.deepEqual([...PATCHABLE_KEYS], [
    'lr',
    'warmup_steps',
    'grad_clip',
    'batch_size',
    'weight_decay',
    'steps',
  ]);
});

test('patching does not mutate the original config', () => {
  const before = JSON.stringify(config);
  applyConfigChanges(config, { warmup_steps: 100 });
  assert.equal(JSON.stringify(config), before);
});

test('overrides replace an existing flag rather than appending a duplicate', () => {
  const out = applyOverrides(
    ['python3', 'trainer.py', '--warmup-steps', '1', '--steps', '400'],
    { warmup_steps: 100 },
  );
  assert.deepEqual(out, ['python3', 'trainer.py', '--warmup-steps', '100', '--steps', '400']);
  assert.equal(out.filter(token => token === '--warmup-steps').length, 1);
});

test('overrides append a flag the command never had', () => {
  const out = applyOverrides(['python3', 'trainer.py'], { grad_clip: 1 });
  assert.deepEqual(out, ['python3', 'trainer.py', '--grad-clip', '1']);
});

test('underscores in override keys become dashes in flags', () => {
  const out = applyOverrides(['python3', 'trainer.py'], { warmup_steps: 100 });
  assert.ok(out.includes('--warmup-steps'));
  assert.ok(!out.includes('--warmup_steps'));
});

test('relaunch bookkeeping never leaks into the command line', () => {
  const out = applyOverrides(['python3', 'trainer.py'], {
    relaunchedFrom: 'run_abc' as unknown as string,
    grad_clip: 1,
  });
  assert.ok(!out.join(' ').includes('relaunched'));
  assert.ok(out.includes('--grad-clip'));
});
