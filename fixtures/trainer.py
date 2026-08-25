#!/usr/bin/env python3
"""A deterministic stand-in for a long training run.

Real training runs are the thing HANDLER watches, but a judge cannot reproduce
someone else's GPU box. This trainer needs nothing but a Python interpreter and
fails in exactly the same way every time, so every demo beat is reproducible.

It writes the two files a real run would write:

  metrics.jsonl   one JSON object per step
  stdout          human log lines, including framework-shaped tracebacks

Failure modes (--fail-mode):

  healthy         converges and exits 0
  nan-loss        gradients explode, loss goes NaN, process dies
  oom             CUDA OOM once the batch-size ramp crosses available memory
  stall           dataloader deadlocks; process stays alive, metrics stop
  silent-degrade  train loss keeps falling while validation quietly diverges;
                  the process never errors, which is the interesting case

Everything is seeded, so step N has the same numbers on every machine.
"""

import argparse
import json
import math
import os
import random
import sys
import time


def emit(stream, obj):
    stream.write(json.dumps(obj) + "\n")
    stream.flush()


def log(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--warmup-steps", type=int, default=100)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--grad-clip", type=float, default=0.0, help="0 disables clipping")
    ap.add_argument("--weight-decay", type=float, default=0.0)
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--fail-mode", default="healthy")
    ap.add_argument("--metrics-path", default=os.environ.get("HANDLER_METRICS_PATH", "metrics.jsonl"))
    ap.add_argument("--step-seconds", type=float, default=0.05)
    args = ap.parse_args()

    random.seed(args.seed)

    log(f"trainer: seed={args.seed} lr={args.lr} warmup={args.warmup_steps} "
        f"bs={args.batch_size} grad_clip={args.grad_clip} wd={args.weight_decay}")
    log(f"trainer: fail-mode={args.fail_mode} steps={args.steps}")
    log("trainer: cuda device 0 · 24.0 GiB total")

    metrics = open(args.metrics_path, "a", buffering=1)

    loss = 4.2
    val_loss = 4.3
    mem_gb = 6.0

    # Compounding instability. This is the mechanism behind nan-loss, and it is
    # deliberately a real one rather than "explode at step N": an optimiser step
    # taken at full LR before the model has settled produces a large gradient,
    # the large gradient moves the weights further out, and the next step is
    # worse. Warmup keeps the early LR small enough that it never starts, and
    # gradient clipping caps the feedback even if it does. Either fix alone is
    # enough — which is exactly what makes the diagnosis interesting.
    instability = 1.0

    for step in range(1, args.steps + 1):
        time.sleep(args.step_seconds)

        # Linear warmup then cosine decay. With warmup_steps <= 1 the very first
        # optimiser step already sees the full LR.
        if step <= args.warmup_steps:
            lr = args.lr * (step / max(args.warmup_steps, 1))
        else:
            progress = (step - args.warmup_steps) / max(args.steps - args.warmup_steps, 1)
            lr = args.lr * 0.5 * (1 + math.cos(math.pi * min(progress, 1.0)))

        # The model "settles" over roughly the first 60 steps. A full-size LR
        # applied before it has settled is a shock; warmup is precisely the
        # thing that stops that happening.
        trust = min(1.0, step / 60.0)
        shock = (lr / 3e-4) * (1.0 + 2.0 * (1.0 - trust))

        raw_grad = (0.6 + shock * 1.2) * instability + random.random() * 0.1
        grad_norm = min(raw_grad, args.grad_clip) if args.grad_clip > 0 else raw_grad

        # The feedback loop only closes when the gradient actually applied is
        # large — so clipping breaks it, and warmup stops it ever starting.
        # Either fix alone is sufficient, which is what makes the diagnosis
        # worth doing properly rather than changing five things at once.
        if grad_norm > 2.5:
            instability *= 1.06
        else:
            instability = max(1.0, instability * 0.98)

        decay = math.exp(-step / 90.0)
        loss = 0.35 + 3.85 * decay + (random.random() - 0.5) * 0.05
        loss += max(0.0, grad_norm - 2.0) * 0.05

        if args.fail_mode == "silent-degrade":
            # Train keeps improving; validation turns upward. Nothing raises.
            val_loss = 0.40 + 3.9 * decay + max(0.0, (step - 100) / 90.0) + (random.random() - 0.5) * 0.03
        else:
            val_loss = loss + 0.08 + (random.random() - 0.5) * 0.03

        if args.fail_mode == "oom":
            mem_gb = 6.0 + (step / args.steps) * 20.0 * (args.batch_size / 32.0)
        else:
            mem_gb = 6.0 + (args.batch_size / 32.0) * 1.5 + random.random() * 0.2

        if args.fail_mode == "nan-loss" and grad_norm > 60:
            loss = float("nan")

        row = {
            "step": step,
            "loss": None if isinstance(loss, float) and math.isnan(loss) else round(loss, 4),
            "val_loss": round(val_loss, 4),
            "lr": round(lr, 8),
            "grad_norm": round(grad_norm, 4),
            "mem_gb": round(mem_gb, 3),
            "batch_size": args.batch_size,
            "ts": time.time(),
        }
        emit(metrics, row)

        if step % 20 == 0 or step == 1:
            shown = "nan" if row["loss"] is None else f"{row['loss']:.4f}"
            log(f"step {step:4d} | loss {shown} | val {row['val_loss']:.4f} | "
                f"lr {row['lr']:.2e} | grad_norm {row['grad_norm']:.2f} | mem {row['mem_gb']:.1f}GiB")

        if args.fail_mode == "nan-loss" and row["loss"] is None:
            log("")
            log("Traceback (most recent call last):")
            log('  File "train.py", line 214, in <module>')
            log("    scaler.step(optimizer)")
            log('  File "torch/cuda/amp/grad_scaler.py", line 374, in step')
            log("    raise RuntimeError('Attempting to unscale FP16 gradients that are NaN or Inf.')")
            log("RuntimeError: Attempting to unscale FP16 gradients that are NaN or Inf.")
            metrics.close()
            sys.exit(1)

        if args.fail_mode == "oom" and mem_gb > 23.0:
            log("")
            log("Traceback (most recent call last):")
            log('  File "train.py", line 188, in <module>')
            log("    loss.backward()")
            log("torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.10 GiB "
                f"(GPU 0; 24.00 GiB total capacity; {mem_gb:.2f} GiB already allocated)")
            metrics.close()
            sys.exit(1)

        if args.fail_mode == "stall" and step >= 60:
            log("trainer: waiting on dataloader worker 3 ...")
            # Alive, burning wall-clock, producing nothing. Nothing in the log
            # says "error" — only the absence of new steps does.
            while True:
                time.sleep(5)

    log(f"trainer: finished {args.steps} steps · final loss {loss:.4f} · val {val_loss:.4f}")
    metrics.close()


if __name__ == "__main__":
    main()
