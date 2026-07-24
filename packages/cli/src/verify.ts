// `pisama verify` posts a synthetic trace and confirms it round-trips back
// through the live dashboard. Catches the failure modes that diagnostic
// console logs alone don't: the SDK might not be loaded at all on the user's
// machine, the env var might be wrong, the endpoint might be unreachable.
//
// No SDK dependency — this command operates on the ingest API directly so it
// works even when the SDK is misinstalled or absent.

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import kleur from 'kleur';
import { nanoid } from 'nanoid';

export interface VerifyOptions {
  cwd: string;
  projectId?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE = 'https://api.pisama.ai';
const DEFAULT_DASHBOARD_BASE = 'https://pisama.ai';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function verify(opts: VerifyOptions): Promise<void> {
  const root = resolve(opts.cwd);
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const dashboardBaseUrl = opts.baseUrl ? baseUrl : DEFAULT_DASHBOARD_BASE;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  step('Looking up project id...');
  const resolved = await resolveProjectId(root, opts.projectId);
  if (!resolved) {
    fail(
      'no project id. Pass --project-id ws_xxx, set PISAMA_PROJECT_ID, or paste\n' +
        `  the line from ${kleur.cyan('https://pisama.ai/install')} into your .env.local`,
    );
  }
  const { projectId, source } = resolved;
  ok(`Project ID: ${kleur.bold(projectId)} (from ${source})`);

  const traceId = `verify-${nanoid(12)}`;
  const now = Date.now();
  const event = {
    projectId,
    traceId,
    spanId: `span-${nanoid(8)}`,
    startTime: now,
    endTime: now + 50,
    model: 'verify-cli',
    prompt: 'pisama verify probe',
    completion: 'ok',
    toolCalls: [],
    inputTokens: 1,
    outputTokens: 1,
    finishReason: 'stop',
    metadata: { source: '@pisama/cli verify' },
  };

  step(`Sending synthetic trace via ${kleur.dim(baseUrl + '/api/v1/spans')}...`);

  let postRes: Response;
  try {
    postRes = await fetch(`${baseUrl}/api/v1/spans`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pisama-project-id': projectId,
      },
      body: JSON.stringify({ events: [event] }),
    });
  } catch (err) {
    fail(
      `Could not reach ${baseUrl}/api/v1/spans.\n` +
        `  ${kleur.dim((err as Error)?.message ?? String(err))}\n` +
        `  Either this machine has no network egress to pisama.ai,\n` +
        `  or pisama.ai itself is down. Check https://pisama.ai/status`,
    );
  }

  if (!postRes.ok && postRes.status !== 207) {
    fail(
      `Ingest returned HTTP ${postRes.status}. Aborting.\n` +
        `  If this persists, check https://pisama.ai/status`,
    );
  }
  ok(`Ingest accepted (HTTP ${postRes.status}).`);

  step(`Waiting for trace to surface on /live/${projectId}...`);
  const start = Date.now();
  const landedAt = await pollForTrace(baseUrl, projectId, traceId, timeoutMs);
  if (landedAt === null) {
    fail(
      `Trace didn't appear within ${Math.round(timeoutMs / 1000)}s.\n` +
        '  POST was accepted but the trace never round-tripped through the dashboard.\n' +
        '  Likely causes:\n' +
        "    • the project id is malformed or doesn't match what /install gave you\n" +
        '    • Postgres write failed silently (very rare — check pisama status)\n' +
        `  Try: ${kleur.cyan('pisama verify --project-id ws_<copy-from-install-page>')}`,
    );
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  ok(`Trace arrived in ${elapsed}s. ${kleur.green('Install is working.')}`);
  console.log(`\n  Dashboard: ${kleur.cyan(`${dashboardBaseUrl}/live/${projectId}`)}\n`);
}

async function pollForTrace(
  baseUrl: string,
  projectId: string,
  traceId: string,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  // Pisama backend (api.pisama.ai) read endpoint shape:
  //   GET /api/v1/projects/{project_id}/traces?limit=N
  //   → { project_id, is_claimed, traces: [{ trace_id, session_id, ... }] }
  // The verify POST writes a Trace with session_id = the synthetic
  // traceId we sent, so we match on session_id.
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/traces?limit=20`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as {
          traces?: Array<{ session_id?: string }>;
        };
        const traces = data.traces ?? [];
        if (traces.some((t) => t?.session_id === traceId)) {
          return Date.now();
        }
      }
    } catch {
      // transient — try again
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  return null;
}

async function resolveProjectId(
  root: string,
  override: string | undefined,
): Promise<{ projectId: string; source: string } | null> {
  if (override) return { projectId: override, source: '--project-id flag' };
  const pisamaVar = process.env.PISAMA_PROJECT_ID;
  if (pisamaVar) return { projectId: pisamaVar, source: 'PISAMA_PROJECT_ID env' };
  // Last resort: scan .env.local in cwd.
  const envPath = join(root, '.env.local');
  try {
    const contents = await readFile(envPath, 'utf8');
    const match = contents.match(/^\s*PISAMA_PROJECT_ID\s*=\s*['"]?([^'"\s]+)/m);
    if (match && match[1]) {
      return { projectId: match[1], source: '.env.local' };
    }
  } catch {
    // file doesn't exist
  }
  return null;
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
