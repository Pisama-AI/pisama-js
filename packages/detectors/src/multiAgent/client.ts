/**
 * Shared HTTP client for the MultiAgentDetectors namespace.
 *
 * Pure typed POST client — NO detection logic in TS. Every call round-trips
 * to the Pisama backend, which owns the calibrated detectors.
 *
 * Backend endpoint reality at this prerelease stage: the backend does NOT yet
 * expose discrete `POST /api/v1/detect/{type}` routes for these multi-agent
 * detectors. The orchestrator is reachable via `POST /api/v1/diagnose/why-failed`
 * which takes a full trace and returns ALL detections; we wrap that and filter
 * by category. The B2 batch endpoint `POST /api/v1/diagnose/batch` is being
 * built in parallel for `consensus_collapse`.
 *
 * Follow-up: see TODO in this package's README — backend should add per-type
 * detector routes matching the golden_dataset input shapes so we can drop the
 * wrap-and-filter layer.
 */

export interface MultiAgentClientOptions {
  /** Backend base URL. Defaults to PISAMA_ENDPOINT env or https://api.pisama.ai. */
  endpoint?: string;
  /** API key sent as Authorization: Bearer <key>. Defaults to PISAMA_API_KEY env. */
  apiKey?: string;
  /** Tenant / project id sent as x-pisama-project-id header. */
  projectId?: string;
  /** Request timeout in ms. Defaults to 30_000. */
  timeoutMs?: number;
  /** Inject a custom fetch (for tests, edge runtimes, etc.). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = 'https://api.pisama.ai';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Generic error raised when the backend returns a non-2xx response or the
 * network call itself fails. Carries the HTTP status when available so
 * callers can decide whether to retry.
 */
export class PisamaBackendError extends Error {
  readonly status: number | undefined;
  readonly body: unknown;
  constructor(message: string, status?: number, body?: unknown) {
    super(message);
    this.name = 'PisamaBackendError';
    this.status = status;
    this.body = body;
  }
}

export class MultiAgentClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly projectId: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MultiAgentClientOptions = {}) {
    const envEndpoint = typeof process !== 'undefined' ? process.env.PISAMA_ENDPOINT : undefined;
    this.endpoint = (opts.endpoint ?? envEndpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey =
      opts.apiKey ?? (typeof process !== 'undefined' ? process.env.PISAMA_API_KEY : undefined);
    this.projectId =
      opts.projectId ??
      (typeof process !== 'undefined' ? process.env.PISAMA_PROJECT_ID : undefined);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl =
      opts.fetchImpl ??
      (typeof fetch !== 'undefined'
        ? fetch.bind(globalThis)
        : ((async () => {
            throw new Error('fetch is not available; pass fetchImpl');
          }) as unknown as typeof fetch));
  }

  /**
   * POST JSON to `path` and return the parsed response. Throws
   * `PisamaBackendError` on non-2xx or network failure.
   */
  async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const url = `${this.endpoint}${path.startsWith('/') ? '' : '/'}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    if (this.projectId) headers['x-pisama-project-id'] = this.projectId;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      throw new PisamaBackendError(
        `network error calling ${url}: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      let parsed: unknown = null;
      try {
        parsed = await res.clone().json();
      } catch {
        try {
          parsed = await res.clone().text();
        } catch {
          /* ignore */
        }
      }
      throw new PisamaBackendError(
        `pisama backend ${res.status} ${res.statusText} for ${path}`,
        res.status,
        parsed,
      );
    }

    return (await res.json()) as TResponse;
  }
}
