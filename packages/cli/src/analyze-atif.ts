// `pisama analyze-atif <path>` reads ATIF (Agent Trajectory Interchange
// Format) trajectory JSON files emitted by the Harbor eval framework and
// runs Pisama's failure detectors against them.
//
// Path can be:
//   - a single .json trajectory file
//   - a flat directory of .json trajectories
//   - a Harbor job-output directory (trials are at
//     <job>/<trial>/agent/trajectory.json — see harbor-framework/harbor
//     src/harbor/agents/installed/swe_agent.py and adapters/kumo/README.md)
// The command POSTs each trajectory to the Pisama backend's analyze
// endpoint and renders a per-trajectory summary. Exits non-zero when any
// high-severity detection fires so the command is CI-friendly.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, basename, relative } from 'node:path';
import kleur from 'kleur';

export interface AnalyzeAtifOptions {
  path: string;
  projectId?: string;
  apiKey?: string;
  baseUrl?: string;
  apply?: boolean;
  framework?: string;
  entityId?: string;
  // Either inline JSON ({"instance_url":"..."}) or a path to a .json file.
  credentials?: string;
}

const DEFAULT_BASE = 'https://api.pisama.ai';

// Match the schema_version values supported by Pisama's vendored ATIF
// Pydantic models (backend/app/ingestion/atif_models.py). Keep these in
// sync when bumping the vendor pin.
const SUPPORTED_SCHEMA_VERSIONS = new Set([
  'ATIF-v1.0',
  'ATIF-v1.1',
  'ATIF-v1.2',
  'ATIF-v1.3',
  'ATIF-v1.4',
  'ATIF-v1.5',
  'ATIF-v1.6',
  'ATIF-v1.7',
]);

interface AnalyzeResponse {
  diagnosis: {
    trace_id: string;
    has_failures: boolean;
    failure_count: number;
    detection_status: string;
    all_detections: Array<{
      // Backend's DetectionResult uses `category` (the DetectionCategory
      // enum value), not `detector` — keep both shapes accepted in case
      // the schema is normalized in the future.
      category?: string;
      detector?: string;
      detection_type?: string;
      confidence?: number;
      severity?: string;
      title?: string;
      description?: string;
    }>;
    detectors_run: string[];
    detectors_failed: Record<string, string>;
  };
  trace: {
    trace_id: string;
    span_count: number;
    total_tokens: number;
    atif_schema_version: string;
    atif_session_id: string | null;
    atif_trajectory_id: string | null;
  };
  healing?: {
    success: boolean;
    healing_id?: string;
    fix_type?: string;
    fix_id?: string;
    backup_commit_sha?: string;
    rolled_back?: boolean;
    applied_at?: string | null;
    error?: string | null;
    successor_entity?: Record<string, unknown> | null;
  } | null;
}

async function resolveApplyCredentials(
  opts: AnalyzeAtifOptions,
): Promise<Record<string, unknown> | undefined> {
  if (!opts.apply) return undefined;
  if (!opts.framework) fail('--apply requires --framework <name>');
  if (!opts.entityId) fail('--apply requires --entity-id <id>');
  if (!opts.credentials) {
    fail('--apply requires --credentials (inline JSON or path to a .json file)');
  }
  return loadCredentials(opts.credentials);
}

function parseTrajectory(file: string, raw: string): { schema_version?: string } {
  let trajectory: { schema_version?: string };
  try {
    trajectory = JSON.parse(raw);
  } catch (error) {
    fail(`${basename(file)}: not valid JSON (${(error as Error).message})`);
  }

  const version = trajectory.schema_version;
  if (!version || !SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    fail(
      `${basename(file)}: unsupported schema_version ${kleur.red(
        String(version),
      )}. Expected one of: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`,
    );
  }
  return trajectory;
}

async function requestAnalysis(
  file: string,
  baseUrl: string,
  trajectory: { schema_version?: string },
  opts: AnalyzeAtifOptions,
  credentials: Record<string, unknown> | undefined,
): Promise<AnalyzeResponse> {
  const apiKey = opts.apiKey ?? process.env.PISAMA_API_KEY;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/v1/atif/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // /api/v1/atif/analyze is HTTPBearer-protected. Without this the command
        // 401s for every user and there was no flag to fix it from their side.
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        trajectory,
        ...(opts.projectId ? { project_id: opts.projectId } : {}),
        ...(opts.apply
          ? {
              apply_fix: true,
              framework: opts.framework,
              entity_id: opts.entityId,
              credentials: credentials ?? {},
            }
          : {}),
      }),
    });
  } catch (error) {
    fail(
      `${basename(file)}: could not reach ${baseUrl}/api/v1/atif/analyze\n` +
        `  ${kleur.dim((error as Error).message)}`,
    );
  }

  if (!response.ok) {
    const body = await safeReadBody(response);
    fail(`${basename(file)}: HTTP ${response.status} from analyze endpoint\n  ${kleur.dim(body)}`);
  }
  return (await response.json()) as AnalyzeResponse;
}

