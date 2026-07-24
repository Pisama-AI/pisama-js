import { nanoid } from 'nanoid';
import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import { redactObject, type RedactMode } from './redact.js';
import { TraceExporter } from './exporter.js';
import {
  isTelemetryDisabled,
  logEnabled,
  maybeStartSilenceWarning,
  noteEventEnqueued,
} from './diagnostics.js';
import type { ToolCall, TraceEvent } from './types.js';

export interface PisamaMiddlewareOptions {
  projectId?: string;
  endpoint?: string;
  redact?: RedactMode;
  enabled?: boolean;
  exporter?: TraceExporter;
  /**
   * Optional contact email. Embedded into each TraceEvent's `metadata.contact`
   * so the dashboard can ping you when pisama ships paid alerts. Opt-in.
   */
  contact?: string;
  /**
   * Eager flush mode. When true, traces are flushed inline with the request
   * lifecycle — `wrapGenerate` awaits the export before returning, and
   * `wrapStream`'s tap awaits the export when the upstream closes. Required
   * for serverless runtimes without a background event loop (Cloudflare
   * Workers, Vercel Edge Functions, Deno Deploy) where the isolate is frozen
   * after the response finishes streaming — the lazy `setInterval` flush
   * never fires and traces are silently dropped.
   *
   * Default: auto-detected. We turn on eager mode when we detect a Workers /
   * Edge runtime (presence of `WebSocketPair` or `EdgeRuntime` global). Set
   * explicitly to `false` to disable, or `true` to force it on (slight added
   * latency on each generation as the trace POST is awaited inline).
   */
  eager?: boolean;
}

function detectEdgeRuntime(): boolean {
  // Cloudflare Workers exposes WebSocketPair as a global. nodejs_compat
  // doesn't remove it (it's a Workers-only platform API).
  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined') {
    return true;
  }
  // Vercel Edge runtime sets EdgeRuntime global.
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== 'undefined') {
    return true;
  }
  // Vercel Node Functions also freeze after the response — they have a real
  // process.env and Node APIs, but no long-running background loop. The
  // setInterval-based lazy flush gets killed by unref() and the function exit
  // before it fires for short responses. Treat Vercel as eager too. Detected
  // via `VERCEL=1` which Vercel sets on every deployment runtime (preview,
  // production, edge, function).
  if (typeof process !== 'undefined' && process.env.VERCEL === '1') {
    return true;
  }
  // AWS Lambda / Netlify Functions / Cloud Run — similar serverless runtimes
  // that also freeze after response. Cheap to add since the markers are
  // standard.
  if (typeof process !== 'undefined') {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
    if (process.env.NETLIFY === 'true') return true;
    if (process.env.K_SERVICE) return true; // Cloud Run
  }
  return false;
}

interface ModelLike {
  modelId?: string;
  provider?: string;
}

interface ParamsLike {
  prompt?: unknown;
  messages?: unknown;
}

interface UsageLike {
  inputTokens?: { total?: number };
  outputTokens?: { total?: number };
}

interface ContentPartLike {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
}

interface GenerateResultLike {
  content?: ContentPartLike[];
  finishReason?: string;
  usage?: UsageLike;
}

interface StreamPartLike {
  type: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
  finishReason?: string;
  usage?: UsageLike;
}

interface MiddlewareWrapGenerateArgs {
  doGenerate: () => PromiseLike<GenerateResultLike>;
  doStream: () => PromiseLike<{ stream: ReadableStream<StreamPartLike> }>;
  params: ParamsLike;
  model: ModelLike;
}

interface MiddlewareWrapStreamArgs {
  doGenerate: () => PromiseLike<GenerateResultLike>;
  doStream: () => PromiseLike<{ stream: ReadableStream<StreamPartLike> }>;
  params: ParamsLike;
  model: ModelLike;
}

