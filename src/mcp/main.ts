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

  app.get('/healthz', (_req, res) => res.json({ ok: true, server: 'handler-ops' }));

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

  app.listen(PORT, () => {
    process.stdout.write(`handler-ops MCP listening on http://localhost:${PORT}/mcp\n`);
  });
}

void main();
