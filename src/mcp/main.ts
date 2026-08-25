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

const PORT = Number(process.env.HANDLER_MCP_PORT ?? 8811);
// Loopback by default. These tools kill training runs; the wildcard host would
// hand that to anything that can route to this machine.
const HOST = process.env.HANDLER_MCP_HOST ?? '127.0.0.1';
// MCP annotations are metadata TrueForge consults when deciding what to gate.
// They are not enforcement: a client calling this endpoint directly never goes
// near the harness, so kill_run would just run. A shared secret is what stops
// that, and the harness sends it as a static header.
const TOKEN = process.env.HANDLER_MCP_TOKEN ?? '';

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

async function main() {
  await ensureRoot();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, server: 'handler-ops', authenticated: Boolean(TOKEN) }));

  app.use('/mcp', (req, res, next) => {
    if (!TOKEN) return next();
    const presented = req.header('x-handler-token') ?? '';
    // Length-independent compare would be nicer, but the timing signal on a
    // loopback secret is not the threat here; a missing check is.
    if (presented !== TOKEN) {
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

  app.listen(PORT, HOST, () => {
    process.stdout.write(
      `handler-ops MCP listening on http://${HOST}:${PORT}/mcp ` +
        `(${TOKEN ? 'token required' : 'no token — set HANDLER_MCP_TOKEN'})\n`,
    );
  });
}

void main();
