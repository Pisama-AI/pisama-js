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
  framework?: string;
  prompt?: string;
  completion?: string;
  toolCalls: { toolCallId: string; toolName: string }[];
  totalTokens?: number;
  costUsd?: number;
  traceStatus?: string;
  detectionStatus?: string;
  storedDetectionCount?: number;
  stateMetadata: TraceStateMetadata[];
  metadata: Record<string, unknown>;
}

interface TraceStateMetadata {
  stateId: string;
  sequenceNumber: number;
  agentId?: string;
  tokenCount?: number;
  latencyMs?: number;
  createdAt?: string;
  spanKind?: string;
  spanStatus?: string;
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
  visibleDetectionCount: number;
  hitsTruncated: boolean;
}

interface TracesResponse {
  tenantId: string;
  count: number;
  events: TraceWithHits[];
  scannedTraceCount: number;
  totalTraceCount: number;
  totalTraceCountKnown: boolean;
  scanComplete: boolean;
  resultsTruncated: boolean;
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
      scannedTraceCount: { type: 'number' },
      totalTraceCount: { type: 'number' },
      totalTraceCountKnown: { type: 'boolean' },
      scanComplete: { type: 'boolean' },
      resultsTruncated: { type: 'boolean' },
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
          "List recent traces with at least one visible detector hit (loop, hallucination, cost spike, etc.). Use this when the user asks 'what's broken' or 'what failed today'.",
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
  session_id: string;
  framework: string;
  status: string;
  detection_status: string;
  total_tokens: number;
  total_cost_cents: number;
  created_at: string;
  completed_at: string | null;
  state_count: number;
  detection_count: number;
  detection_metadata?: Record<string, unknown> | null;
}

interface PlatformState {
  id: string;
  sequence_num: number;
  agent_id: string;
  state_delta: Record<string, unknown>;
  state_hash: string;
  response_redacted?: string | null;
  token_count: number;
  latency_ms: number;
  created_at: string;
  span_kind?: string | null;
  span_status?: string | null;
}

interface PlatformDetection {
  id: string;
  trace_id: string;
  state_id: string | null;
  detection_type: string;
  confidence: number;
  method: string;
  details: Record<string, unknown>;
  validated: boolean;
  false_positive: boolean | null;
  explanation?: string | null;
  suggested_action?: string | null;
  suggested_fix?: string | null;
  created_at: string;
}

interface TracePage {
  traces: PlatformTrace[];
  total?: number;
}

interface DetectionPage {
  items: PlatformDetection[];
  total?: number;
  page?: number;
  per_page?: number;
}

interface DetectionBatch {
  items: PlatformDetection[];
  total: number;
  truncated: boolean;
}

function invalidPlatformShape(message: string): never {
  throw new PlatformResponseError(`Pisama API returned an invalid response: ${message}.`, 502);
}

function optionalCount(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalidPlatformShape(`${label}.${key} must be a non-negative integer when present`);
  }
  return value;
}

