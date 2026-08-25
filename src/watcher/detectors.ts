/**
 * The detectors decide *when* to wake the agent. They are deliberately dumb.
 *
 * A detector answers "is something wrong here?" — cheaply, with no model call.
 * Working out *what* is wrong is the agent's job, and doing that costs tokens,
 * so the bar for waking it has to be a real signal rather than a hunch.
 *
 * Every detector returns the evidence that tripped it, and that evidence is
 * handed to the agent as its opening context.
 */
import type { MetricRow, Run } from '../runs/store.ts';

export type Detection = {
  detector: string;
  severity: 'warn' | 'critical';
  summary: string;
  evidence: Record<string, unknown>;
};

export type DetectorInput = {
  run: Run;
  alive: boolean;
  metrics: MetricRow[];
  log: string;
  /** Seconds with no new metric row before a live run counts as stalled. */
  stallSeconds: number;
  now: number;
};

export function detect(input: DetectorInput): Detection | undefined {
  return (
    detectCrash(input) ??
    detectNaN(input) ??
    detectOom(input) ??
    detectStall(input) ??
    detectValidationDivergence(input)
  );
}

function detectCrash({ run, metrics, log }: DetectorInput): Detection | undefined {
  if (run.status !== 'failed') return undefined;
  const last = metrics[metrics.length - 1];
  const traceback = log
    .split('\n')
    .filter(line => /Traceback|Error|Exception/i.test(line))
    .slice(-6)
    .join('\n');
  return {
    detector: 'process-exited-nonzero',
    severity: 'critical',
    summary: `${run.name} exited with code ${run.exitCode} after ${last?.step ?? 0} steps.`,
    evidence: { exitCode: run.exitCode, lastStep: last?.step, traceback },
  };
}

function detectNaN({ run, metrics }: DetectorInput): Detection | undefined {
  const nanRow = metrics.find(row => row.loss === null);
  if (!nanRow) return undefined;
  const before = metrics.filter(row => row.step < nanRow.step).slice(-10);
  return {
    detector: 'loss-nan',
    severity: 'critical',
    summary: `${run.name} produced a non-finite loss at step ${nanRow.step}.`,
    evidence: {
      nanAtStep: nanRow.step,
      gradNormLeadUp: before.map(row => ({ step: row.step, grad_norm: row.grad_norm })),
      lrAtFailure: nanRow.lr,
    },
  };
}

function detectOom({ run, log }: DetectorInput): Detection | undefined {
  const line = log.split('\n').find(l => /out of memory|OutOfMemoryError/i.test(l));
  if (!line) return undefined;
  return {
    detector: 'cuda-oom',
    severity: 'critical',
    summary: `${run.name} ran out of device memory.`,
    evidence: { logLine: line.trim() },
  };
}

function detectStall({ run, alive, metrics, stallSeconds, now }: DetectorInput): Detection | undefined {
  if (!alive || run.status !== 'running') return undefined;
  const last = metrics[metrics.length - 1];
  if (!last) return undefined;
  const idle = now / 1000 - last.ts;
  if (idle < stallSeconds) return undefined;
  return {
    detector: 'stall',
    severity: 'critical',
    summary: `${run.name} is alive but has not logged a step for ${Math.round(idle)}s (stuck at step ${last.step}).`,
    evidence: { lastStep: last.step, idleSeconds: Math.round(idle), pid: run.pid },
  };
}

/**
 * The failure nothing crashes on: training loss keeps falling while validation
 * loss turns upward. Needs a window, because one noisy step means nothing.
 */
function detectValidationDivergence({ run, metrics }: DetectorInput): Detection | undefined {
  const rows = metrics.filter(row => typeof row.loss === 'number' && typeof row.val_loss === 'number');
  if (rows.length < 60) return undefined;

  const window = rows.slice(-40);
  const half = Math.floor(window.length / 2);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

  const trainEarly = mean(window.slice(0, half).map(r => r.loss as number));
  const trainLate = mean(window.slice(half).map(r => r.loss as number));
  const valEarly = mean(window.slice(0, half).map(r => r.val_loss as number));
  const valLate = mean(window.slice(half).map(r => r.val_loss as number));

  const trainImproving = trainLate < trainEarly - 0.005;
  const valWorsening = valLate > valEarly + 0.02;
  if (!trainImproving || !valWorsening) return undefined;

  return {
    detector: 'validation-divergence',
    severity: 'warn',
    summary: `${run.name} is overfitting: train loss still falling, validation loss rising over the last ${window.length} steps.`,
    evidence: {
      window: window.length,
      trainEarly: +trainEarly.toFixed(4),
      trainLate: +trainLate.toFixed(4),
      valEarly: +valEarly.toFixed(4),
      valLate: +valLate.toFixed(4),
      gap: +(valLate - trainLate).toFixed(4),
    },
  };
}
