// Loud-by-default diagnostics. Silent-failure is the most common integration
// problem on AI builder platforms: the wrap gets misapplied, no traces fire,
// and the user has no signal because chat completions still work. These logs
// give them a signal.
//
// Three verbosity levels via env vars:
//   default        → one "enabled" log per project, one warning if no
//                    events fire within 30s
//   PISAMA_DEBUG=1 → also log every flush with HTTP status
//   PISAMA_SILENT=1 → suppress every log/warn (does not affect egress)
//   PISAMA_TELEMETRY=false → master kill switch (no events sent, no headers)
//
// The 30s warning is the load-bearing one. It catches:
//   • model not actually wrapped (most common)
//   • wrap is in a file that's never imported by the chat route
//   • PISAMA_PROJECT_ID env var doesn't reach the server runtime
//   • the hosted ingest route /api/v1/spans is not currently served (404)

import type { RedactMode } from './redact.js';

const WARN_AFTER_MS = 30_000;

const _loggedProjects = new Set<string>();
let _eventCount = 0;
let _warningStarted = false;
let _warningFired = false;

export function isSilent(): boolean {
  return typeof process !== 'undefined' && process.env.PISAMA_SILENT === '1';
}

export function isDebug(): boolean {
  return typeof process !== 'undefined' && process.env.PISAMA_DEBUG === '1';
}

export function isTelemetryDisabled(): boolean {
  return typeof process !== 'undefined' && process.env.PISAMA_TELEMETRY === 'false';
}

export function logEnabled(projectId: string, redactMode: RedactMode): void {
  if (isSilent() || _loggedProjects.has(projectId)) return;
  _loggedProjects.add(projectId);
  // Short project id prefix is fine; full id is in the URL the user already has.
  console.log(`[pisama] enabled · project=${projectId.slice(0, 12)}… · redact=${redactMode}`);
}

export function noteEventEnqueued(): void {
  _eventCount++;
}

export function maybeStartSilenceWarning(
  projectId: string,
  /** Override for tests. */
  delayMs: number = WARN_AFTER_MS,
): void {
  if (_warningStarted || isSilent()) return;
  _warningStarted = true;
  const timer = setTimeout(() => {
    if (_eventCount === 0 && !_warningFired) {
      _warningFired = true;
      console.warn(
        '[pisama] No events fired in 30s. Common causes:\n' +
          "  • model isn't wrapped — use observe(model, opts) from @pisama/sdk\n" +
          "  • the wrap is in a file that isn't imported by your chat route\n" +
          "  • PISAMA_PROJECT_ID env var isn't reaching your server runtime\n" +
          '  • the hosted ingest route /api/v1/spans is not currently served (404)\n' +
          `Set PISAMA_INGEST_URL to a deployment that serves this contract.\n` +
          `  project: ${projectId}`,
      );
    }
  }, delayMs);
  // Never hold the process open for this.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

/** Test-only: reset module state between tests. */
export function _resetDiagnostics(): void {
  _loggedProjects.clear();
  _eventCount = 0;
  _warningStarted = false;
  _warningFired = false;
}
