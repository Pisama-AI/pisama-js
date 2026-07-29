// Pisama MCP server. Runs over stdio. Hand it a project ID via
// --project-id or PISAMA_PROJECT_ID and it exposes three tools:
//
//   get_recent_failures   list the most recent traces that fired any detector
//   get_recent_traces     list the most recent traces (with or without hits)
//   get_trace             fetch one specific trace by traceId
//
// Wire it into any MCP-compatible AI assistant's server config and the
// AI can answer "what did my agent break this morning?" against real data.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_BASE = 'https://api.pisama.ai';

interface ToolCallArgs {
  limit?: number;
  traceId?: string;
}

interface TraceEvent {
  traceId: string;
  spanId: string;
  startTime: number;
  endTime: number;
  model: string;
  prompt?: string;
  completion?: string;
  toolCalls: { toolCallId: string; toolName: string }[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  finishReason?: string;
  metadata: Record<string, unknown>;
}

interface DetectionResult {
  detector: string;
  detected: boolean;
  severity: number;
  summary: string;
  fix?: string;
  evidence?: Record<string, unknown>;
}

interface TraceWithHits {
  event: TraceEvent;
  hits: DetectionResult[];
}

interface TracesResponse {
  projectId: string;
  count: number;
  events: TraceWithHits[];
}

export interface McpOptions {
  projectId: string;
  serverVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function startMcpServer(opts: McpOptions): Promise<void> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const projectId = opts.projectId;

  const server = new Server(
    { name: 'pisama', version: opts.serverVersion },
    {
      // Advertise both tools and prompts. `listChanged:false` tells clients we
      // don't push updates when the menu changes (we don't have a use case for
      // dynamic prompts yet) but the primitive itself is supported.
      capabilities: {
        tools: {},
        prompts: { listChanged: false },
      },
    },
  );

