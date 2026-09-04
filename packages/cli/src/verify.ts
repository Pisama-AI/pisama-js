// `pisama verify` posts a synthetic trace and confirms it round-trips back
// through the API. Catches the failure modes that diagnostic console logs alone
// don't: the SDK might not be loaded at all on the user's machine, the key might
// be wrong, the endpoint might be unreachable.
//
// No SDK dependency — this command operates on the ingest API directly so it
// works even when the SDK is misinstalled or absent.
//
// This command previously used the anonymous project-scoped flow: it POSTed
// `{events:[...]}` to the removed anonymous spans route and read project traces, with
// a project id copied from pisama.ai/install. That entire flow was removed
// server-side in backend commit 517f69bc1 ("Pisama is authenticated-only
// again"). The command is therefore rebuilt on the authenticated
// contract: the raw API key is exchanged for narrowly scoped JWTs at
// /api/v1/auth/token, the trace is sent as OTLP to /api/v1/traces/ingest with
// an ingest token, and it is read back with a separate read token from
// /api/v1/tenants/{tenant_id}/traces.

import { randomBytes } from 'node:crypto';
import kleur from 'kleur';
import { PlatformAuth, PlatformAuthError } from './platform-auth.js';

export interface VerifyOptions {
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE = 'https://api.pisama.ai';
const DEFAULT_DASHBOARD_BASE = 'https://pisama.ai';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function verify(opts: VerifyOptions): Promise<void> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const dashboardBaseUrl = baseUrl === DEFAULT_BASE ? DEFAULT_DASHBOARD_BASE : baseUrl;
  const healthUrl = `${baseUrl}/api/v1/health`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const apiKey = opts.apiKey ?? process.env.PISAMA_API_KEY;
  if (!apiKey) {
    fail(
      'no API key. Pass --api-key or set PISAMA_API_KEY.\n' +
        `  Create one at ${kleur.cyan(`${dashboardBaseUrl}/settings/api-keys`)}`,
    );
  }
  const auth = new PlatformAuth(baseUrl, apiKey);

