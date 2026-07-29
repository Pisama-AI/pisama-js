// `pisama verify` posts a synthetic trace and confirms it round-trips back
// through the API. Catches the failure modes that diagnostic console logs alone
// don't: the SDK might not be loaded at all on the user's machine, the key might
// be wrong, the endpoint might be unreachable.
//
// No SDK dependency — this command operates on the ingest API directly so it
// works even when the SDK is misinstalled or absent.
//
// This command previously used the anonymous project-scoped flow: it POSTed
// `{events:[...]}` to /api/v1/spans and read /api/v1/projects/{id}/traces, with
// a project id copied from pisama.ai/install. That entire flow was removed
// server-side in backend commit 517f69bc1 ("Pisama is authenticated-only
// again"): both routes now 404, /install is a login wall, and /live/{projectId}
// no longer exists. The command is therefore rebuilt on the authenticated
// contract: an API key resolves a tenant via /api/v1/auth/me, the trace is sent
// as OTLP to /api/v1/traces/ingest, and it is read back from
// /api/v1/tenants/{tenant_id}/traces.

import { randomBytes } from 'node:crypto';
import kleur from 'kleur';

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
  const auth = { authorization: `Bearer ${apiKey}` };

  step('Resolving tenant from API key...');
  const tenantId = await resolveTenant(baseUrl, auth, healthUrl);
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
  let postRes: Response;
  try {
    postRes = await fetch(`${baseUrl}/api/v1/traces/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    fail(
      `Could not reach ${baseUrl}/api/v1/traces/ingest.\n` +
        `  ${kleur.dim((err as Error)?.message ?? String(err))}\n` +
        `  Either this machine cannot reach the configured API,\n` +
        `  or the API is unavailable. Check ${healthUrl}`,
    );
  }

  if (postRes.status === 401 || postRes.status === 403) {
    fail(
      `Ingest rejected the API key (HTTP ${postRes.status}).\n` +
        `  Check the key is current at ${kleur.cyan(`${dashboardBaseUrl}/settings/api-keys`)}`,
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
    fail(`Ingest returned HTTP ${postRes.status}. Aborting.\n  If this persists, check ${healthUrl}`);
  }
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

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

async function resolveTenant(
  baseUrl: string,
  auth: Record<string, string>,
  healthUrl: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: auth });
  } catch (err) {
    fail(
      `Could not reach ${baseUrl}/api/v1/auth/me.\n` +
        `  ${kleur.dim((err as Error)?.message ?? String(err))}\n` +
        `  Check ${healthUrl}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    fail(`API key rejected (HTTP ${res.status}). Check the key is current and not revoked.`);
  }
  if (!res.ok) {
    fail(`Could not resolve tenant: HTTP ${res.status} from /api/v1/auth/me.`);
  }
  const body = (await res.json()) as { tenant_id?: string };
  if (!body?.tenant_id) {
    fail('/api/v1/auth/me returned no tenant_id. This key may not be a tenant-scoped key.');
  }
  return body.tenant_id;
}

async function pollForTrace(
  baseUrl: string,
  auth: Record<string, string>,
  tenantId: string,
  traceId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/traces?per_page=50`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: auth });
      if (res.ok) {
        const data = (await res.json()) as {
          traces?: Array<{ trace_id?: string; session_id?: string }>;
          items?: Array<{ trace_id?: string; session_id?: string }>;
        };
        const rows = data.traces ?? data.items ?? [];
        if (rows.some((t) => t?.trace_id === traceId || t?.session_id === traceId)) {
          return true;
        }
      }
    } catch {
      // transient — try again
    }
    await new Promise((r) => setTimeout(r, 750));
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
