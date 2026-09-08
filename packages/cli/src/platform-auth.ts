export type TokenScope = 'full' | 'ingest' | 'read';

const DEFAULT_TIMEOUT_MS = 30_000;

interface TokenClaims {
  tenantId: string;
  scope: TokenScope;
}

export class PlatformAuthError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PlatformAuthError';
    this.status = status;
  }
}

/**
 * Exchanges a raw API key for narrowly scoped JWTs. Tokens are cached by
 * scope, and an authenticated request re-exchanges at most once after a 401.
 */
export class PlatformAuth {
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private readonly tokens = new Map<TokenScope, string>();
  private readonly exchanges = new Map<TokenScope, Promise<string>>();

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.tokenUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/auth/token`;
    this.timeoutMs = normaliseTimeout(timeoutMs);
  }

  async identity(
    scope: TokenScope = 'read',
    deadline: number = Date.now() + this.timeoutMs,
  ): Promise<TokenClaims> {
    const claims = decodeClaims(await this.accessToken(scope, deadline));
    return claims;
  }

  async fetch(
    scope: TokenScope,
    input: RequestInfo | URL,
    init: RequestInit = {},
    deadline: number = Date.now() + this.timeoutMs,
  ): Promise<Response> {
    const token = await this.accessToken(scope, deadline);
    let response = await this.fetchOnce(input, init, token, deadline);
    if (response.status === 401) {
      if (this.tokens.get(scope) === token) this.tokens.delete(scope);
      response = await this.fetchOnce(
        input,
        init,
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

    const exchange = this.exchange(scope, deadline);
    this.exchanges.set(scope, exchange);
    try {
      const token = await exchange;
      this.tokens.set(scope, token);
      return token;
    } finally {
      this.exchanges.delete(scope);
    }
  }

  private async exchange(scope: TokenScope, deadline: number): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchWithDeadline(
        this.tokenUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: this.apiKey, scope }),
          redirect: 'error',
        },
        deadline,
      );
    } catch (error) {
      throw new PlatformAuthError(
        `Could not reach ${this.tokenUrl}: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    if (!response.ok) {
      throw new PlatformAuthError(
        `API key exchange returned HTTP ${response.status}.`,
        response.status,
      );
    }
    const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      throw new PlatformAuthError('API key exchange returned no access_token.');
    }
    assertTokenScope(body.access_token, scope);
    return body.access_token;
  }

  private fetchOnce(
    input: RequestInfo | URL,
    init: RequestInit,
    token: string,
    deadline: number,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return this.fetchWithDeadline(input, { ...init, headers, redirect: 'error' }, deadline);
  }

  private async fetchWithDeadline(
    input: RequestInfo | URL,
    init: RequestInit,
    deadline: number,
  ): Promise<Response> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new PlatformAuthError(`Pisama request timed out after ${this.timeoutMs}ms.`);
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new PlatformAuthError(`Pisama request timed out after ${this.timeoutMs}ms.`));
      }, remaining);
    });
    try {
      const request = (async () => {
        const response = await this.fetchImpl(input, { ...init, signal: controller?.signal });
        // Retain the same deadline until the complete response is buffered.
        // Fetch resolves at headers, so leaving json()/text() to callers would
        // allow a peer to hold a CLI command open indefinitely.
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

function normaliseTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('PlatformAuth timeoutMs must be a positive finite number.');
  }
  return Math.max(1, Math.floor(value));
}

function decodeClaims(token: string): TokenClaims {
  try {
    const decoded = decodePayload(token) as {
      tenant_id?: unknown;
      scope?: unknown;
    };
    if (typeof decoded.tenant_id !== 'string' || !decoded.tenant_id) {
      throw new Error('missing tenant_id');
    }
    return {
      tenantId: decoded.tenant_id,
      scope: requireTokenScope(decoded.scope),
    };
  } catch {
    throw new PlatformAuthError(
      'API key exchange returned a token with no usable tenant_id or scope.',
    );
  }
}

function assertTokenScope(token: string, requestedScope: TokenScope): void {
  let scope: TokenScope;
  try {
    const decoded = decodePayload(token) as { scope?: unknown };
    scope = requireTokenScope(decoded.scope);
  } catch {
    throw new PlatformAuthError('API key exchange returned a token with no usable scope.');
  }
  if (scope !== requestedScope && scope !== 'full') {
    throw new PlatformAuthError(
      `API key minted a ${scope}-scoped token, which cannot satisfy ${requestedScope} access.`,
      403,
    );
  }
}

function decodePayload(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('missing payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
}

function requireTokenScope(value: unknown): TokenScope {
  if (value === 'full' || value === 'ingest' || value === 'read') return value;
  throw new Error('missing or unsupported scope');
}