  // MCP 2025-06-18 ergonomics:
  //   - title              human-friendly label
  //   - outputSchema       JSON Schema for structuredContent
  //   - annotations        readOnly/destructive/idempotent/openWorld hints
  // All three Pisama tools are pure reads against the public API, so we mark
  // them readOnlyHint: true, destructiveHint: false, idempotentHint: true.
  // openWorldHint: true because we call out to api.pisama.ai (a remote service
  // that can return new traces between calls).
  const traceListSchema = {
    type: 'object' as const,
    properties: {
      projectId: { type: 'string' },
      count: { type: 'number' },
      events: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    additionalProperties: true,
  };

  const singleTraceSchema = {
    type: 'object' as const,
    properties: {
      event: { type: 'object', additionalProperties: true },
      hits: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
      },
    },
    additionalProperties: true,
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_recent_failures',
        title: 'Get Recent Failures',
        description:
          "List recent traces that fired at least one detector (loop, hallucination, cost spike, etc.). Use this when the user asks 'what's broken' or 'what failed today'.",
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max number of failures to return (default 20, max 200).',
              default: 20,
            },
          },
        },
        outputSchema: traceListSchema,
        annotations: {
          title: 'Get Recent Failures',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_recent_traces',
        title: 'Get Recent Traces',
        description:
          'List the most recent traces, regardless of whether they fired a detector. Use this when the user wants to see overall activity.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Max number of traces to return (default 20, max 200).',
              default: 20,
            },
          },
        },
        outputSchema: traceListSchema,
        annotations: {
          title: 'Get Recent Traces',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'get_trace',
        title: 'Get Trace',
        description:
          'Fetch one specific trace by its traceId. Returns full prompt, completion, tool calls, and any detector hits.',
        inputSchema: {
          type: 'object',
          properties: {
            traceId: {
              type: 'string',
              description: 'The traceId, returned from list tools.',
            },
          },
          required: ['traceId'],
        },
        outputSchema: singleTraceSchema,
        annotations: {
          title: 'Get Trace',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ],
  }));

  // MCP 2025-06-18 prompts primitive. Same four slash commands the Python
  // backend ships, so Claude Code / Cursor / Continue users get a consistent
  // menu regardless of which Pisama server they're connected to. The body
  // strings reference the actual TS-server tool names (get_recent_failures,
  // get_recent_traces, get_trace).
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return buildPromptMessages(name, args ?? {});
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as ToolCallArgs;

    try {
      switch (request.params.name) {
        case 'get_recent_failures': {
          const limit = clampLimit(args.limit, 20);
          const data = await fetchTraces(fetchImpl, baseUrl, projectId, {
            limit,
            onlyFailures: true,
          });
          return {
            content: [{ type: 'text', text: formatList(data, true) }],
            structuredContent: data as unknown as Record<string, unknown>,
            isError: false,
          };
        }
        case 'get_recent_traces': {
          const limit = clampLimit(args.limit, 20);
          const data = await fetchTraces(fetchImpl, baseUrl, projectId, {
            limit,
            onlyFailures: false,
          });
          return {
            content: [{ type: 'text', text: formatList(data, false) }],
            structuredContent: data as unknown as Record<string, unknown>,
            isError: false,
          };
        }
        case 'get_trace': {
          const traceId = args.traceId;
          if (!traceId) {
            return buildErrorResult('validation_error', 'traceId is required');
          }
          const data = await fetchTraces(fetchImpl, baseUrl, projectId, {
            limit: 200,
            onlyFailures: false,
          });
          const match = data.events.find((e) => e.event.traceId === traceId);
          if (!match) {
            return buildErrorResult(
              'not_found',
              `no trace ${traceId} in the recent buffer (max 200). It may have aged out.`,
              { traceId },
            );
          }
          return {
            content: [{ type: 'text', text: formatTrace(match) }],
            structuredContent: match as unknown as Record<string, unknown>,
            isError: false,
          };
        }
        default:
          return buildErrorResult('unknown_tool', `unknown tool ${request.params.name}`, {
            name: request.params.name,
          });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildErrorResult('upstream_error', message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function clampLimit(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

async function fetchTraces(
  fetchImpl: typeof fetch,
  baseUrl: string,
  projectId: string,
  opts: { limit: number; onlyFailures: boolean },
): Promise<TracesResponse> {
  // Anonymous shared-secret read endpoint. The project_id in the URL IS the
  // auth — the backend resolves it to the owning tenant (claimed or not) and
  // returns recent traces. See ~/pisama/backend/app/api/v1/projects.py.
  // Filtering by `only=failures` is done client-side after the response
  // since this endpoint doesn't accept it (yet).
  const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/traces`, baseUrl);
  url.searchParams.set('limit', String(opts.limit));
  const res = await fetchImpl(url.toString(), {
    headers: { 'x-pisama-project-id': projectId },
  });
  if (res.status === 404) {
    throw new Error(
      `pisama ${baseUrl} returned 404 from /api/v1/projects/${projectId}/traces. ` +
        'This CLI version targets the authenticated tenant-scoped API — the anonymous ' +
        'project-id-only flow is no longer served. Pass --api-key (or set PISAMA_API_KEY) ' +
        'to use the authenticated contract.',
    );
  }
  if (!res.ok) {
    throw new Error(`pisama ${baseUrl} returned ${res.status}`);
  }
  const raw = (await res.json()) as AnonymousTracesResponse;
  return adaptAnonymousResponse(projectId, raw, opts.onlyFailures);
}

interface AnonymousTrace {
  trace_id: string;
  session_id?: string | null;
  framework?: string | null;
  status?: string | null;
  detection_status?: string | null;
  total_tokens?: number | null;
  created_at?: string | null;
  completed_at?: string | null;
  detections: AnonymousDetection[];
}

interface AnonymousDetection {
  type?: string | null;
  confidence?: number | null;
  details?: unknown;
  created_at?: string | null;
}

interface AnonymousTracesResponse {
  traces: AnonymousTrace[];
}

function adaptAnonymousResponse(
  projectId: string,
  raw: AnonymousTracesResponse,
  onlyFailures: boolean,
): TracesResponse {
  const traces = raw.traces ?? [];
  let events: TraceWithHits[] = traces.map((t) => {
    const createdAtMs = t.created_at ? Date.parse(t.created_at) : 0;
    const completedAtMs = t.completed_at ? Date.parse(t.completed_at) : createdAtMs;
    const hits: DetectionResult[] = (t.detections ?? []).map((d) => ({
      detector: d.type ?? 'unknown',
      detected: true,
      severity:
        typeof d.confidence === 'number'
          ? Math.max(0, Math.min(10, Math.round(d.confidence * 10)))
          : 5,
      summary:
        typeof d.details === 'string'
          ? d.details
          : d.details
            ? JSON.stringify(d.details).slice(0, 400)
            : `${d.type ?? 'unknown'} detection`,
    }));
    const event: TraceEvent = {
      traceId: t.trace_id,
      // Anonymous endpoint doesn't expose span ids; reuse traceId so the
      // formatter has a non-empty string. Cursor/Claude Code never use this
      // field directly, they pass the traceId back into get_trace.
      spanId: t.trace_id,
      startTime: createdAtMs,
      endTime: completedAtMs,
      model: t.framework ?? '?',
      toolCalls: [],
      inputTokens: undefined,
      outputTokens: t.total_tokens ?? undefined,
      finishReason: t.status ?? undefined,
      metadata: { sessionId: t.session_id ?? undefined },
    };
    return { event, hits };
  });
  if (onlyFailures) {
    events = events.filter((e) => e.hits.length > 0);
  }
  return { projectId, count: events.length, events };
}

function formatList(data: TracesResponse, failuresOnly: boolean): string {
  if (data.events.length === 0) {
    return failuresOnly
      ? `no failures in the last 200 traces for ${data.projectId}.`
      : `no traces for ${data.projectId} yet.`;
  }
  const lines = data.events.map((e) => {
    const ago = relativeTime(e.event.startTime);
    const tokens = (e.event.inputTokens ?? 0) + (e.event.outputTokens ?? 0) || '—';
    const hits =
      e.hits.length === 0 ? '(clean)' : e.hits.map((h) => `${h.detector}/${h.severity}`).join(',');
    return `- ${e.event.traceId.slice(0, 8)} ${ago} ${e.event.model} ${tokens}t ${hits}`;
  });
  const header = failuresOnly
    ? `${data.events.length} recent failure(s) for ${data.projectId}:`
    : `${data.events.length} recent trace(s) for ${data.projectId}:`;
  return `${header}\n${lines.join('\n')}`;
}

function formatTrace(t: TraceWithHits): string {
  const out: string[] = [];
  out.push(`traceId: ${t.event.traceId}`);
  out.push(`when: ${new Date(t.event.startTime).toISOString()}`);
  out.push(`model: ${t.event.model}`);
  out.push(
    `tokens: in=${t.event.inputTokens ?? '?'} out=${t.event.outputTokens ?? '?'} cost=$${t.event.costUsd ?? '?'}`,
  );
  out.push(`finishReason: ${t.event.finishReason ?? '?'}`);
  if (t.event.prompt) {
    out.push(`\nprompt:\n${truncate(t.event.prompt, 1000)}`);
  }
  if (t.event.completion) {
    out.push(`\ncompletion:\n${truncate(t.event.completion, 1000)}`);
  }
  if (t.event.toolCalls.length > 0) {
    out.push(`\ntool calls (${t.event.toolCalls.length}):`);
    for (const tc of t.event.toolCalls) {
      out.push(`  - ${tc.toolName} (${tc.toolCallId})`);
    }
  }
  if (t.hits.length > 0) {
    out.push(`\ndetector hits:`);
    for (const h of t.hits) {
      out.push(`  - ${h.detector} (severity ${h.severity}): ${h.summary}`);
      if (h.fix) out.push(`    fix: ${h.fix}`);
    }
  }
  return out.join('\n');
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// MCP 2025-06-18: tool-execution errors return isError:true with the
// human-readable message in `content` and a parseable error payload in
// `structuredContent`. Clients can detect failures programmatically without
// regexing the text body.
function buildErrorResult(
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {
      error: detail ? { code, message, detail } : { code, message },
    },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Prompts (MCP 2025-06-18 prompts primitive)
//
// Slash-command shortcuts a client (Claude Code, Cursor, Continue) can offer
// the user to chain Pisama tool calls without writing the orchestration prose.
// Names + arg shape mirror the Python backend so a user gets the same menu
// regardless of which Pisama server is wired in.
// ---------------------------------------------------------------------------

export interface PromptArgumentDef {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgumentDef[];
}

export const PROMPTS: PromptDef[] = [
  {
    name: 'investigate_recent_failures',
    title: 'Investigate recent failures',
    description: 'Group recent failures by detector and recommend the top fix.',
    arguments: [
      {
        name: 'lookback_hours',
        description: 'How far back to scan, in hours. Defaults to 24.',
        required: false,
      },
      {
        name: 'framework',
        description:
          'Optional framework filter (langgraph, crewai, n8n, openclaw, autogen, claude-code).',
        required: false,
      },
    ],
  },
  {
    name: 'explain_trace',
    title: 'Explain trace',
    description: 'Walk a single trace and explain what went wrong in plain English.',
    arguments: [
      {
        name: 'trace_id',
        description: 'ID of the trace to explain.',
        required: true,
      },
    ],
  },
  {
    name: 'propose_fix',
    title: 'Propose fix',
    description:
      'Surface the fix Pisama recommended for a failure and weigh trade-offs before recommending apply or refine.',
    arguments: [
      {
        name: 'failure_id',
        description: 'ID of the failing trace (use the traceId from get_recent_failures).',
        required: true,
      },
    ],
  },
  {
    name: 'daily_quality_report',
    title: 'Daily quality report',
    description: 'Summarize the last 24 hours of Pisama activity for a morning standup.',
    arguments: [
      {
        name: 'tenant',
        description:
          'Optional tenant identifier override. Defaults to the project the server is bound to.',
        required: false,
      },
    ],
  },
];

interface GetPromptResponse {
  description: string;
  messages: {
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
  }[];
  // Index signature so the value satisfies the SDK's `ServerResult` upper bound.
  [k: string]: unknown;
}

export function buildPromptMessages(name: string, args: Record<string, string>): GetPromptResponse {
  if (name === 'investigate_recent_failures') {
    const lookback = args.lookback_hours ?? '24';
    const framework = args.framework;
    const frameworkClause = framework
      ? ` Restrict your interpretation to traces from framework "${framework}".`
      : '';
    const body =
      `Investigate Pisama failures from the last ${lookback} hours.${frameworkClause}\n\n` +
      'Steps:\n' +
      '1. Call `get_recent_failures` with a generous limit (50 or 100) to pull recent detector hits.\n' +
      `2. Filter the returned list to events from the last ${lookback} hours.\n` +
      '3. Group hits by detector name. Count occurrences and surface the top three patterns.\n' +
      '4. For the top pattern, call `get_trace` on a representative traceId and read the `fix` field on the detector hit.\n' +
      '5. Reply with: total failures in the window, top three detector patterns with counts, and one recommended action.';
    return {
      description: 'Recent-failures investigation runbook.',
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  }

  if (name === 'explain_trace') {
    const traceId = args.trace_id;
    if (!traceId) {
      throw new Error('trace_id is required');
    }
    const body =
      `Explain Pisama trace ${traceId} in plain English.\n\n` +
      'Steps:\n' +
      `1. Call \`get_trace\` with \`traceId="${traceId}"\`.\n` +
      '2. Walk the prompt, completion, and tool calls in order. Note what the agent attempted at each step.\n' +
      '3. Read the `detector hits` block. For each hit, note the detector name, severity, and summary.\n' +
      '4. Reply with a short narrative: what the agent tried to do, where it failed, and which Pisama detector caught it.';
    return {
      description: 'Plain-English explanation of a single trace.',
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  }

  if (name === 'propose_fix') {
    const failureId = args.failure_id;
    if (!failureId) {
      throw new Error('failure_id is required');
    }
    const body =
      `Evaluate Pisama's proposed fix for failure ${failureId}.\n\n` +
      'Steps:\n' +
      '1. Call `get_recent_failures` with a generous limit to locate the failure in the buffer.\n' +
      `2. Call \`get_trace\` with \`traceId="${failureId}"\` to load the prompt, completion, and detector hits.\n` +
      '3. For each detector hit on the trace, read the `fix` field Pisama produced. Compare the top two candidate fixes.\n' +
      '4. List the trade-offs: blast radius, rollback cost, whether the fix patches the symptom or the root cause.\n' +
      "5. Recommend one of three actions: apply the fix, refine it (state what's missing), or skip (explain why).";
    return {
      description: 'Fix-evaluation runbook for a single failure.',
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  }

  if (name === 'daily_quality_report') {
    const tenant = args.tenant;
    const tenantClause = tenant ? ` Use tenant "${tenant}".` : '';
    const body =
      `Build a Pisama daily quality report for the last 24 hours.${tenantClause}\n\n` +
      'Steps:\n' +
      '1. Call `get_recent_traces` with limit 200 to count overall detection volume.\n' +
      '2. Call `get_recent_failures` with limit 200. Filter both lists to events from the last 24 hours.\n' +
      '3. Group failures by detector. Surface the top three issues by count.\n' +
      '4. Compute healing-success rate: count traces where any detector hit has a non-empty `fix` field versus total failures.\n' +
      '5. Reply with four sections: Volume, Top three issues, Healing-success rate, One action for the day. Keep it under 200 words for a morning standup.';
    return {
      description: 'Morning-standup quality summary.',
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}
