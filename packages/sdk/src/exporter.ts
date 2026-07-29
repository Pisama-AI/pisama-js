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
        console.log(`[pisama] flushed ${batch.length} event(s), HTTP ${res.status}`);
      }
      this.reportRejectedFlush(res, batch.length);
      await this.reportPartialFlush(res, batch.length, debug);
    } catch (err) {
      this.reportFailure(err, debug);
    }
  }

  // `fetch` does not throw on HTTP error statuses, and the batch has already been
  // spliced out of the buffer by the time we get here. Without this, a rejected
  // flush is discarded in complete silence: the caller believes telemetry is
  // working while nothing is being delivered. That is exactly what happened when
  // the hosted ingest route was removed server-side, and it went unnoticed because
  // only HTTP 207 was ever inspected.
  private reportRejectedFlush(res: Response, droppedCount: number): void {
    if (res.ok || res.status === 207 || isSilent()) return;

    if (res.status === 404) {
      console.warn(
        `[pisama] ingest endpoint not found (HTTP 404) at ${this.endpoint}. ` +
          `${droppedCount} event(s) dropped. This SDK version targets an ingest route ` +
          `that the configured host does not serve. Point PISAMA_INGEST_URL at a ` +
          `deployment that does, or upgrade @pisama/sdk.`,
      );
      return;
    }
    if (res.status === 401 || res.status === 403) {
      console.warn(
        `[pisama] ingest rejected the request (HTTP ${res.status}) at ${this.endpoint}. ` +
          `${droppedCount} event(s) dropped. The configured host requires credentials ` +
          `this SDK version does not send.`,
      );
      return;
    }
    console.warn(
      `[pisama] ingest returned HTTP ${res.status} at ${this.endpoint}. ` +
        `${droppedCount} event(s) dropped.`,
    );
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
