import { nanoid } from 'nanoid';
import type { TraceEvent } from './types.js';
import { isDebug, isSilent, isTelemetryDisabled } from './diagnostics.js';
import { getClientId, detectRuntime } from './client-id.js';
import { SDK_VERSION } from './version.js';

export interface ExporterOptions {
  endpoint?: string;
  tokenEndpoint?: string;
  apiKey?: string;
  /** A service label retained for compatibility with existing integrations. */
  projectId?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  /** Total transport budget for one flush, including token exchange and a 401 retry. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const HOSTED_ENDPOINT = 'https://api.pisama.ai/api/v1/traces/ingest';
const DEFAULT_TIMEOUT_MS = 10_000;

interface IngestResponseBody {
  accepted?: number;
  submitted?: number;
  rejected?: number;
  duplicates?: number;
}

type TokenScope = 'full' | 'ingest' | 'read';

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAnyValue;
}

function defaultEndpoint(): string {
  if (typeof process !== 'undefined' && process.env.PISAMA_INGEST_URL) {
    return process.env.PISAMA_INGEST_URL;
  }
  return HOSTED_ENDPOINT;
}

function defaultTokenEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/$/, '');
  if (/\/api\/v1\/traces\/ingest$/.test(normalized)) {
    return normalized.replace(/\/traces\/ingest$/, '/auth/token');
  }
  try {
    return new URL('/api/v1/auth/token', normalized).toString();
  } catch {
    return '/api/v1/auth/token';
  }
}

function normaliseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  return Math.max(1, Math.floor(timeout));
}

function encodeValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function attr(key: string, value: string | number | boolean): OtlpAttribute {
  return { key, value: encodeValue(value) };
}

function addAttr(
  attributes: OtlpAttribute[],
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return;
  attributes.push(attr(key, value));
}

function spanAttributes(event: TraceEvent): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = [
    attr('gen_ai.system', 'vercel.ai'),
    attr('gen_ai.operation.name', 'chat'),
  ];
  addAttr(attributes, 'gen_ai.request.model', event.model);
  addAttr(attributes, 'gen_ai.prompt', event.prompt);
  addAttr(attributes, 'gen_ai.completion', event.completion);
  if (event.toolCalls.length > 0) {
    addAttr(attributes, 'gen_ai.tool_calls', JSON.stringify(event.toolCalls));
  }
  addAttr(attributes, 'gen_ai.usage.input_tokens', event.inputTokens);
  addAttr(attributes, 'gen_ai.usage.output_tokens', event.outputTokens);
  if (event.inputTokens !== undefined || event.outputTokens !== undefined) {
    addAttr(
      attributes,
      'gen_ai.usage.total_tokens',
      (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
    );
  }
  addAttr(attributes, 'gen_ai.usage.cost_usd', event.costUsd);
  addAttr(attributes, 'gen_ai.response.finish_reason', event.finishReason);
  if (event.error) {
    addAttr(attributes, 'error.type', event.error.name ?? 'Error');
    addAttr(attributes, 'error.message', event.error.message);
  }

  const state = {
    ...event.metadata,
    ...(event.reasoning ? { reasoning: event.reasoning } : {}),
    ...(event.finishReason ? { finish_reason: event.finishReason } : {}),
    ...(event.error ? { error: event.error } : {}),
  };
  if (Object.keys(state).length > 0) {
    addAttr(attributes, 'gen_ai.state', JSON.stringify(state));
  }
  return attributes;
}

function nanos(timestampMs: number): string {
  return (BigInt(Math.trunc(timestampMs)) * 1_000_000n).toString();
}

function encodeBatch(batch: TraceEvent[], projectId: string): string {
  const resourceAttributes = [
    attr('service.name', projectId || '@pisama/sdk'),
    attr('pisama.sdk', '@pisama/sdk'),
    attr('pisama.sdk.version', SDK_VERSION),
    attr('pisama.framework', 'vercel-ai-sdk'),
    attr('pisama.client.id', getClientId()),
    attr('pisama.runtime', detectRuntime()),
  ];
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [
          {
            scope: { name: '@pisama/sdk', version: SDK_VERSION },
            spans: batch.map((event) => ({
              traceId: event.traceId,
              spanId: event.spanId,
              ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
              name: `gen_ai.chat ${event.model || 'unknown'}`,
              kind: 3,
              startTimeUnixNano: nanos(event.startTime),
              endTimeUnixNano: nanos(event.endTime),
              attributes: spanAttributes(event),
              status: event.error ? { code: 2, message: event.error.message } : { code: 1 },
            })),
          },
        ],
      },
    ],
  });
}

export class TraceExporter {
  private buffer: TraceEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly tokenEndpoint: string;
  private readonly apiKey: string | undefined;
  private readonly projectId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private jwt: string | undefined;
  private tokenExchange: Promise<string> | undefined;

  constructor(opts: ExporterOptions) {
    this.endpoint = opts.endpoint ?? defaultEndpoint();
    this.tokenEndpoint = opts.tokenEndpoint ?? defaultTokenEndpoint(this.endpoint);
    this.apiKey =
      opts.apiKey ?? (typeof process !== 'undefined' ? process.env.PISAMA_API_KEY : undefined);
    this.projectId =
      opts.projectId ??
      (typeof process !== 'undefined' ? process.env.PISAMA_PROJECT_ID : undefined) ??
      '@pisama/sdk';
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.maxBatchSize = opts.maxBatchSize ?? 32;
    this.timeoutMs = normaliseTimeout(opts.timeoutMs);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  enqueue(event: TraceEvent): void {
    if (isTelemetryDisabled()) return;
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  async flush(): Promise<void> {
    const batch = this.takeBatch();
    if (!batch) return;

    if (!this.apiKey) {
      if (!isSilent()) {
        console.warn(
          `[pisama] no API key configured; ${batch.length} event(s) dropped without network ` +
            'egress. Set PISAMA_API_KEY or pass apiKey to observe().',
        );
      }
      return;
    }

    const debug = isDebug();
    try {
      // Serialize once and keep one request id across a 401 retry. The backend
      // uses X-Request-ID for billing idempotency, so a retry must be exact.
      const body = encodeBatch(batch, this.projectId);
      const requestId = `pisama-sdk-${nanoid()}`;
      const res = await this.send(body, requestId);
      if (debug) {
        console.log(`[pisama] flushed ${batch.length} event(s), HTTP ${res.status}`);
      }
      this.reportRejectedFlush(res, batch.length);
      await this.reportIngestResult(res, batch.length, debug);
    } catch (err) {
      this.reportFailure(err, debug);
    }
  }

  private takeBatch(): TraceEvent[] | null {
    if (isTelemetryDisabled()) {
      this.buffer.length = 0;
      this.clearTimer();
      return null;
    }
    if (this.buffer.length === 0) {
      this.clearTimer();
      return null;
    }
    return this.buffer.splice(0, this.buffer.length);
  }

  private async accessToken(deadline = Date.now() + this.timeoutMs): Promise<string> {
    if (this.jwt) return this.jwt;
    if (this.tokenExchange) return this.tokenExchange;
    this.tokenExchange = this.exchangeToken(deadline);
    try {
      this.jwt = await this.tokenExchange;
      return this.jwt;
    } finally {
      this.tokenExchange = undefined;
    }
  }

  private async exchangeToken(deadline: number): Promise<string> {
    const res = await this.fetchWithDeadline(
      this.tokenEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey, scope: 'ingest' }),
        redirect: 'error',
      },
      deadline,
    );
    if (!res.ok) {
      throw new Error(`API key exchange returned HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('API key exchange returned no access_token');
    }
    assertTokenScope(body.access_token, 'ingest');
    return body.access_token;
  }

  private async send(body: string, requestId: string): Promise<Response> {
    const deadline = Date.now() + this.timeoutMs;
    const token = await this.accessToken(deadline);
    let res = await this.sendOnce(body, requestId, token, deadline);
    if (res.status === 401) {
      // JWT expired mid-run. Invalidate only the token this request used: if a
      // concurrent flush already refreshed it, reuse the newer cached token.
      if (this.jwt === token) this.jwt = undefined;
      res = await this.sendOnce(body, requestId, await this.accessToken(deadline), deadline);
    }
    return res;
  }

  private sendOnce(
    body: string,
    requestId: string,
    token: string,
    deadline: number,
  ): Promise<Response> {
    return this.fetchWithDeadline(
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-request-id': requestId,
          'x-pisama-project-id': this.projectId,
          'x-pisama-client-id': getClientId(),
          'x-pisama-sdk-version': SDK_VERSION,
          'x-pisama-runtime': detectRuntime(),
        },
        body,
        keepalive: true,
        redirect: 'error',
      },
      deadline,
    );
  }

  private async fetchWithDeadline(
    input: RequestInfo | URL,
    init: RequestInit,
    deadline: number,
  ): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Pisama export timed out after ${this.timeoutMs}ms`);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`Pisama export timed out after ${this.timeoutMs}ms`));
      }, remaining);
    });
    try {
      const request = (async () => {
        const response = await this.fetchImpl(input, { ...init, signal: controller?.signal });
        // Buffer the small JSON response while the same deadline and abort
        // controller are still active. Resolving only at headers would let a
        // peer hold response.json()/text() open forever after eager flush.
        const bytes = await response.arrayBuffer();
        return new Response(bytes.byteLength === 0 ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })();
      return await Promise.race([request, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private reportRejectedFlush(res: Response, droppedCount: number): void {
    if (res.ok || res.status === 207 || isSilent()) return;

    if (res.status === 404) {
      console.warn(
        `[pisama] ingest endpoint not found (HTTP 404) at ${this.endpoint}. ` +
          `${droppedCount} event(s) dropped. This SDK version targets authenticated OTLP ` +
          `JSON at /api/v1/traces/ingest. Check PISAMA_INGEST_URL or upgrade the deployment.`,
      );
      return;
    }
    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[pisama] ingest rejected the scoped access token (HTTP ${res.status}) at ` +
          `${this.endpoint}. ${droppedCount} event(s) dropped. Check PISAMA_API_KEY and its ` +
          `ingest scope.`,
      );
      return;
    }
    console.warn(
      `[pisama] ingest returned HTTP ${res.status} at ${this.endpoint}. ` +
        `${droppedCount} event(s) dropped.`,
    );
  }

  private async reportIngestResult(
    res: Response,
    submittedCount: number,
    debug: boolean,
  ): Promise<void> {
    if ((!res.ok && res.status !== 207) || isSilent()) return;
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as IngestResponseBody | null;
    if (!body || !body.rejected) return;
    console.warn(
      `[pisama] partial flush: ${body.accepted ?? '?'}/${body.submitted ?? submittedCount} ` +
        `accepted, ${body.rejected} rejected`,
    );
    if (debug && body.duplicates) {
      console.warn(`[pisama] ${body.duplicates} duplicate event(s) skipped`);
    }
  }

  private reportFailure(error: unknown, debug: boolean): void {
    if (
      !isSilent() &&
      (debug || String((error as Error)?.message).startsWith('API key exchange'))
    ) {
      console.warn(`[pisama] flush failed (events dropped):`, (error as Error)?.message ?? error);
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function assertTokenScope(token: string, requestedScope: TokenScope): void {
  let scope: TokenScope;
  try {
    const payload = token.split('.')[1];
    if (!payload) throw new Error('missing payload');
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as {
      scope?: unknown;
    };
    if (decoded.scope !== 'full' && decoded.scope !== 'ingest' && decoded.scope !== 'read') {
      throw new Error('missing or unsupported scope');
    }
    scope = decoded.scope;
  } catch {
    throw new Error('API key exchange returned a token with no usable scope');
  }
  if (scope !== requestedScope && scope !== 'full') {
    throw new Error(
      `API key exchange returned a ${scope}-scoped token that cannot satisfy ${requestedScope} access`,
    );
  }
}
