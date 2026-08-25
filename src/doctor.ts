/**
 * `handler doctor` — tell someone exactly what is missing.
 *
 * HANDLER has four moving parts and a model provider behind them. When it does
 * not work, the failure usually surfaces somewhere far from its cause: a run
 * that never gets diagnosed looks the same whether the harness is down, no
 * model is configured, the MCP server is unreachable, or the provider quota is
 * spent. Each check below names the cause and the exact command that fixes it.
 */
import { listRuns } from './runs/store.ts';
import { isUp, listMcpTools, listModels } from './trueforge/client.ts';
import { MCP_SERVER_NAME } from './trueforge/agent.ts';
import { pullRequestsEnabled } from './mcp/pullRequest.ts';

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  /** Shown only when the check fails. */
  fix?: string;
  /** Shown even when the check passes — for defaults worth stating out loud. */
  hint?: string;
};

const TRUEFORGE = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const MCP_URL = process.env.HANDLER_MCP_URL ?? 'http://localhost:8811/mcp';
const DASHBOARD = `http://localhost:${process.env.HANDLER_DASHBOARD_PORT ?? 8812}`;

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  const harnessUp = await isUp();
  checks.push({
    name: 'TrueForge harness',
    ok: harnessUp,
    detail: harnessUp ? `reachable at ${TRUEFORGE}` : `nothing answering at ${TRUEFORGE}`,
    fix: 'npx @truefoundry/trueforge',
  });

  if (harnessUp) {
    let models: Array<{ name: string }> = [];
    try {
      models = await listModels();
    } catch {
      // Treated as "none configured" below; the harness being up is the check
      // that already passed.
    }
    checks.push({
      name: 'Model provider',
      ok: models.length > 0,
      detail: models.length
        ? `${models.length} model(s): ${models.map(m => m.name).join(', ')}`
        : 'no provider configured — the agent has nothing to think with',
      fix: `open ${TRUEFORGE} → Settings → Models → add a provider key`,
    });

    const wanted = process.env.HANDLER_MODEL;
    if (wanted && models.length) {
      const found = models.some(m => m.name === wanted);
      checks.push({
        name: 'HANDLER_MODEL',
        ok: found,
        detail: found ? `${wanted} is available` : `${wanted} is NOT one of the configured models`,
        fix: `unset HANDLER_MODEL to use ${models[0]?.name}, or configure that provider`,
      });
    }
  }

  const mcpOk = await reachable(MCP_URL.replace(/\/mcp$/, '/healthz'));
  checks.push({
    name: 'handler-ops MCP server',
    ok: mcpOk,
    detail: mcpOk ? `serving at ${MCP_URL}` : `nothing answering at ${MCP_URL}`,
    fix: 'npm run mcp',
  });

  if (harnessUp && mcpOk) {
    let tools: Array<{ name: string }> = [];
    try {
      tools = await listMcpTools(MCP_SERVER_NAME);
    } catch {
      // Not registered yet — the check below says so and names the fix.
    }
    checks.push({
      name: 'MCP registered with the harness',
      ok: tools.length > 0,
      detail: tools.length
        ? `${tools.length} tools discovered by TrueForge`
        : `the harness cannot see "${MCP_SERVER_NAME}"`,
      fix: 'npm run handler -- provision',
    });
  }

  const dashOk = await reachable(`${DASHBOARD}/api/state`);
  checks.push({
    name: 'Operator console',
    ok: dashOk,
    detail: dashOk ? DASHBOARD : `nothing answering at ${DASHBOARD}`,
    fix: 'npm run dashboard',
  });

  const runs = await listRuns();
  checks.push({
    name: 'Runs',
    ok: true,
    detail: runs.length ? `${runs.length} known` : 'none yet',
    hint: runs.length ? undefined : 'start one with: npm run handler -- run baseline',
  });

  // Not a failure — a deliberate default worth stating out loud, because
  // "HANDLER did not open a PR" is otherwise indistinguishable from a bug.
  checks.push({
    name: 'Pull requests',
    ok: true,
    detail: pullRequestsEnabled()
      ? 'ENABLED — HANDLER may push branches and open PRs once you approve'
      : 'disabled (default) — open_fix_pull_request returns the patch without pushing',
    hint: pullRequestsEnabled() ? undefined : 'to enable: HANDLER_ALLOW_PR=1 npm run mcp',
  });

  const width = Math.max(...checks.map(c => c.name.length));
  for (const check of checks) {
    console.log(`${check.ok ? '  ok  ' : ' FAIL '} ${check.name.padEnd(width)}  ${check.detail}`);
    const trailer = check.ok ? check.hint : `fix: ${check.fix ?? 'no automatic fix'}`;
    if (trailer) console.log(`${' '.repeat(width + 8)}${trailer}`);
  }

  const failed = checks.filter(c => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) failing.` : '\nAll good.');
  return failed === 0 ? 0 : 1;
}