  step('Resolving tenant from API key...');
  const tenantId = await resolveTenant(auth, baseUrl, dashboardBaseUrl, healthUrl);
  ok(`Tenant: ${kleur.bold(tenantId)}`);

  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  const startNano = BigInt(Date.now()) * 1_000_000n;
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [attr('service.name', 'pisama-cli-verify'), attr('pisama.source', 'cli')],
        },
        scopeSpans: [
          {
            scope: { name: '@pisama/cli' },
            spans: [
              {
                traceId,
                spanId,
                name: 'pisama.verify',
                kind: 1,
                startTimeUnixNano: startNano.toString(),
                endTimeUnixNano: (startNano + 50_000_000n).toString(),
                attributes: [
                  attr('gen_ai.request.model', 'verify-cli'),
                  attr('gen_ai.prompt', 'pisama verify probe'),
                  attr('gen_ai.completion', 'ok'),
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  step(`Sending synthetic trace via ${kleur.dim(baseUrl + '/api/v1/traces/ingest')}...`);
  const requestId = `pisama-cli-${randomBytes(12).toString('hex')}`;
  const postRes = await postTrace(auth, baseUrl, healthUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(payload),
  });
  assertIngestAccepted(postRes, baseUrl, dashboardBaseUrl, healthUrl);
  ok(`Ingest accepted (HTTP ${postRes.status}).`);

  step('Waiting for the trace to surface...');
  const start = Date.now();
  const landed = await pollForTrace(baseUrl, auth, tenantId, traceId, timeoutMs);
  if (!landed) {
    fail(
      `Trace didn't appear within ${Math.round(timeoutMs / 1000)}s.\n` +
        '  POST was accepted but the trace never round-tripped through the API.\n' +
        '  Likely causes:\n' +
        '    the ingest pipeline is backed up, so try a longer --timeout-ms\n' +
        '    the write failed after acceptance (rare)\n' +
        `  Dashboard: ${kleur.cyan(`${dashboardBaseUrl}/dashboard`)}`,
    );
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  ok(`Trace arrived in ${elapsed}s. ${kleur.green('Install is working.')}`);
  console.log(`\n  Dashboard: ${kleur.cyan(`${dashboardBaseUrl}/dashboard`)}\n`);
}

async function resolveTenant(
  auth: PlatformAuth,
  baseUrl: string,
  dashboardBaseUrl: string,
  healthUrl: string,
): Promise<string> {
  try {
    return (await auth.identity('read')).tenantId;
  } catch (error) {
    const authError = error as PlatformAuthError;
    if (authError.status === 401 || authError.status === 403) {
      fail(
        `API key rejected or missing read scope (HTTP ${authError.status}).\n` +
          `  Check the key is current at ${kleur.cyan(`${dashboardBaseUrl}/settings/api-keys`)}`,
      );
    }
    fail(
      `Could not exchange the API key at ${baseUrl}/api/v1/auth/token.\n` +
        `  ${kleur.dim(authError.message ?? String(error))}\n` +
        `  Check ${healthUrl}`,
    );
  }
}

async function postTrace(
  auth: PlatformAuth,
  baseUrl: string,
  healthUrl: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await auth.fetch('ingest', `${baseUrl}/api/v1/traces/ingest`, {
      ...init,
      method: 'POST',
    });
  } catch (err) {
    if (err instanceof PlatformAuthError) {
      fail(
        `Could not exchange the API key for ingest access.\n` +
          `  ${kleur.dim(err.message)}\n` +
          `  Check PISAMA_API_KEY and ${healthUrl}`,
      );
    }
    fail(
      `Could not reach ${baseUrl}/api/v1/traces/ingest.\n` +
        `  ${kleur.dim((err as Error)?.message ?? String(err))}\n` +
        `  Either this machine cannot reach the configured API,\n` +
        `  or the API is unavailable. Check ${healthUrl}`,
    );
  }
}

function assertIngestAccepted(
  postRes: Response,
  baseUrl: string,
  dashboardBaseUrl: string,
  healthUrl: string,
): void {
  if (postRes.status === 401 || postRes.status === 403) {
    fail(
      `Ingest rejected the scoped access token (HTTP ${postRes.status}) after one re-exchange.\n` +
        `  Check the key and ingest scope at ${kleur.cyan(`${dashboardBaseUrl}/settings/api-keys`)}`,
    );
  }
  if (postRes.status === 404) {
    fail(
      `Ingest endpoint not found at ${baseUrl}/api/v1/traces/ingest.\n` +
        '  This CLI version targets the authenticated ingest contract. If you are\n' +
        '  pointing at a self-hosted deployment, it may predate that route.\n' +
        `  Check ${healthUrl}, or upgrade the deployment.`,
    );
  }
  if (!postRes.ok && postRes.status !== 207) {
    fail(
      `Ingest returned HTTP ${postRes.status}. Aborting.\n  If this persists, check ${healthUrl}`,
    );
  }
}

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

async function pollForTrace(
  baseUrl: string,
  auth: PlatformAuth,
  tenantId: string,
  traceId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/traces?per_page=50`;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await auth.fetch('read', url);
    } catch {
      // transient — try again
      await new Promise((resolve) => setTimeout(resolve, 750));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      fail(`Trace readback rejected the read-scoped access token (HTTP ${res.status}).`);
    }
    if (res.ok) {
      const data = (await res.json()) as {
        traces?: Array<{ trace_id?: string; session_id?: string }>;
        items?: Array<{ trace_id?: string; session_id?: string }>;
      };
      const rows = data.traces ?? data.items ?? [];
      if (rows.some((trace) => trace?.trace_id === traceId || trace?.session_id === traceId)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return false;
}

function step(msg: string): void {
  console.log(kleur.cyan('→') + ' ' + msg);
}
function ok(msg: string): void {
  console.log(kleur.green('✓') + ' ' + msg);
}
function fail(msg: string): never {
  console.error(kleur.red('✗') + ' ' + msg);
  process.exit(1);
}
