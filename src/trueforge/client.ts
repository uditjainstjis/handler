/**
 * A small typed client over the TrueForge HTTP API.
 *
 * Only the parts HANDLER needs: register the MCP server, upsert the agent,
 * create or resume a session, drive turns, and answer approval prompts.
 */
/**
 * Read the base URL per call rather than capturing it at import time. Module
 * scope freezes whatever the environment happened to be when the first import
 * ran, which makes the client untestable against a stub and silently ignores
 * anything that sets TRUEFORGE_URL later.
 */
function base(): string {
  return process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base()}/api/v1${path}`, {
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
  auth?: { type: 'header'; headers: Record<string, string> };
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
  // Each element is a { turn_id, event } envelope, not a bare event. Reading
  // `.type` off the envelope silently yields undefined, which makes every
  // event-type filter match nothing — approvals included.
  const out = await call<{ data: Array<{ turn_id?: string; event: SessionEvent }> }>(
    `/sessions/${sessionId}/events`,
  );
  return (out.data ?? [])
    .map(entry => (entry?.event ? { ...entry.event, turn_id: entry.turn_id } : (entry as unknown as SessionEvent)))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

export async function listTurns(sessionId: string): Promise<Array<{ id: string; state?: { status?: string } }>> {
  const out = await call<{ data: Array<{ id: string; state?: { status?: string } }> }>(
    `/sessions/${sessionId}/turns`,
  );
  return out.data ?? [];
}

type ModelToolCall = {
  id: string;
  name?: string;
  arguments?: unknown;
  function?: { name?: string; arguments?: string };
};

/** Tool calls carry their name and arguments nested under `function`. */
function describeCall(call: ModelToolCall): { name: string; arguments: unknown } {
  const name = call.function?.name ?? call.name ?? 'unknown tool';
  const raw = call.function?.arguments ?? call.arguments;
  if (typeof raw !== 'string') return { name, arguments: raw };
  try {
    return { name, arguments: JSON.parse(raw) };
  } catch {
    return { name, arguments: raw };
  }
}

/**
 * Approval prompts the harness is currently blocked on, newest last.
 *
 * `tool.approval_required` carries only `{ id, source_event_id }` per call —
 * no name, no arguments. Those live on the `model.message` event that
 * requested the call, which `source_event_id` points at. Reading `.name`
 * straight off the ref yields undefined, and an approval card that says
 * "undefined" is worse than no card: the whole point is that a human can see
 * what they are being asked to allow.
 */
export async function pendingApprovals(sessionId: string): Promise<
  Array<{ threadId: string; toolCallId: string; name: string; arguments: unknown; at: string }>
> {
  const events = await listSessionEvents(sessionId);

  const byEventId = new Map<string, SessionEvent>();
  for (const event of events) if (event.id) byEventId.set(event.id, event);

  const pending = new Map<string, { threadId: string; toolCallId: string; name: string; arguments: unknown; at: string }>();
  for (const event of events) {
    if (event.type === 'tool.approval_required') {
      for (const ref of (event.tool_calls ?? []) as Array<{ id: string; source_event_id?: string }>) {
        const source = ref.source_event_id ? byEventId.get(ref.source_event_id) : undefined;
        const call =
          ((source?.tool_calls ?? []) as ModelToolCall[]).find(c => c.id === ref.id) ??
          (ref as unknown as ModelToolCall);
        const { name, arguments: args } = describeCall(call);
        pending.set(ref.id, {
          threadId: event.thread_id ?? '',
          toolCallId: ref.id,
          name,
          arguments: args,
          at: event.created_at,
        });
      }
    }
    // Once the call has produced a response it is no longer pending, whether
    // it was allowed and ran or denied and reported back. `tool.response` is
    // the only event that carries that — there is no `tool.result` or
    // `tool.rejected` in the schema, and filtering on names that do not exist
    // means an answered approval never leaves the queue.
    if (event.type === 'tool.response') {
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
  return `${base()}/?session=${sessionId}`;
}
