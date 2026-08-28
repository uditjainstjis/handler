/**
 * Every module must at least parse and load.
 *
 * A merge left conflict markers in `src/dashboard/main.ts` and they were
 * committed to `main`. The full suite still passed — 39 green — because no test
 * imports the dashboard, so a file with `<<<<<<< HEAD` in it shipped to a
 * public repo and the first thing a reviewer running `npm run dashboard` would
 * have seen is a syntax error.
 *
 * "The tests pass" is not the same claim as "the code loads". This closes the
 * gap: every entry point gets imported, which is the cheapest possible check
 * and would have caught it instantly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function allSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSources(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SOURCES = allSources(SRC);

test('the source tree is not empty (the walker actually found something)', () => {
  assert.ok(SOURCES.length > 5, `expected several modules, found ${SOURCES.length}`);
});

test('no source file contains a merge conflict marker', () => {
  const offenders = SOURCES.filter(file => {
    const text = readFileSync(file, 'utf8');
    return /^(<{7}|={7}|>{7})/m.test(text);
  });
  assert.deepEqual(
    offenders.map(f => path.relative(SRC, f)),
    [],
    'conflict markers committed to source',
  );
});

test('every module loads', async () => {
  // Entry points start servers or loops when run directly, but importing them
  // only evaluates module scope — the `import.meta.url === argv[1]` guards keep
  // them inert here. That is exactly the surface a syntax error lives on.
  const failures: string[] = [];
  for (const file of SOURCES) {
    try {
      await import(`${file}?importcheck`);
    } catch (error) {
      const message = (error as Error).message;
      // Tolerate ONLY the environmental reasons a module legitimately cannot
      // finish importing on a machine with no credentials and nothing running.
      // Everything else — including a TypeError from a bad top-level
      // expression — is a real defect, and an allow-list is the only way to
      // say that without also swallowing it.
      const environmental =
        /No Alpaca credentials|credentials|ECONNREFUSED|fetch failed|ENOENT/i.test(message);
      if (!environmental) {
        failures.push(`${path.relative(SRC, file)}: ${(error as Error).name}: ${message.split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(failures, [], 'modules that do not parse or resolve');
});
