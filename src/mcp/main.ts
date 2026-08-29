import { pathToFileURL } from 'node:url';
/**
 * HANDLER Ops MCP server, over streamable HTTP.
 *
 * TrueForge only registers `remote` MCP servers (its `MCPServerType` enum has a
 * single member), so a stdio server would be unusable here — this speaks HTTP.
 *
 * Stateless: a fresh transport per request. There is no cross-request state to
 * protect, and it means the harness can reconnect at any time without a
 * handshake dance, which matters because the whole point of HANDLER is that
 * things restart underneath it.
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { registerTools } from './tools.ts';
import { ensureRoot } from '../runs/store.ts';
import { mcpToken, tokenSource } from '../runs/token.ts';

const PORT = Number(process.env.HANDLER_MCP_PORT ?? 8811);
// Loopback by default. These tools kill training runs; the wildcard host would
// hand that to anything that can route to this machine.
const HOST = process.env.HANDLER_MCP_HOST ?? '127.0.0.1';
// MCP annotations are metadata TrueForge consults when deciding what to gate.
// They are not enforcement: a client calling this endpoint directly never goes
// near the harness, so kill_run would just run. A shared secret is what stops
// that, and the harness sends it as a static header.
// Resolved lazily. At module scope this wrote a token file as a side effect of
// merely importing the module — which a test that imports every module then
// performs on someone's machine. A credential should be created when the
// server starts, not when the file is read.
let cachedToken: string | undefined;
const token = (): string => (cachedToken ??= mcpToken());

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'handler-ops', version: '0.1.0' },
    {
      instructions:
        'Operational access to training runs: read their telemetry, and — behind a human approval gate — kill, relaunch, or page a human about them.',
    },
  );
  registerTools(server);
  return server;
}

/**
 * Build the HTTP app without binding a port.
 *
 * Split out from `main` so a test can exercise the routes. The refactor is not
 * cosmetic: a stale reference in the healthz handler once made every request
 * throw while the process still started cleanly and printed its banner, and
 * nothing could catch it without being able to send a request.
 */
export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, server: 'handler-ops', authenticated: Boolean(token()) }));

  app.use('/mcp', (req, res, next) => {
    // Fail closed. An empty token must never mean "let everyone in" — these
    // tools kill training runs, and a misconfiguration should stop the server
    // being useful, not stop it being safe.
    const presented = req.header('x-handler-token') ?? '';
    // Length-independent compare would be nicer, but the timing signal on a
    // loopback secret is not the threat here; a missing check is.
    if (presented !== token()) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: x-handler-token missing or wrong.' },
        id: null,
      });
      return;
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Tie the per-request server and transport to the response lifetime so a
    // dropped client cannot leak either.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: (error as Error).message },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no stream to resume and no session to delete.
  const notAllowed = (_req: express.Request, res: express.Response) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
      id: null,
    });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return app;
}

async function main() {
  await ensureRoot();

  if (!token()) {
    process.stderr.write('Refusing to start without an MCP token — that would serve kill_run to anyone.\n');
    process.exit(1);
  }

  const app = buildApp();
  app.listen(PORT, HOST, () => {
    process.stdout.write(
      `handler-ops MCP listening on http://${HOST}:${PORT}/mcp ` +
        `(token required, from ${tokenSource()})\n`,
    );
  });
}

// Only run when executed directly. Importing this module — a test, a tool,
// another entry point — must not start a server or a trading loop.
// pathToFileURL, not string concatenation: argv[1] containing a space, a
// symlink, or a Windows drive letter never equals `file://` + the raw path,
// and the entry point would silently refuse to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
