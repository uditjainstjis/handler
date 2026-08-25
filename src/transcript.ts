/**
 * Export what HANDLER did, as something a person can read.
 *
 * An approval gate is only meaningful if someone can go back afterwards and see
 * what was proposed, on what evidence, and who allowed it. The harness has all
 * of that; this turns it into a file you can attach to a postmortem — or hand
 * to a reviewer who wants to check the agent's reasoning rather than take the
 * summary on trust.
 */
import { listSessionEvents } from './trueforge/client.ts';
import { latestIncident, loadRun } from './runs/store.ts';

function fence(body: string, lang = ''): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function truncate(value: unknown, max = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

export async function transcript(runId: string): Promise<string> {
  const run = await loadRun(runId);
  if (!run) throw new Error(`No run ${runId}.`);
  if (!run.sessionId) throw new Error(`Run ${runId} has no session — nothing to transcribe.`);

  const events = await listSessionEvents(run.sessionId);
  const incident = await latestIncident(runId);

  const out: string[] = [
    `# HANDLER transcript — ${run.name}`,
    ``,
    `- **Run** \`${run.id}\` · status \`${run.status}\`${run.exitCode === undefined ? '' : ` · exit ${run.exitCode}`}`,
    `- **Command** \`${run.command.join(' ')}\``,
    `- **Session** \`${run.sessionId}\``,
    incident ? `- **Incident** \`${incident.id}\` · detector \`${incident.detector}\`` : '',
    ``,
  ].filter(Boolean);

  if (incident?.rootCause) {
    out.push(
      `## Finding`,
      ``,
      `**Root cause.** ${incident.rootCause}`,
      ``,
      `**Recommendation.** ${incident.recommendation ?? '—'}`,
      ``,
    );
    const evidence = (incident.evidence as { agent?: string })?.agent;
    if (evidence) out.push(`**Evidence.**`, ``, fence(truncate(evidence)), ``);
  }

  out.push(`## What happened`, ``);

  let approvals = 0;
  let subagents = 0;
  let sandbox = 0;

  for (const event of events) {
    const at = String(event.created_at ?? '').slice(11, 19);
    switch (event.type) {
      case 'mcp.initialize': {
        const servers = (event as { mcp_servers?: Array<{ name: string; transport_type?: string }> }).mcp_servers ?? [];
        out.push(`- \`${at}\` **MCP connected** — ${servers.map(s => `${s.name} (${s.transport_type})`).join(', ')}`);
        break;
      }
      case 'model.message': {
        for (const call of event.tool_calls ?? []) {
          const fn = (call as unknown as { function?: { name: string; arguments?: string } }).function;
          const name = fn?.name ?? call.name;
          if (name === 'create_sub_agent') subagents += 1;
          if (name === 'exec') sandbox += 1;
          out.push(`- \`${at}\` **${name}** ${truncate(fn?.arguments ?? call.arguments, 220).replace(/\n/g, ' ')}`);
        }
        const content = (event as { content?: unknown }).content;
        if (typeof content === 'string' && content.trim()) {
          out.push(``, `> ${truncate(content, 900).split('\n').join('\n> ')}`, ``);
        }
        break;
      }
      case 'tool.approval_required': {
        approvals += 1;
        for (const call of event.tool_calls ?? []) {
          out.push(
            ``,
            `### ⏸ Approval required — \`${call.name}\``,
            ``,
            fence(truncate(call.arguments, 900), 'json'),
            ``,
          );
        }
        break;
      }
      case 'turn.done': {
        const state = (event as { state?: { status?: string; message?: string } }).state;
        if (state?.status && state.status !== 'done') {
          out.push(`- \`${at}\` _turn ended: ${state.status}${state.message ? ` — ${truncate(state.message, 160)}` : ''}_`);
        }
        break;
      }
      default:
        break;
    }
  }

  out.push(
    ``,
    `## Harness features exercised`,
    ``,
    `| feature | evidence |`,
    `|---|---|`,
    `| MCP tools | ${events.some(e => e.type === 'mcp.initialize') ? 'connected over streamable-http' : 'not observed'} |`,
    `| Sandbox | ${sandbox ? `${sandbox} \`exec\` call(s)` : 'not observed'} |`,
    `| Subagents | ${subagents ? `${subagents} spawned` : 'not observed'} |`,
    `| Approval gate | ${approvals ? `${approvals} prompt(s) held for a human` : 'not observed'} |`,
    ``,
  );

  return out.join('\n');
}