export interface PisamaLanguageModelMiddleware {
  readonly specificationVersion: 'v3';
  wrapGenerate: (args: MiddlewareWrapGenerateArgs) => Promise<GenerateResultLike>;
  wrapStream: (
    args: MiddlewareWrapStreamArgs,
  ) => Promise<{ stream: ReadableStream<StreamPartLike> }>;
}

export function pisamaMiddleware(opts: PisamaMiddlewareOptions = {}): LanguageModelV3Middleware {
  const inner: PisamaLanguageModelMiddleware = buildMiddleware(opts);
  // Misuse guardrail: a common AI-agent mistake is to call the returned
  // middleware as if it were a model wrapper — `pisamaMiddleware(opts)(model)`.
  // (The v0 install on 2026-05-10 did exactly this.) Without this guardrail,
  // Node throws the cryptic "X is not a function" at chat time, with no
  // pointer to the actual fix.
  //
  // The Proxy `apply` trap only fires when the underlying target is callable,
  // so the target is a no-op function. `get` forwards every property access
  // to the inner middleware object so wrapLanguageModel reads `wrapGenerate` /
  // `wrapStream` normally. `has` lets `'wrapGenerate' in middleware` checks
  // still work.
  const callable = function (): never {
    /* unreachable; the apply trap handles it */ throw new Error('unreachable');
  };
  return new Proxy(callable, {
    apply(): never {
      throw new TypeError(
        "[pisama] Don't call pisamaMiddleware(opts) as a function. " +
          'Use observe(model, opts) from @pisama/sdk instead — single ' +
          'call, no wrapLanguageModel ceremony. ' +
          'See https://pisama.ai/install',
      );
    },
    get(_t, key): unknown {
      return inner[key as keyof PisamaLanguageModelMiddleware];
    },
    has(_t, key): boolean {
      return key in inner;
    },
    ownKeys() {
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(_t, key) {
      return Reflect.getOwnPropertyDescriptor(inner, key);
    },
  }) as unknown as LanguageModelV3Middleware;
}

function buildMiddleware(opts: PisamaMiddlewareOptions = {}): PisamaLanguageModelMiddleware {
  const projectId =
    opts.projectId ?? (typeof process !== 'undefined' ? process.env.PISAMA_PROJECT_ID : undefined);

  const enabled = opts.enabled !== false && Boolean(projectId) && !isTelemetryDisabled();
  const redactMode: RedactMode = opts.redact ?? 'standard';

  const noopGenerate = async ({ doGenerate }: MiddlewareWrapGenerateArgs) => doGenerate();
  const noopStream = async ({ doStream }: MiddlewareWrapStreamArgs) => doStream();

  if (!enabled || !projectId) {
    return {
      specificationVersion: 'v3',
      wrapGenerate: noopGenerate,
      wrapStream: noopStream,
    };
  }

  const exporter = opts.exporter ?? new TraceExporter({ projectId, endpoint: opts.endpoint });
  const baseMetadata: Record<string, unknown> = {};
  if (opts.contact && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(opts.contact)) {
    baseMetadata.contact = opts.contact;
  }
  // Install-source tag. Written by the AI builder during install (per the
  // /install prompt), so traces carry where the install came from. Lets the
  // dashboard surface per-platform first-install success rate and alarm
  // when a platform regresses. Validated against a strict slug allowlist —
  // junk values are dropped so we can rely on the column server-side.
  if (typeof process !== 'undefined') {
    const rawPlatform = process.env.PISAMA_PLATFORM?.trim().toLowerCase();
    if (rawPlatform && /^[a-z0-9-]{1,32}$/.test(rawPlatform)) {
      baseMetadata.pisama_platform = rawPlatform;
    }
  }

  // Eager flush: required on Cloudflare Workers / Vercel Edge / Deno Deploy
  // where the isolate is frozen after the response finishes — the lazy
  // setInterval-based flush never fires and traces get silently dropped.
  // Auto-detect by default; opts.eager overrides.
  const eager = opts.eager ?? detectEdgeRuntime();

  // Loud-by-default diagnostics. Silent failure was the most common integration
  // bug on AI builder platforms; these logs surface it the moment it happens.
  logEnabled(projectId, redactMode);
  maybeStartSilenceWarning(projectId);

  return {
    specificationVersion: 'v3',

    async wrapGenerate({ doGenerate, params, model }) {
      const traceId = nanoid();
      const spanId = nanoid();
      const startTime = Date.now();
      try {
        const result = await doGenerate();
        exporter.enqueue(
          buildFromGenerate({
            projectId,
            traceId,
            spanId,
            startTime,
            endTime: Date.now(),
            model,
            params,
            result,
            redactMode,
            metadata: baseMetadata,
          }),
        );
        noteEventEnqueued();
        // In eager mode, await the flush before returning so the trace POST
        // completes before the isolate has a chance to freeze (Workers/Edge).
        if (eager) await exporter.flush();
        return result;
      } catch (error) {
        exporter.enqueue(
          buildErrorEvent({
            projectId,
            traceId,
            spanId,
            startTime,
            endTime: Date.now(),
            model,
            params,
            error,
            redactMode,
            metadata: baseMetadata,
          }),
        );
        noteEventEnqueued();
        if (eager) await exporter.flush();
        throw error;
      }
    },

    async wrapStream({ doStream, params, model }) {
      const traceId = nanoid();
      const spanId = nanoid();
      const startTime = Date.now();

      let upstream: { stream: ReadableStream<StreamPartLike> };
      try {
        upstream = await doStream();
      } catch (error) {
        exporter.enqueue(
          buildErrorEvent({
            projectId,
            traceId,
            spanId,
            startTime,
            endTime: Date.now(),
            model,
            params,
            error,
            redactMode,
            metadata: baseMetadata,
          }),
        );
        noteEventEnqueued();
        if (eager) await exporter.flush();
        throw error;
      }

      const collected: StreamCollector = {
        text: '',
        reasoning: '',
        toolCalls: [],
        usage: undefined,
        finishReason: undefined,
      };

      const tap = new TransformStream<StreamPartLike, StreamPartLike>({
        transform(chunk, controller) {
          collectChunk(chunk, collected);
          controller.enqueue(chunk);
        },
        // `flush` may return a promise — the TransformStream's writable side
        // won't close until it resolves. In eager mode we await the exporter
        // here so the response stream stays open (and the Worker isolate
        // stays alive) until the trace POST completes.
        async flush() {
          exporter.enqueue(
            buildFromStream({
              projectId,
              traceId,
              spanId,
              startTime,
              endTime: Date.now(),
              model,
              params,
              collected,
              redactMode,
              metadata: baseMetadata,
            }),
          );
          noteEventEnqueued();
          if (eager) await exporter.flush();
        },
      });

      return { stream: upstream.stream.pipeThrough(tap) };
    },
  };
}

interface StreamCollector {
  text: string;
  /** Concatenated reasoning text from `reasoning-delta` stream parts. */
  reasoning: string;
  toolCalls: ToolCall[];
  usage: UsageLike | undefined;
  finishReason: string | undefined;
}

function collectChunk(chunk: StreamPartLike, c: StreamCollector): void {
  if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
    c.text += chunk.delta;
    return;
  }
  if (chunk.type === 'reasoning-delta' && typeof chunk.delta === 'string') {
    c.reasoning += chunk.delta;
    return;
  }
  if (chunk.type === 'tool-call') {
    c.toolCalls.push({
      toolCallId: String(chunk.toolCallId ?? ''),
      toolName: String(chunk.toolName ?? ''),
      args: parseJson(chunk.input),
      startTime: Date.now(),
    });
    return;
  }
  if (chunk.type === 'finish') {
    if (typeof chunk.finishReason === 'string') c.finishReason = chunk.finishReason;
    if (chunk.usage) c.usage = chunk.usage;
  }
}

