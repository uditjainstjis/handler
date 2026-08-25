/**
 * The shared secret between HANDLER's MCP server and the harness.
 *
 * This has to be identical in three processes started from three terminals
 * (`npm run mcp`, `npm run watch`, the CLI). Making that an environment
 * variable the operator must remember to export three times is a footgun whose
 * failure mode is a 401 buried in a turn error — which is exactly how it
 * failed the first time.
 *
 * So it lives in a file under HANDLER_HOME, generated on first use. Setting
 * HANDLER_MCP_TOKEN still wins, for deployments that manage secrets properly.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.HANDLER_HOME ?? path.join(process.cwd(), '.handler');
const TOKEN_FILE = path.join(ROOT, 'mcp-token');

export function mcpToken(): string {
  const fromEnv = process.env.HANDLER_MCP_TOKEN;
  if (fromEnv) return fromEnv;

  if (existsSync(TOKEN_FILE)) {
    const stored = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (stored) return stored;
  }

  const generated = randomBytes(24).toString('hex');
  mkdirSync(ROOT, { recursive: true });
  // 0600: it is a credential, even if only a loopback one.
  writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
  return generated;
}

export function tokenSource(): string {
  return process.env.HANDLER_MCP_TOKEN ? 'HANDLER_MCP_TOKEN' : TOKEN_FILE;
}