function requiredCount(record: Record<string, unknown>, key: string, label: string): number {
  const value = optionalCount(record, key, label);
  if (value === undefined) invalidPlatformShape(`${label}.${key} is required`);
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidPlatformShape(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalNullableString(record: Record<string, unknown>, key: string, label: string): void {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    invalidPlatformShape(`${label}.${key} must be a string or null when present`);
  }
}

function requiredNullableString(record: Record<string, unknown>, key: string, label: string): void {
  if (!(key in record)) invalidPlatformShape(`${label}.${key} is required`);
  optionalNullableString(record, key, label);
}

function requiredTimestamp(record: Record<string, unknown>, key: string, label: string): string {
  const value = requiredString(record, key, label);
  if (!Number.isFinite(Date.parse(value))) {
    invalidPlatformShape(`${label}.${key} must be a valid timestamp`);
  }
  return value;
}

function requiredNullableTimestamp(
  record: Record<string, unknown>,
  key: string,
  label: string,
): void {
  requiredNullableString(record, key, label);
  const value = record[key];
  if (typeof value === 'string' && !Number.isFinite(Date.parse(value))) {
    invalidPlatformShape(`${label}.${key} must be a valid timestamp or null`);
  }
}

function validatePlatformTrace(
  value: unknown,
  label: string,
  expectedTraceId?: string,
): PlatformTrace {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidPlatformShape(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = requiredString(record, 'id', label);
  if (expectedTraceId !== undefined && id !== expectedTraceId) {
    invalidPlatformShape(`${label}.id does not match the requested trace`);
  }
  requiredString(record, 'session_id', label);
  requiredString(record, 'framework', label);
  requiredString(record, 'status', label);
  const detectionStatus = requiredString(record, 'detection_status', label);
  if (!['pending', 'running', 'partial', 'complete', 'failed'].includes(detectionStatus)) {
    invalidPlatformShape(`${label}.detection_status is unsupported`);
  }
  requiredCount(record, 'total_tokens', label);
  requiredCount(record, 'total_cost_cents', label);
  requiredTimestamp(record, 'created_at', label);
  requiredNullableTimestamp(record, 'completed_at', label);
  requiredCount(record, 'state_count', label);
  requiredCount(record, 'detection_count', label);
  const metadata = record['detection_metadata'];
  if (metadata !== undefined && metadata !== null) {
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      invalidPlatformShape(`${label}.detection_metadata must be an object or null`);
    }
  }
  return value as PlatformTrace;
}

function validatePlatformDetection(
  value: unknown,
  index: number,
  expectedTraceId: string,
): PlatformDetection {
  const label = `detection page items[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidPlatformShape(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  requiredString(record, 'id', label);
  if (requiredString(record, 'trace_id', label) !== expectedTraceId) {
    invalidPlatformShape(`${label}.trace_id does not match the requested trace`);
  }
  requiredNullableString(record, 'state_id', label);
  requiredString(record, 'detection_type', label);
  const confidence = requiredCount(record, 'confidence', label);
  if (confidence > 100) invalidPlatformShape(`${label}.confidence must be at most 100`);
  requiredString(record, 'method', label);
  const details = record['details'];
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    invalidPlatformShape(`${label}.details must be an object`);
  }
  if (typeof record['validated'] !== 'boolean') {
    invalidPlatformShape(`${label}.validated must be a boolean`);
  }
  const falsePositive = record['false_positive'];
  if (falsePositive !== null && typeof falsePositive !== 'boolean') {
    invalidPlatformShape(`${label}.false_positive must be a boolean or null`);
  }
  requiredTimestamp(record, 'created_at', label);
  for (const field of ['explanation', 'suggested_action', 'suggested_fix'] as const) {
    optionalNullableString(record, field, label);
  }
  return value as PlatformDetection;
}

function validatePlatformStates(value: unknown): PlatformState[] {
  if (!Array.isArray(value)) invalidPlatformShape('trace states must be an array');
  return value.map((state, index) => {
    const label = `trace states[${index}]`;
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      invalidPlatformShape(`${label} must be an object`);
    }
    const record = state as Record<string, unknown>;
    requiredString(record, 'id', label);
    requiredCount(record, 'sequence_num', label);
    requiredString(record, 'agent_id', label);
    const delta = record['state_delta'];
    if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) {
      invalidPlatformShape(`${label}.state_delta must be an object`);
    }
    requiredString(record, 'state_hash', label);
    optionalNullableString(record, 'response_redacted', label);
    requiredCount(record, 'token_count', label);
    requiredCount(record, 'latency_ms', label);
    requiredTimestamp(record, 'created_at', label);
    optionalNullableString(record, 'span_kind', label);
    optionalNullableString(record, 'span_status', label);
    return state as PlatformState;
  });
}

function validateTracePage(value: unknown): TracePage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidPlatformShape('trace page must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['traces'])) {
    invalidPlatformShape('trace page traces must be an array');
  }
  const traces = record['traces'].map((trace, index) =>
    validatePlatformTrace(trace, `trace page traces[${index}]`),
  );
  return { traces, total: optionalCount(record, 'total', 'trace page') };
}

function validateDetectionPage(value: unknown, expectedTraceId: string): DetectionPage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidPlatformShape('detection page must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record['items'])) {
    invalidPlatformShape('detection page items must be an array');
  }
  const items = record['items'].map((item, index) =>
    validatePlatformDetection(item, index, expectedTraceId),
  );
  return {
    items,
    total: optionalCount(record, 'total', 'detection page'),
    page: optionalCount(record, 'page', 'detection page'),
    per_page: optionalCount(record, 'per_page', 'detection page'),
  };
}

const TRACE_PAGE_SIZE = 100;
const MAX_TRACE_SCAN = 1000;
const DETECTION_PAGE_SIZE = 100;
const MAX_DETECTIONS_PER_TRACE = 500;

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

async function fetchTracePage(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  page: number,
  perPage: number,
): Promise<TracePage> {
  const url = tenantApiUrl(baseUrl, tenantId, 'traces');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  return validateTracePage(await platformJson<unknown>(auth, url));
}

async function fetchDetections(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  traceId: string,
): Promise<DetectionBatch> {
  const items: PlatformDetection[] = [];
  let page = 1;
  let reportedTotal: number | undefined;

  while (items.length < MAX_DETECTIONS_PER_TRACE) {
    const perPage = Math.min(DETECTION_PAGE_SIZE, MAX_DETECTIONS_PER_TRACE - items.length);
    const url = tenantApiUrl(baseUrl, tenantId, 'detections');
    url.searchParams.set('trace_id', traceId);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    const result = validateDetectionPage(await platformJson<unknown>(auth, url), traceId);
    const batch = result.items;
    if (typeof result.total === 'number' && Number.isFinite(result.total)) {
      reportedTotal = Math.max(0, Math.floor(result.total));
    }
    items.push(...batch.slice(0, MAX_DETECTIONS_PER_TRACE - items.length));

    if (batch.length < perPage || (reportedTotal !== undefined && items.length >= reportedTotal)) {
      break;
    }
    page += 1;
  }

  const total = Math.max(items.length, reportedTotal ?? items.length);
  return {
    items,
    total,
    truncated:
      total > items.length ||
      (reportedTotal === undefined && items.length >= MAX_DETECTIONS_PER_TRACE),
  };
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
              : { items: [], total: 0, truncated: false };
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
  const events: TraceWithHits[] = [];
  const perPage = opts.onlyFailures ? TRACE_PAGE_SIZE : Math.min(TRACE_PAGE_SIZE, opts.limit);
  let page = 1;
  let scannedTraceCount = 0;
  let totalTraceCount = 0;
  let totalTraceCountKnown = false;
  let scanComplete = false;
  let resultsTruncated = false;

  while (events.length < opts.limit && scannedTraceCount < MAX_TRACE_SCAN) {
    const result = await fetchTracePage(auth, baseUrl, tenantId, page, perPage);
    const rows = result.traces;
    scannedTraceCount += rows.length;
    totalTraceCount = Math.max(totalTraceCount, result.total ?? 0, scannedTraceCount);
    if (result.total !== undefined) totalTraceCountKnown = true;

    const candidates = opts.onlyFailures
      ? rows.filter((row) => (row.detection_count ?? 0) > 0)
      : rows;
    const adapted = await adaptTraceBatch(auth, baseUrl, tenantId, candidates);
    const visible = opts.onlyFailures ? adapted.filter((event) => event.hits.length > 0) : adapted;
    const remaining = opts.limit - events.length;
    events.push(...visible.slice(0, remaining));
    if (visible.length > remaining) resultsTruncated = true;

    const reachedSourceEnd =
      result.total === undefined
        ? rows.length < perPage
        : rows.length === 0 || scannedTraceCount >= result.total;
    if (reachedSourceEnd) {
      scanComplete = true;
      totalTraceCountKnown = true;
      break;
    }
    if (events.length >= opts.limit) {
      resultsTruncated = true;
      break;
    }
    page += 1;
  }

  if (!scanComplete && scannedTraceCount >= MAX_TRACE_SCAN) resultsTruncated = true;
  return {
    tenantId,
    count: events.length,
    events,
    scannedTraceCount,
    totalTraceCount,
    totalTraceCountKnown,
    scanComplete,
    resultsTruncated,
  };
}

async function fetchTrace(
  auth: PlatformAuth,
  baseUrl: string,
  tenantId: string,
  traceId: string,
): Promise<TraceWithHits> {
  const traceUrl = tenantApiUrl(baseUrl, tenantId, `traces/${encodeURIComponent(traceId)}`);
  const trace = validatePlatformTrace(
    await platformJson<unknown>(auth, traceUrl),
    'trace response',
    traceId,
  );
  const statesUrl = tenantApiUrl(baseUrl, tenantId, `traces/${encodeURIComponent(traceId)}/states`);
  statesUrl.searchParams.set('full_state', 'true');
  statesUrl.searchParams.set('limit', '2000');
  const [states, detections] = await Promise.all([
    platformJson<unknown>(auth, statesUrl).then(validatePlatformStates),
    fetchDetections(auth, baseUrl, tenantId, traceId),
  ]);
  return adaptPlatformTrace(trace, detections, states);
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

function adaptStateMetadata(state: PlatformState): TraceStateMetadata {
  return {
    stateId: state.id,
    sequenceNumber: state.sequence_num,
    agentId: state.agent_id ?? undefined,
    tokenCount: state.token_count ?? undefined,
    latencyMs: state.latency_ms ?? undefined,
    createdAt: state.created_at ?? undefined,
    spanKind: state.span_kind ?? undefined,
    spanStatus: state.span_status ?? undefined,
  };
}

function traceCostUsd(trace: PlatformTrace): number | undefined {
  return typeof trace.total_cost_cents === 'number' ? trace.total_cost_cents / 100 : undefined;
}

function traceMetadata(trace: PlatformTrace, states: PlatformState[]): Record<string, unknown> {
  return {
    sessionId: trace.session_id ?? undefined,
    stateCount: trace.state_count ?? states.length,
    statesTruncated: typeof trace.state_count === 'number' && trace.state_count > states.length,
    toolCallsAvailable: false,
    ...(trace.detection_metadata ? { detectionMetadata: trace.detection_metadata } : {}),
  };
}

function adaptPlatformTrace(
  trace: PlatformTrace,
  detections: DetectionBatch,
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
      framework: trace.framework ?? undefined,
      prompt: stateValue(states, PROMPT_KEYS),
      completion: completion ?? undefined,
      toolCalls: [],
      totalTokens: trace.total_tokens ?? undefined,
      costUsd: traceCostUsd(trace),
      traceStatus: trace.status ?? undefined,
      detectionStatus: trace.detection_status ?? undefined,
      storedDetectionCount: trace.detection_count ?? undefined,
      stateMetadata: states.map(adaptStateMetadata),
      metadata: traceMetadata(trace, states),
    },
    hits: detections.items.map(adaptDetection),
    visibleDetectionCount: detections.total,
    hitsTruncated: detections.truncated,
  };
}

function formatHitSummary(trace: TraceWithHits): string {
  if (trace.hits.length > 0) {
    const summary = trace.hits.map((hit) => `${hit.detector}/${hit.severity}`).join(',');
    return trace.hitsTruncated ? `${summary},… (${trace.visibleDetectionCount} visible)` : summary;
  }
  if ((trace.event.storedDetectionCount ?? 0) > 0) return '(no visible detector hits)';
  if (trace.event.detectionStatus === 'complete' && trace.event.storedDetectionCount === 0) {
    return '(clean)';
  }
  return trace.event.detectionStatus
    ? `(detection ${trace.event.detectionStatus})`
    : '(detection status unavailable)';
}

function formatList(data: TracesResponse, failuresOnly: boolean): string {
  if (data.events.length === 0) {
    return failuresOnly
      ? `no visible failures found in ${data.scannedTraceCount} scanned trace(s) for tenant ${data.tenantId}${data.scanComplete ? '.' : '; the bounded scan was incomplete.'}`
      : `no traces for tenant ${data.tenantId} yet.`;
  }
  const lines = data.events.map((e) => {
    const ago = relativeTime(e.event.startTime);
    const tokens = e.event.totalTokens ?? '—';
    const framework = e.event.framework ?? 'unknown-framework';
    return `- ${e.event.traceId.slice(0, 8)} ${ago} ${framework} ${tokens}t ${formatHitSummary(e)}`;
  });
  const header = failuresOnly
    ? `${data.events.length} recent visible failure(s) returned for tenant ${data.tenantId}:`
    : `${data.events.length} recent trace(s) returned for tenant ${data.tenantId}:`;
  const coverage = data.scanComplete
    ? `Scanned all ${data.totalTraceCount} available trace(s).`
    : data.totalTraceCountKnown
      ? `Scanned ${data.scannedTraceCount} of ${data.totalTraceCount} available trace(s); results are bounded.`
      : `Scanned ${data.scannedTraceCount} trace(s); the source total is unavailable and results are bounded.`;
  return `${header}\n${lines.join('\n')}\n${coverage}`;
}

function formatTraceHeader(t: TraceWithHits): string[] {
  return [
    `traceId: ${t.event.traceId}`,
    `when: ${new Date(t.event.startTime).toISOString()}`,
    `framework: ${t.event.framework ?? '?'}`,
    `tokens: total=${t.event.totalTokens ?? '?'} cost=$${t.event.costUsd ?? '?'}`,
    `traceStatus: ${t.event.traceStatus ?? '?'}`,
    `detectionStatus: ${t.event.detectionStatus ?? '?'}`,
    `visibleDetectorHits: ${t.visibleDetectionCount}${t.hitsTruncated ? ` (showing first ${t.hits.length})` : ''}`,
  ];
}

function formatTraceContent(event: TraceEvent): string[] {
  const out: string[] = [];
  if (event.prompt) {
    out.push(`\nprompt:\n${truncate(event.prompt, 1000)}`);
  }
  if (event.completion) {
    out.push(`\ncompletion:\n${truncate(event.completion, 1000)}`);
  }
  if (event.toolCalls.length > 0) {
    out.push(`\ntool calls (${event.toolCalls.length}):`);
    for (const tc of event.toolCalls) {
      out.push(`  - ${tc.toolName} (${tc.toolCallId})`);
    }
  }
  return out;
}

function formatStateMetadata(states: TraceStateMetadata[]): string[] {
  const out: string[] = [];
  if (states.length > 0) {
    out.push(`\nstate metadata (${states.length}):`);
    for (const state of states) {
      const agent = state.agentId ? ` agent=${state.agentId}` : '';
      const tokens = state.tokenCount === undefined ? '' : ` tokens=${state.tokenCount}`;
      const latency = state.latencyMs === undefined ? '' : ` latencyMs=${state.latencyMs}`;
      out.push(
        `  - sequence=${state.sequenceNumber} id=${state.stateId}${agent}${tokens}${latency}`,
      );
    }
  }
  return out;
}

function formatDetectionHits(t: TraceWithHits): string[] {
  const out: string[] = [];
  if (t.hits.length > 0) {
    out.push(`\ndetector hits:`);
    for (const h of t.hits) {
      out.push(`  - ${h.detector} (severity ${h.severity}): ${h.summary}`);
      if (h.fix) out.push(`    fix: ${h.fix}`);
    }
  } else if ((t.event.storedDetectionCount ?? 0) > 0) {
    out.push('\nNo detector hits are visible under the current detection-list filters.');
  }
  return out;
}

function formatTrace(t: TraceWithHits): string {
  const out = [
    ...formatTraceHeader(t),
    ...formatTraceContent(t.event),
    ...formatStateMetadata(t.event.stateMetadata),
    ...formatDetectionHits(t),
  ];
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
      '5. Reply with: visible failures returned in the window, top three detector patterns with counts, and one recommended action. State that the tool is a bounded sample whenever `scanComplete` is false; do not claim a tenant-wide total.';
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
      '1. Call `get_recent_traces` with limit 200 to sample recent activity. Treat `count` as rows returned, not tenant-wide volume, and report scan coverage.\n' +
      '2. Call `get_recent_failures` with limit 200. Filter both returned samples to events from the last 24 hours and disclose when `scanComplete` is false.\n' +
      '3. Group failures by detector. Surface the top three issues by count.\n' +
      '4. Compute proposed-fix coverage: count returned failures where any visible detector hit has a non-empty `fix` field. A proposal is not evidence that a fix was applied or healed the run.\n' +
      '5. Reply with four sections: Sampled volume, Top three issues, Proposed-fix coverage, One action for the day. Keep it under 200 words for a morning standup.';
    return {
      description: 'Morning-standup quality summary.',
      messages: [{ role: 'user', content: { type: 'text', text: body } }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}
