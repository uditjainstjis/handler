/**
 * A small typed client over the TrueForge HTTP API.
 *
 * Only the parts HANDLER needs: register the MCP server, upsert the agent,
 * create or resume a session, drive turns, and answer approval prompts.
 */
const BASE = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const API = `${BASE}/api/v1`;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TrueForge ${init?.method ?? 'GET'} ${path} -> ${response.status}: ${body.slice(0, 400)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function isUp(): Promise<boolean> {
  try {
    await call('/capabilities');
    return true;
  } catch {
    return false;
  }
}

export async function listModels(): Promise<Array<{ name: string }>> {
  const out = await call<{ data: Array<{ name: string }> }>('/models');
  return out.data ?? [];
}

export type McpServerManifest = {
  type: 'remote';
  name: string;
  url: string;
  description: string;
};

export async function upsertMcpServer(manifest: McpServerManifest): Promise<void> {
  const existing = await call<{ data: Array<{ manifest: { name: string } }> }>('/settings/mcp-servers');
  const already = (existing.data ?? []).some(entry => entry.manifest?.name === manifest.name);
  await call(`/settings/mcp-servers`, {
    method: already ? 'PUT' : 'POST',
    body: JSON.stringify({ manifest }),
  });
}

export async function listMcpTools(name: string): Promise<Array<{ name: string }>> {
  const out = await call<{ data: Array<{ name: string }> }>(`/mcp-servers/${name}/tools`);
  return out.data ?? [];
}

export type AgentSpec = Record<string, unknown>;

export async function upsertAgent(name: string, manifest: AgentSpec): Promise<{ id: string; name: string }> {
  const existing = await call<{ data: Array<{ id: string; name: string }> }>('/agents');
  const found = (existing.data ?? []).find(agent => agent.name === name);
  if (found) {
    // UpdateAgentRequest takes the manifest only — the name is in the path and
    // sending it again is rejected as an unrecognized key.
    await call(`/agents/${found.id}`, { method: 'PUT', body: JSON.stringify({ manifest }) });
    return found;
  }
  const created = await call<{ data: { id: string; name: string } }>('/agents', {
    method: 'POST',
    body: JSON.stringify({ name, manifest }),
  });
  return created.data ?? (created as unknown as { id: string; name: string });
}

export async function createSession(agentName: string): Promise<string> {
  const out = await call<{ data: { id: string } }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: { name: agentName } }),
  });
  const id = out.data?.id ?? (out as unknown as { id: string }).id;
  if (!id) throw new Error('TrueForge returned a session with no id');
  return id;
}

export async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    await call(`/sessions/${sessionId}`);
    return true;
  } catch {
    return false;
  }
}

export type TurnInputItem =
  | { type: 'user.message'; content: string }
  | {
      type: 'user.tool_approval';
      thread_id: string;
      tool_call_id: string;
      approval: { status: 'allow' } | { status: 'deny'; reason?: string };
    };

/**
 * Posts a turn without streaming. HANDLER reads events back separately, which
 * keeps the poster non-blocking — a watcher must never sit on an open SSE
 * stream waiting for an approval that may take a human minutes to give.
 */
export async function postTurn(sessionId: string, input: TurnInputItem[]): Promise<{ id: string }> {
  const out = await call<{ data: { id: string } }>(`/sessions/${sessionId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ input, stream: false }),
  });
  return out.data ?? (out as unknown as { id: string });
}

export type SessionEvent = {
  id: string;
  type: string;
  created_at: string;
  thread_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments?: unknown }>;
  [key: string]: unknown;
};

export async function listSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const out = await call<{ data: SessionEvent[] }>(`/sessions/${sessionId}/events`);
  return out.data ?? [];
}

export async function listTurns(sessionId: string): Promise<Array<{ id: string; state?: { status?: string } }>> {
  const out = await call<{ data: Array<{ id: string; state?: { status?: string } }> }>(
    `/sessions/${sessionId}/turns`,
  );
  return out.data ?? [];
}

/** Approval prompts the harness is currently blocked on, newest last. */
export async function pendingApprovals(sessionId: string): Promise<
  Array<{ threadId: string; toolCallId: string; name: string; arguments: unknown; at: string }>
> {
  const events = await listSessionEvents(sessionId);
  const pending = new Map<string, { threadId: string; toolCallId: string; name: string; arguments: unknown; at: string }>();
  for (const event of events) {
    if (event.type === 'tool.approval_required') {
      for (const call of event.tool_calls ?? []) {
        pending.set(call.id, {
          threadId: event.thread_id ?? '',
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
          at: event.created_at,
        });
      }
    }
    // Once a call actually ran or was rejected it is no longer pending.
    if (event.type === 'tool.result' || event.type === 'tool.rejected') {
      const id = (event as { tool_call_id?: string }).tool_call_id;
      if (id) pending.delete(id);
    }
  }
  return [...pending.values()];
}

export async function decideApproval(
  sessionId: string,
  threadId: string,
  toolCallId: string,
  decision: { status: 'allow' } | { status: 'deny'; reason?: string },
): Promise<void> {
  await postTurn(sessionId, [
    { type: 'user.tool_approval', thread_id: threadId, tool_call_id: toolCallId, approval: decision },
  ]);
}

export function chatUrlFor(sessionId: string): string {
  return `${BASE}/?session=${sessionId}`;
}
