/**
 * Training configs as files in the repo.
 *
 * This is the detail that makes the loop close. A run is launched *from* a
 * checked-in config, so the fix HANDLER proposes is a diff against a real file
 * that a human reviews and merges — not a suggestion in a chat log that someone
 * has to retype at 3am and probably won't.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = process.env.HANDLER_REPO ?? path.resolve(HERE, '..', '..');
export const CONFIG_DIR = path.join(REPO_ROOT, 'fixtures', 'configs');
const TRAINER = path.join(REPO_ROOT, 'fixtures', 'trainer.py');

export type TrainingConfig = {
  name: string;
  description?: string;
  fail_mode: string;
  steps: number;
  lr: number;
  warmup_steps: number;
  grad_clip: number;
  batch_size: number;
  weight_decay: number;
  seed: number;
  budget_usd?: number;
};

export function configPath(configName: string): string {
  const bare = configName.endsWith('.json') ? configName : `${configName}.json`;
  const target = path.resolve(CONFIG_DIR, bare);
  if (!target.startsWith(CONFIG_DIR + path.sep)) {
    throw new Error('config name escapes the config directory');
  }
  return target;
}

export async function loadConfig(configName: string): Promise<TrainingConfig> {
  const file = configPath(configName);
  if (!existsSync(file)) throw new Error(`no config named ${configName}`);
  return JSON.parse(await readFile(file, 'utf8')) as TrainingConfig;
}

export async function listConfigs(): Promise<string[]> {
  if (!existsSync(CONFIG_DIR)) return [];
  return (await readdir(CONFIG_DIR)).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

/** The one place config keys become command-line flags. */
export function commandFor(config: TrainingConfig, stepSeconds: number): string[] {
  return [
    process.env.HANDLER_PYTHON ?? 'python3',
    TRAINER,
    '--fail-mode', String(config.fail_mode),
    '--steps', String(config.steps),
    '--lr', String(config.lr),
    '--warmup-steps', String(config.warmup_steps),
    '--grad-clip', String(config.grad_clip),
    '--batch-size', String(config.batch_size),
    '--weight-decay', String(config.weight_decay),
    '--seed', String(config.seed),
    '--step-seconds', String(stepSeconds),
  ];
}

/** Only the knobs a fix is allowed to touch. Everything else needs a human. */
export const PATCHABLE_KEYS = [
  'lr',
  'warmup_steps',
  'grad_clip',
  'batch_size',
  'weight_decay',
  'steps',
] as const;

export type PatchableKey = (typeof PATCHABLE_KEYS)[number];

export function applyConfigChanges(
  config: TrainingConfig,
  changes: Record<string, number>,
): { next: TrainingConfig; rejected: string[] } {
  const next = { ...config };
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!(PATCHABLE_KEYS as readonly string[]).includes(key)) {
      rejected.push(key);
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }
  return { next, rejected };
}
