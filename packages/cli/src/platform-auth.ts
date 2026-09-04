export type TokenScope = 'full' | 'ingest' | 'read';

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
  private readonly tokens = new Map<TokenScope, string>();
  private readonly exchanges = new Map<TokenScope, Promise<string>>();

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.tokenUrl = `${baseUrl.replace(/\/$/, '')}/api/v1/auth/token`;
  }

  async identity(scope: TokenScope = 'read'): Promise<TokenClaims> {
    const claims = decodeClaims(await this.accessToken(scope));
    return claims;
  }

  async fetch(
    scope: TokenScope,
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.accessToken(scope);
    let response = await this.fetchOnce(input, init, token);
    if (response.status === 401) {
      if (this.tokens.get(scope) === token) this.tokens.delete(scope);
      response = await this.fetchOnce(input, init, await this.accessToken(scope));
    }
    return response;
  }

  private async accessToken(scope: TokenScope): Promise<string> {
    const cached = this.tokens.get(scope);
    if (cached) return cached;
    const active = this.exchanges.get(scope);
    if (active) return active;

    const exchange = this.exchange(scope);
    this.exchanges.set(scope, exchange);
    try {
      const token = await exchange;
      this.tokens.set(scope, token);
      return token;
    } finally {
      this.exchanges.delete(scope);
    }
  }

  private async exchange(scope: TokenScope): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.apiKey, scope }),
        redirect: 'error',
      });
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

  private fetchOnce(input: RequestInfo | URL, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return this.fetchImpl(input, { ...init, headers, redirect: 'error' });
  }
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
