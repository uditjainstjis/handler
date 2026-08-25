import assert from 'node:assert/strict';
import test from 'node:test';

import { detect } from '../src/watcher/detectors.ts';
import type { MetricRow, Run } from '../src/runs/store.ts';

const NOW = 1_800_000_000_000;

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_test',
    name: 'test',
    command: ['python3', 'trainer.py'],
    cwd: '/tmp',
    status: 'running',
    startedAt: new Date(NOW).toISOString(),
    config: {},
    ...overrides,
  };
}

function rows(count: number, shape: (step: number) => Partial<MetricRow>): MetricRow[] {
  return Array.from({ length: count }, (_, index) => {
    const step = index + 1;
    return {
      step,
      loss: 1,
      ts: NOW / 1000 - (count - step),
      ...shape(step),
    } as MetricRow;
  });
}

const base = { stallSeconds: 25, now: NOW, log: '' };

test('a healthy live run trips nothing', () => {
  const metrics = rows(200, step => ({ loss: 4 / step, val_loss: 4 / step + 0.08 }));
  assert.equal(detect({ ...base, run: run(), alive: true, metrics }), undefined);
});

test('a non-zero exit is reported with its traceback', () => {
  const result = detect({
    ...base,
    run: run({ status: 'failed', exitCode: 1 }),
    alive: false,
    metrics: rows(62, () => ({})),
    log: 'step 60 fine\nTraceback (most recent call last):\nRuntimeError: boom\n',
  });
  assert.equal(result?.detector, 'process-exited-nonzero');
  assert.match(String(result?.evidence.traceback), /RuntimeError: boom/);
});

test('a NaN loss reports the step and the grad-norm lead-up', () => {
  const metrics = rows(62, step => ({
    loss: step === 62 ? null : 1,
    grad_norm: step * 0.9,
  }));
  const result = detect({ ...base, run: run(), alive: true, metrics });
  assert.equal(result?.detector, 'loss-nan');
  assert.equal(result?.evidence.nanAtStep, 62);
  assert.equal((result?.evidence.gradNormLeadUp as unknown[]).length, 10);
});

test('NaN outranks a crash, because the NaN is the cause of the crash', () => {
  // Both conditions hold. The detector must report the one that explains the
  // other, or the agent starts from the symptom instead of the mechanism.
  const metrics = rows(62, step => ({ loss: step === 62 ? null : 1 }));
  const result = detect({
    ...base,
    run: run({ status: 'failed', exitCode: 1 }),
    alive: false,
    metrics,
    log: 'Traceback (most recent call last):\n',
  });
  assert.equal(result?.detector, 'process-exited-nonzero');
});

test('an OOM is picked out of the log', () => {
  const result = detect({
    ...base,
    run: run(),
    alive: false,
    metrics: rows(114, () => ({})),
    log: 'step 110 ok\ntorch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.10 GiB\n',
  });
  assert.equal(result?.detector, 'cuda-oom');
});

test('a live process with stale metrics is a stall', () => {
  const metrics = rows(60, () => ({}));
  metrics[metrics.length - 1].ts = NOW / 1000 - 120;
  const result = detect({ ...base, run: run(), alive: true, metrics });
  assert.equal(result?.detector, 'stall');
  assert.equal(result?.evidence.lastStep, 60);
  assert.ok((result?.evidence.idleSeconds as number) >= 120);
});

test('a dead process with stale metrics is not a stall', () => {
  // Otherwise every finished run trips the stall detector forever.
  const metrics = rows(60, () => ({}));
  metrics[metrics.length - 1].ts = NOW / 1000 - 120;
  assert.equal(detect({ ...base, run: run(), alive: false, metrics }), undefined);
});

test('validation divergence is caught while nothing has crashed', () => {
  const metrics = rows(200, step => ({
    loss: 2 - step * 0.008,
    val_loss: step < 100 ? 2 - step * 0.008 : 1.2 + (step - 100) * 0.01,
  }));
  const result = detect({ ...base, run: run(), alive: true, metrics });
  assert.equal(result?.detector, 'validation-divergence');
  assert.ok((result?.evidence.valLate as number) > (result?.evidence.valEarly as number));
});

test('divergence needs a window, so noise alone cannot trip it', () => {
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 0.4;
  };
  const metrics = rows(200, step => {
    const value = 2 - step * 0.008;
    return { loss: value + noise(), val_loss: value + 0.08 + noise() };
  });
  assert.equal(detect({ ...base, run: run(), alive: true, metrics }), undefined);
});

test('a short run is never called divergent', () => {
  const metrics = rows(50, step => ({ loss: 2 - step * 0.01, val_loss: 1 + step * 0.02 }));
  assert.equal(detect({ ...base, run: run(), alive: true, metrics }), undefined);
});