function parseJson(s: string | undefined): unknown {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

interface BuildArgs {
  projectId: string;
  traceId: string;
  spanId: string;
  startTime: number;
  endTime: number;
  model: ModelLike;
  params: ParamsLike;
  redactMode: RedactMode;
  metadata: Record<string, unknown>;
}

function buildFromGenerate(args: BuildArgs & { result: GenerateResultLike }): TraceEvent {
  const { result, model, ...rest } = args;
  const text = (result.content ?? [])
    .filter(
      (c): c is ContentPartLike & { text: string } =>
        c.type === 'text' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('');
  // Reasoning parts (LanguageModelV3ReasoningPart): { type: "reasoning",
  // text: string }. Emitted by providers that expose chain-of-thought —
  // o1, Claude extended thinking, Gemini thinking, etc.
  const reasoning = (result.content ?? [])
    .filter(
      (c): c is ContentPartLike & { text: string } =>
        c.type === 'reasoning' && typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('');
  const toolCalls: ToolCall[] = (result.content ?? [])
    .filter((c) => c.type === 'tool-call')
    .map((c) => ({
      toolCallId: String(c.toolCallId ?? ''),
      toolName: String(c.toolName ?? ''),
      args: redactObject(parseJson(c.input), rest.redactMode),
      startTime: rest.startTime,
    }));

  return {
    projectId: rest.projectId,
    traceId: rest.traceId,
    spanId: rest.spanId,
    startTime: rest.startTime,
    endTime: rest.endTime,
    model: model.modelId ?? '',
    prompt: extractPromptStr(rest.params, rest.redactMode),
    completion: text ? redactObject(text, rest.redactMode) : undefined,
    reasoning: reasoning ? redactObject(reasoning, rest.redactMode) : undefined,
    toolCalls,
    inputTokens: result.usage?.inputTokens?.total,
    outputTokens: result.usage?.outputTokens?.total,
    finishReason: result.finishReason,
    metadata: { ...rest.metadata },
  };
}

function buildFromStream(args: BuildArgs & { collected: StreamCollector }): TraceEvent {
  const { collected, model, ...rest } = args;
  return {
    projectId: rest.projectId,
    traceId: rest.traceId,
    spanId: rest.spanId,
    startTime: rest.startTime,
    endTime: rest.endTime,
    model: model.modelId ?? '',
    prompt: extractPromptStr(rest.params, rest.redactMode),
    completion: collected.text ? redactObject(collected.text, rest.redactMode) : undefined,
    reasoning: collected.reasoning ? redactObject(collected.reasoning, rest.redactMode) : undefined,
    toolCalls: collected.toolCalls.map((tc) => ({
      ...tc,
      args: redactObject(tc.args, rest.redactMode),
      result: redactObject(tc.result, rest.redactMode),
    })),
    inputTokens: collected.usage?.inputTokens?.total,
    outputTokens: collected.usage?.outputTokens?.total,
    finishReason: collected.finishReason,
    metadata: { ...rest.metadata },
  };
}

function buildErrorEvent(args: BuildArgs & { error: unknown }): TraceEvent {
  const err = args.error as { message?: string; name?: string };
  return {
    projectId: args.projectId,
    traceId: args.traceId,
    spanId: args.spanId,
    startTime: args.startTime,
    endTime: args.endTime,
    model: args.model.modelId ?? '',
    prompt: extractPromptStr(args.params, args.redactMode),
    toolCalls: [],
    error: { message: err?.message ?? 'unknown', name: err?.name },
    metadata: { ...args.metadata },
  };
}

function extractPromptStr(params: ParamsLike, mode: RedactMode): string | undefined {
  const value = params.prompt ?? params.messages;
  if (value == null) return undefined;
  return redactObject(JSON.stringify(value), mode);
}
