import { nanoid } from 'nanoid';

// Anonymous per-install identifier. Used by the backend to fire
// `sdk_first_run` once per fresh install, then to estimate day-1 / day-7 /
// day-30 retention. No PII is associated with it — it's a random 16-char
// nanoid, persisted to `~/.pisama/client.json` so subsequent runs reuse it.
//
// Persistence is best-effort. On read-only filesystems (Vercel Functions,
// some serverless runtimes) we fall back to a per-process id; that means
// each cold start looks like a new install for retention bucketing. The
// alternative — a long-lived env var the user has to set — adds install
// friction we won't pay for. Documented gap.

let _cached: string | undefined;

function builtin<T>(name: string): T | null {
  try {
    if (typeof process === 'undefined') return null;
    const getBuiltinModule = (
      process as NodeJS.Process & {
        getBuiltinModule?: (id: string) => unknown;
      }
    ).getBuiltinModule;
    return getBuiltinModule ? (getBuiltinModule(name) as T) : null;
  } catch {
    return null;
  }
}

function clientFilePath(): string | null {
  try {
    if (typeof process === 'undefined') return null;
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    const path = builtin<typeof import('node:path')>('node:path');
    if (!path) return null;
    return path.join(home, '.pisama', 'client.json');
  } catch {
    return null;
  }
}

function readPersisted(): string | undefined {
  const file = clientFilePath();
  if (!file) return undefined;
  try {
    const fs = builtin<typeof import('node:fs')>('node:fs');
    if (!fs) return undefined;
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { client_id?: unknown };
    if (typeof parsed.client_id === 'string' && parsed.client_id.length > 0) {
      return parsed.client_id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writePersisted(id: string): void {
  const file = clientFilePath();
  if (!file) return;
  try {
    const fs = builtin<typeof import('node:fs')>('node:fs');
    const path = builtin<typeof import('node:path')>('node:path');
    if (!fs || !path) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ client_id: id, created_at: new Date().toISOString() }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Read-only filesystem, EACCES, etc. — never crash the host process.
  }
}

export function getClientId(): string {
  if (_cached) return _cached;
  const persisted = readPersisted();
  if (persisted) {
    _cached = persisted;
    return _cached;
  }
  const fresh = nanoid(16);
  writePersisted(fresh);
  _cached = fresh;
  return _cached;
}

export function detectRuntime(): 'node' | 'bun' | 'deno' | 'edge' {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') return 'bun';
  if (typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined') return 'deno';
  if (
    typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== 'undefined' ||
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined'
  ) {
    return 'edge';
  }
  return 'node';
}

/** Test-only: clear the in-memory cache so getClientId re-reads the FS. */
export function _resetClientIdCache(): void {
  _cached = undefined;
}
