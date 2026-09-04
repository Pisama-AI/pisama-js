// Pisama MCP server. Runs over stdio. Hand it a Pisama API key via
// --api-key or PISAMA_API_KEY and it exposes three read-only tools:
//
//   get_recent_failures   list the most recent traces that fired any detector
//   get_recent_traces     list the most recent traces (with or without hits)
//   get_trace             fetch one specific trace by traceId
//
// Wire it into any MCP-compatible AI assistant's server config and the
// AI can answer "what did my agent break this morning?" against real,
// authenticated tenant data. Raw API keys are only sent to /auth/token; all
// trace and detection reads use a read-scoped JWT.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { PlatformAuth, PlatformAuthError } from './platform-auth.js';

const DEFAULT_BASE = 'https://api.pisama.ai';

interface ToolCallArgs {
  limit?: number;
  traceId?: string;
}

interface TraceEvent {
  traceId: string;
  spanId?: string;
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
  tenantId: string;
  count: number;
  events: TraceWithHits[];
}

export interface McpOptions {
  apiKey: string;
  serverVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function startMcpServer(opts: McpOptions): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const auth = new PlatformAuth(baseUrl, opts.apiKey, fetchImpl);
  let tenantIdentity: Promise<string> | undefined;
  const getTenantId = (): Promise<string> => {
    tenantIdentity ??= auth.identity('read').then((claims) => claims.tenantId);
    return tenantIdentity.catch((error) => {
      tenantIdentity = undefined;
      throw error;
    });
  };

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
  // All three Pisama tools are pure reads against the authenticated API, so we mark
  // them readOnlyHint: true, destructiveHint: false, idempotentHint: true.
  // openWorldHint: true because we call out to api.pisama.ai (a remote service
  // that can return new traces between calls).
  const traceListSchema = {
    type: 'object' as const,
    properties: {
      tenantId: { type: 'string' },
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
          'Fetch one trace by traceId. Returns available prompt and completion text, state metadata, and detector hits.',
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
          const data = await fetchRecentTraces(auth, baseUrl, await getTenantId(), {
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
          const data = await fetchRecentTraces(auth, baseUrl, await getTenantId(), {
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
          const match = await fetchTrace(auth, baseUrl, await getTenantId(), traceId);
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
      const code =
        err instanceof PlatformAuthError
          ? 'auth_error'
          : err instanceof PlatformResponseError && [401, 403].includes(err.status)
            ? 'auth_error'
            : err instanceof PlatformResponseError && err.status === 404
              ? 'not_found'
              : 'upstream_error';
      return buildErrorResult(code, message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function clampLimit(n: number | undefined, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 200);
}

interface PlatformTrace {
  id: string;
  session_id?: string | null;
  framework?: string | null;
  status?: string | null;
  detection_status?: string | null;
  total_tokens?: number | null;
  total_cost_cents?: number | null;
  created_at?: string | null;
  completed_at?: string | null;
  state_count?: number | null;
  detection_count?: number | null;
  detection_metadata?: Record<string, unknown> | null;
}

interface PlatformState {
  id: string;
  sequence_num: number;
  agent_id?: string | null;
  state_delta?: Record<string, unknown> | null;
  response_redacted?: string | null;
  token_count?: number | null;
  latency_ms?: number | null;
  created_at?: string | null;
}

interface PlatformDetection {
  detection_type?: string | null;
  confidence?: number | null;
  details?: Record<string, unknown> | null;
  explanation?: string | null;
  suggested_action?: string | null;
  suggested_fix?: string | null;
  created_at?: string | null;
}

interface TracePage {
  traces: PlatformTrace[];
  total: number;
}

interface DetectionPage {
  items: PlatformDetection[];
}

class PlatformResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PlatformResponseError';
  }
}

async function platformJson<T>(auth: PlatformAuth, url: URL): Promise<T> {
  const response = await auth.fetch('read', url);
  if (!response.ok) {
    throw new PlatformResponseError(
      `Pisama API returned HTTP ${response.status}.`,
      response.status,
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new PlatformResponseError('Pisama API returned invalid JSON.', response.status);
  }
}

function tenantApiUrl(baseUrl: string, tenantId: string, suffix: string): URL {
  return new URL(
    `/api/v1/tenants/${encodeURIComponent(tenantId)}/${suffix.replace(/^\//, '')}`,
    `${baseUrl}/`,
  );
}

async function fetchTraceRows(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  limit: number,
): Promise<PlatformTrace[]> {
  const rows: PlatformTrace[] = [];
  let page = 1;
  while (rows.length < limit) {
    const perPage = Math.min(100, limit - rows.length);
    const url = tenantApiUrl(baseUrl, tenantId, 'traces');
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    const result = await platformJson<TracePage>(auth, url);
    const batch = Array.isArray(result.traces) ? result.traces : [];
    rows.push(...batch);
    if (batch.length < perPage || rows.length >= result.total) break;
    page += 1;
  }
  return rows.slice(0, limit);
}

async function fetchDetections(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  traceId: string,
): Promise<PlatformDetection[]> {
  const url = tenantApiUrl(baseUrl, tenantId, 'detections');
  url.searchParams.set('trace_id', traceId);
  url.searchParams.set('per_page', '100');
  const result = await platformJson<DetectionPage>(auth, url);
  return Array.isArray(result.items) ? result.items : [];
}

async function adaptTraceBatch(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  rows: PlatformTrace[],
): Promise<TraceWithHits[]> {
  const output: TraceWithHits[] = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = rows.slice(offset, offset + 8);
    output.push(
      ...(await Promise.all(
        batch.map(async (row) => {
          const detections =
            (row.detection_count ?? 0) > 0
              ? await fetchDetections(auth, baseUrl, tenantId, row.id)
              : [];
          return adaptPlatformTrace(row, detections);
        }),
      )),
    );
  }
  return output;
}

async function fetchRecentTraces(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  opts: { limit: number; onlyFailures: boolean },
): Promise<TracesResponse> {
  let rows = await fetchTraceRows(auth, baseUrl, tenantId, opts.limit);
  if (opts.onlyFailures) rows = rows.filter((row) => (row.detection_count ?? 0) > 0);
  const events = await adaptTraceBatch(auth, baseUrl, tenantId, rows);
  return { tenantId, count: events.length, events };
}

async function fetchTrace(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  traceId: string,
): Promise<TraceWithHits> {
  const traceUrl = tenantApiUrl(baseUrl, tenantId, `traces/${encodeURIComponent(traceId)}`);
  const trace = await platformJson<PlatformTrace>(auth, traceUrl);
  const statesUrl = tenantApiUrl(baseUrl, tenantId, `traces/${encodeURIComponent(traceId)}/states`);
  statesUrl.searchParams.set('full_state', 'true');
  statesUrl.searchParams.set('limit', '2000');
  const [states, detections] = await Promise.all([
    platformJson<PlatformState[]>(auth, statesUrl),
    fetchDetections(auth, baseUrl, tenantId, traceId),
  ]);
  return adaptPlatformTrace(trace, detections, Array.isArray(states) ? states : []);
}

const PROMPT_KEYS = [
  '_prompt',
  'prompt',
  'input',
  'user_input',
  'query',
  'task',
  'question',
  'messages',
  'content',
] as const;
const COMPLETION_KEYS = ['completion', 'output', 'response'] as const;

function readableValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stateValue(
  states: PlatformState[],
  keys: readonly string[],
  reverse = false,
): string | undefined {
  const ordered = reverse ? [...states].reverse() : states;
  for (const state of ordered) {
    for (const key of keys) {
      const value = readableValue(state.state_delta?.[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function adaptDetection(detection: PlatformDetection): DetectionResult {
  const detector = detection.detection_type ?? 'unknown';
  const details = detection.details ?? undefined;
  const summary =
    detection.explanation ?? readableValue(details)?.slice(0, 400) ?? `${detector} detection`;
  return {
    detector,
    detected: true,
    severity:
      typeof detection.confidence === 'number'
        ? Math.max(0, Math.min(10, Math.round(detection.confidence / 10)))
        : 5,
    summary,
    ...(detection.suggested_fix || detection.suggested_action
      ? { fix: detection.suggested_fix ?? detection.suggested_action ?? undefined }
      : {}),
    ...(details ? { evidence: details } : {}),
  };
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function adaptPlatformTrace(
  trace: PlatformTrace,
  detections: PlatformDetection[],
  states: PlatformState[] = [],
): TraceWithHits {
  const completion =
    [...states].reverse().find((state) => state.response_redacted)?.response_redacted ??
    stateValue(states, COMPLETION_KEYS, true);
  return {
    event: {
      traceId: trace.id,
      startTime: parseTime(trace.created_at),
      endTime: parseTime(trace.completed_at ?? trace.created_at),
      model: trace.framework ?? '?',
      prompt: stateValue(states, PROMPT_KEYS),
      completion: completion ?? undefined,
      toolCalls: [],
      outputTokens: trace.total_tokens ?? undefined,
      costUsd:
        typeof trace.total_cost_cents === 'number' ? trace.total_cost_cents / 100 : undefined,
      finishReason: trace.status ?? undefined,
      metadata: {
        sessionId: trace.session_id ?? undefined,
        detectionStatus: trace.detection_status ?? undefined,
        stateCount: trace.state_count ?? states.length,
        toolCallsAvailable: false,
        ...(trace.detection_metadata ? { detectionMetadata: trace.detection_metadata } : {}),
      },
    },
    hits: detections.map(adaptDetection),
  };
}

function formatList(data: TracesResponse, failuresOnly: boolean): string {
  if (data.events.length === 0) {
    return failuresOnly
      ? `no failures in the sampled traces for tenant ${data.tenantId}.`
      : `no traces for tenant ${data.tenantId} yet.`;
  }
  const lines = data.events.map((e) => {
    const ago = relativeTime(e.event.startTime);
    const tokens = (e.event.inputTokens ?? 0) + (e.event.outputTokens ?? 0) || '—';
    const hits =
      e.hits.length === 0 ? '(clean)' : e.hits.map((h) => `${h.detector}/${h.severity}`).join(',');
    return `- ${e.event.traceId.slice(0, 8)} ${ago} ${e.event.model} ${tokens}t ${hits}`;
  });
  const header = failuresOnly
    ? `${data.events.length} recent failure(s) for tenant ${data.tenantId}:`
    : `${data.events.length} recent trace(s) for tenant ${data.tenantId}:`;
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
          'Optional tenant label for the report. Data access remains bound to the authenticated tenant.',
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
      '2. Walk the available prompt, completion, and state metadata. Note what the agent attempted.\n' +
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
      `2. Call \`get_trace\` with \`traceId="${failureId}"\` to load available state and detector hits.\n` +
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