async function analyzeTrajectory(
  file: string,
  target: string,
  targetIsDirectory: boolean,
  baseUrl: string,
  opts: AnalyzeAtifOptions,
  credentials: Record<string, unknown> | undefined,
): Promise<{ failureCount: number; highSeverity: boolean }> {
  const trajectory = parseTrajectory(file, await readFile(file, 'utf8'));
  const data = await requestAnalysis(file, baseUrl, trajectory, opts, credentials);
  const highSeverity = data.diagnosis.all_detections.some(
    (detection) => (detection.severity ?? '').toLowerCase() === 'high',
  );
  const label = targetIsDirectory ? relative(target, file) || basename(file) : basename(file);

  renderTrajectorySummary(label, data);
  if (opts.apply && data.healing) renderHealingSummary(data.healing);
  return { failureCount: data.diagnosis.failure_count, highSeverity };
}

export async function analyzeAtif(opts: AnalyzeAtifOptions): Promise<void> {
  const target = resolve(opts.path);
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const credentials = await resolveApplyCredentials(opts);

  const files = await collectTrajectoryFiles(target);
  if (files.length === 0) {
    fail(`No .json trajectory files found at ${kleur.cyan(target)}`);
  }
  if (opts.apply && files.length > 1) {
    fail(
      `--apply is single-trajectory only; ${files.length} files matched. Pass a single .json file.`,
    );
  }
  const targetIsDir = (await stat(target)).isDirectory();
  step(
    `Analyzing ${kleur.bold(String(files.length))} trajector${
      files.length === 1 ? 'y' : 'ies'
    } against ${kleur.dim(baseUrl)}`,
  );

  let highSeverityFound = false;
  let totalFailures = 0;

  for (const file of files) {
    const result = await analyzeTrajectory(file, target, targetIsDir, baseUrl, opts, credentials);
    totalFailures += result.failureCount;
    highSeverityFound ||= result.highSeverity;
  }

  console.log();
  console.log(
    kleur.bold(`Summary: ${files.length} trajectorie(s), ${totalFailures} total detection(s)`),
  );
  if (highSeverityFound) {
    console.log(kleur.red('✗ At least one high-severity detection fired. Exiting with code 1.'));
    process.exit(1);
  }
  console.log(kleur.green('✓ No high-severity failures.'));
}

async function collectTrajectoryFiles(target: string): Promise<string[]> {
  const st = await stat(target).catch(() => null);
  if (!st) fail(`No such file or directory: ${target}`);
  if (st.isFile()) return [target];
  if (st.isDirectory()) {
    // Three discovery modes, tried in order:
    // 1. Single Harbor trial dir: contains agent/trajectory.json
    // 2. Flat directory: *.json directly inside
    // 3. Harbor job-output dir: recursive **/agent/trajectory.json
    //    (and as a fallback, any **/trajectory.json)
    const directTrial = join(target, 'agent', 'trajectory.json');
    if (await fileExists(directTrial)) return [directTrial];

    const entries = await readdir(target);
    const flat = entries.filter((name) => name.endsWith('.json')).map((name) => join(target, name));
    if (flat.length > 0) return flat.sort();

    const recursive = await findTrajectoryFiles(target, 6);
    if (recursive.length > 0) return recursive.sort();

    fail(
      `No trajectories found at ${target}. Looked for: agent/trajectory.json, *.json, **/agent/trajectory.json, **/trajectory.json`,
    );
  }
  fail(`${target} is neither a file nor a directory`);
}

async function fileExists(p: string): Promise<boolean> {
  const st = await stat(p).catch(() => null);
  return !!st && st.isFile();
}

async function findTrajectoryFiles(root: string, maxDepth: number): Promise<string[]> {
  // Targeted walk: only follow directories and only collect files named
  // trajectory.json. Caps depth so a misaimed path doesn't churn through
  // a huge tree (Harbor trial trees are 3-4 levels deep, so 6 is generous).
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
      })) as unknown as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name === 'trajectory.json') out.push(full);
      else if (e.isDirectory() && !e.name.startsWith('.')) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(root, 0);
  return out;
}

