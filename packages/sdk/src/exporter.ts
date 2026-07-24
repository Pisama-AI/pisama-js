import type { TraceEvent } from './types.js';
import { isDebug, isSilent, isTelemetryDisabled } from './diagnostics.js';
import { getClientId, detectRuntime } from './client-id.js';
import { SDK_VERSION } from './version.js';

export interface ExporterOptions {
  endpoint?: string;
  projectId: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  fetchImpl?: typeof fetch;
}

const HOSTED_ENDPOINT = 'https://api.pisama.ai/api/v1/spans';

interface PartialFlushBody {
  accepted?: number;
  submitted?: number;
  failed?: Array<{ traceId: string; reason: string }>;
}

function defaultEndpoint(): string {
  if (typeof process !== 'undefined' && process.env.PISAMA_INGEST_URL) {
    return process.env.PISAMA_INGEST_URL;
  }
  return HOSTED_ENDPOINT;
}

export class TraceExporter {
  private buffer: TraceEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly endpoint: string;
  private readonly projectId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ExporterOptions) {
    this.endpoint = opts.endpoint ?? defaultEndpoint();
    this.projectId = opts.projectId;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.maxBatchSize = opts.maxBatchSize ?? 32;
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

    const debug = isDebug();
    try {
      const res = await this.send(batch);
      if (debug) {
        console.log(`[pisama] flushed ${batch.length} event(s) → HTTP ${res.status}`);
      }
      await this.reportPartialFlush(res, batch.length, debug);
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

  private send(batch: TraceEvent[]): Promise<Response> {
    return this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pisama-project-id': this.projectId,
        'x-pisama-client-id': getClientId(),
        'x-pisama-sdk-version': SDK_VERSION,
        'x-pisama-runtime': detectRuntime(),
      },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  }

  private async reportPartialFlush(
    res: Response,
    submittedCount: number,
    debug: boolean,
  ): Promise<void> {
    // HTTP 207 means some events were dropped. This must never be silent.
    if (res.status !== 207 || isSilent()) return;

    try {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as PartialFlushBody | null;
      const failed = body?.failed ?? [];
      const accepted = body?.accepted ?? '?';
      const submitted = body?.submitted ?? submittedCount;
      console.warn(
        `[pisama] partial flush: ${accepted}/${submitted} accepted, ${failed.length} dropped`,
      );
      if (debug) {
        for (const failure of failed) {
          console.warn(`[pisama]   - traceId=${failure.traceId} reason=${failure.reason}`);
        }
      }
    } catch {
      if (debug) {
        console.warn(`[pisama] partial flush (HTTP 207) but response body could not be parsed`);
      }
    }
  }

  private reportFailure(error: unknown, debug: boolean): void {
    // Telemetry must never break the host app. Debug mode surfaces blocked
    // network egress and other configuration failures.
    if (debug) {
      console.warn(
        `[pisama] flush failed (suppressed in production):`,
        (error as Error)?.message ?? error,
      );
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
