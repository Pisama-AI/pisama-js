/**
 * Shared HTTP client for the MultiAgentDetectors namespace.
 *
 * Pure typed POST client. No detection logic runs in TS. Every call round-trips
 * to the Pisama backend, which owns the calibrated detectors.
 *
 * The backend exposes one authenticated contract per supported multi-agent
 * detector under `/api/v1/diagnose/multi-agent/{detector}`. Each accepts a raw
 * span payload and returns only that detector's result, avoiding the full
 * diagnosis pipeline's cross-category subsumption rules.
 */

export interface MultiAgentClientOptions {
  /** Backend base URL. Defaults to PISAMA_ENDPOINT env or https://api.pisama.ai. */
  endpoint?: string;
  /** API key exchanged for a short-lived JWT. The raw key is never used as bearer auth. */
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
type TokenScope = 'full' | 'ingest' | 'read';

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
  private readonly tokens = new Map<TokenScope, string>();
  private readonly exchanges = new Map<TokenScope, Promise<string>>();

  constructor(opts: MultiAgentClientOptions = {}) {
    const envEndpoint = typeof process !== 'undefined' ? process.env.PISAMA_ENDPOINT : undefined;
    this.endpoint = (opts.endpoint ?? envEndpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey =
      opts.apiKey ?? (typeof process !== 'undefined' ? process.env.PISAMA_API_KEY : undefined);
    this.projectId =
      opts.projectId ??
      (typeof process !== 'undefined' ? process.env.PISAMA_PROJECT_ID : undefined);
    this.timeoutMs = normaliseTimeout(opts.timeoutMs);
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
    if (!this.apiKey) {
      throw new PisamaBackendError(
        'PISAMA_API_KEY or apiKey is required; no network request was made.',
      );
    }
    const url = `${this.endpoint}${path.startsWith('/') ? '' : '/'}${path}`;
    const serializedBody = JSON.stringify(body);
    const requestId = createRequestId();
    const deadline = Date.now() + this.timeoutMs;

    let res: Response;
    try {
      res = await this.sendAuthenticated(url, serializedBody, requestId, deadline);
    } catch (err) {
      if (err instanceof PisamaBackendError) throw err;
      throw new PisamaBackendError(
        `network error calling ${url}: ${(err as Error)?.message ?? err}`,
      );
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

  private async sendAuthenticated(
    url: string,
    body: string,
    requestId: string,
    deadline: number,
  ): Promise<Response> {
    const scope: TokenScope = 'full';
    const token = await this.accessToken(scope, deadline);
    let response = await this.sendOnce(url, body, requestId, token, deadline);
    if (response.status === 401) {
      // Invalidate only the JWT used by this request. A concurrent request may
      // already have installed a fresh JWT after seeing the same stale token.
      if (this.tokens.get(scope) === token) this.tokens.delete(scope);
      response = await this.sendOnce(
        url,
        body,
        requestId,
        await this.accessToken(scope, deadline),
        deadline,
      );
    }
    return response;
  }

  private async accessToken(scope: TokenScope, deadline: number): Promise<string> {
    const cached = this.tokens.get(scope);
    if (cached) return cached;
    const active = this.exchanges.get(scope);
    if (active) return active;

    const exchange = this.exchangeToken(scope, deadline);
    this.exchanges.set(scope, exchange);
    try {
      const token = await exchange;
      this.tokens.set(scope, token);
      return token;
    } finally {
      this.exchanges.delete(scope);
    }
  }

  private async exchangeToken(scope: TokenScope, deadline: number): Promise<string> {
    const response = await this.fetchWithDeadline(
      `${this.endpoint}/api/v1/auth/token`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ api_key: this.apiKey, scope }),
        redirect: 'error',
      },
      deadline,
    );
    if (!response.ok) {
      throw new PisamaBackendError(
        `pisama API-key exchange failed with HTTP ${response.status}`,
        response.status,
        await parseResponseBody(response),
      );
    }
    const payload = (await response.json()) as { access_token?: unknown };
    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      throw new PisamaBackendError('pisama API-key exchange returned no access_token');
    }
    assertTokenScope(payload.access_token, scope);
    return payload.access_token;
  }

  private async sendOnce(
    url: string,
    body: string,
    requestId: string,
    token: string,
    deadline: number,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    };
    if (this.projectId) headers['x-pisama-project-id'] = this.projectId;

    return this.fetchWithDeadline(
      url,
      {
        method: 'POST',
        headers,
        body,
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
    if (remaining <= 0) throw new Error(`request timed out after ${this.timeoutMs}ms`);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error(`request timed out after ${this.timeoutMs}ms`));
      }, remaining);
    });
    try {
      const request = (async () => {
        const response = await this.fetchImpl(input, { ...init, signal: controller?.signal });
        // Keep the transport deadline active until the body is buffered. A
        // server that resolves headers but stalls JSON must not hang callers.
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
}

function normaliseTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  return Math.max(1, Math.floor(timeout));
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
    throw new PisamaBackendError('pisama API-key exchange returned a token with no usable scope');
  }
  if (scope !== requestedScope && scope !== 'full') {
    throw new PisamaBackendError(
      `pisama API-key exchange returned a ${scope}-scoped token that cannot satisfy ${requestedScope} access`,
      403,
    );
  }
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `pisama-detect-${globalThis.crypto.randomUUID()}`;
  }
  return `pisama-detect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      return await response.clone().text();
    } catch {
      return null;
    }
  }
}