type Detection = AnalyzeResponse['diagnosis']['all_detections'][number];

function severityColor(severity: string): (value: string) => string {
  if (severity === 'high') return kleur.red;
  if (severity === 'medium') return kleur.yellow;
  return kleur.cyan;
}

function renderSeverityGroup(severity: string, items: Detection[]): void {
  if (items.length === 0) return;

  const color = severityColor(severity);
  console.log(`    ${color(severity.toUpperCase())} (${items.length}):`);
  for (const item of items.slice(0, 3)) {
    const name = item.category ?? item.detector ?? item.detection_type ?? 'unknown';
    const confidence =
      item.confidence === undefined ? '' : ` (${(item.confidence * 100).toFixed(0)}%)`;
    console.log(`      - ${name}${confidence}  ${kleur.dim(item.title ?? '')}`);
  }
  if (items.length > 3) {
    console.log(`      ${kleur.dim(`... and ${items.length - 3} more`)}`);
  }
}

function renderTrajectorySummary(label: string, data: AnalyzeResponse): void {
  const name = label;
  const t = data.trace;
  const d = data.diagnosis;
  console.log();
  console.log(kleur.bold(name));
  console.log(
    `  ${kleur.dim('trace_id')} ${t.trace_id}  ${kleur.dim('spans')} ${t.span_count}  ${kleur.dim('tokens')} ${t.total_tokens}`,
  );
  console.log(
    `  ${kleur.dim('session')} ${t.atif_session_id ?? '-'}  ${kleur.dim('schema')} ${t.atif_schema_version}`,
  );

  if (d.failure_count === 0) {
    console.log(`  ${kleur.green('✓')} No detections (${d.detectors_run.length} detectors ran)`);
    return;
  }

  console.log(
    `  ${kleur.yellow('!')} ${d.failure_count} detection(s) across ${d.detectors_run.length} detector(s)`,
  );
  const grouped = groupBySeverity(d.all_detections);
  for (const severity of ['high', 'medium', 'low']) {
    renderSeverityGroup(severity, grouped.get(severity) ?? []);
  }

  if (Object.keys(d.detectors_failed).length > 0) {
    console.log(
      `  ${kleur.dim('detectors_failed:')} ${Object.keys(d.detectors_failed).join(', ')}`,
    );
  }
}

function groupBySeverity(
  detections: AnalyzeResponse['diagnosis']['all_detections'],
): Map<string, AnalyzeResponse['diagnosis']['all_detections']> {
  const out = new Map<string, AnalyzeResponse['diagnosis']['all_detections']>();
  for (const d of detections) {
    const sev = (d.severity ?? 'low').toLowerCase();
    const arr = out.get(sev) ?? [];
    arr.push(d);
    out.set(sev, arr);
  }
  return out;
}

async function loadCredentials(input: string): Promise<Record<string, unknown>> {
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      fail(`--credentials JSON is invalid: ${(err as Error).message}`);
    }
  }
  let raw: string;
  try {
    raw = await readFile(resolve(trimmed), 'utf8');
  } catch (err) {
    fail(`--credentials file could not be read: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    fail(`--credentials file is not valid JSON: ${(err as Error).message}`);
  }
}

function renderHealingSummary(healing: NonNullable<AnalyzeResponse['healing']>): void {
  if (healing.success) {
    const tag = healing.rolled_back ? kleur.yellow('⤺ rolled back') : kleur.green('✓ applied');
    console.log(`  ${tag} ${kleur.dim('fix_type')} ${healing.fix_type ?? '?'}`);
    if (healing.healing_id) {
      console.log(`  ${kleur.dim('healing_id')} ${healing.healing_id}`);
    }
    if (healing.backup_commit_sha) {
      console.log(`  ${kleur.dim('backup_sha')} ${healing.backup_commit_sha.slice(0, 12)}`);
    }
    if (healing.successor_entity) {
      const id =
        (healing.successor_entity as { id?: string; agent_id?: string }).id ??
        (healing.successor_entity as { agent_id?: string }).agent_id ??
        '?';
      console.log(`  ${kleur.yellow('successor')} ${id}  ${kleur.dim('(immutable-API rollback)')}`);
    }
  } else {
    console.log(`  ${kleur.red('✗ apply failed')} ${kleur.dim(healing.error ?? 'unknown error')}`);
  }
}

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 400);
  } catch {
    return '<unable to read body>';
  }
}

function step(msg: string): void {
  console.log(kleur.cyan('→') + ' ' + msg);
}
function fail(msg: string): never {
  console.error(kleur.red('✗') + ' ' + msg);
  process.exit(1);
}
