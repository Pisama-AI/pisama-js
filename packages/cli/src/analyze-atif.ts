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
//
// Two modes:
//   - default: POSTs each trajectory to the Pisama backend's analyze
//     endpoint (the full calibrated detector suite, plus --apply healing).
//     Requires network access and PISAMA_API_KEY.
//   - --local: runs the @pisama/detectors v1 pack (loop, repetition, cost,
//     completion, hallucination, context, derailment) against each
//     trajectory in-process. No network, no API key, no --apply — it's the
//     same simplified subset @pisama/detectors documents itself as
//     (see packages/detectors/README.md), not a replacement for the backend's
//     calibrated suite.
// Both modes render a per-trajectory summary and exit non-zero when any
// critical/high-severity detection fires, detector coverage or trajectory
// topology is incomplete, or a requested fix is absent/failed/rolled back so
// the command is CI-friendly.

import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, basename, dirname, isAbsolute, relative, sep, win32 } from 'node:path';
import kleur from 'kleur';
import { nanoid } from 'nanoid';
import { v1Detectors, type AgentTrace, type ToolEvent } from '@pisama/detectors';
import type { DetectionResult as LocalDetectionResult } from '@pisama/detectors';
import { PlatformAuth, type TokenScope } from './platform-auth.js';

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
  // Run @pisama/detectors' v1 pack locally instead of calling the backend.
  local?: boolean;
}

const DEFAULT_BASE = 'https://api.pisama.ai';
const MAX_CONTINUATION_SEGMENTS = 128;
const MAX_TRAJECTORY_FILES = 1_000;
const ISO_ATIF_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/;

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

type DetectionStatus = 'complete' | 'partial' | 'failed';

interface AnalyzeResponse {
  diagnosis: {
    trace_id: string;
    has_failures: boolean;
    failure_count: number;
    detection_status: DetectionStatus;
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
    topology_complete: boolean;
    unresolved_trajectory_refs: string[];
    client_resolved_trajectory_refs: string[];
    reconciled_topology_complete: boolean;
  };
  healing: {
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

// Minimal shape of an ATIF trajectory (schema_version ATIF-v1.0 through
// v1.7). Only the fields the --local AgentTrace projection and the backend
// POST body need are typed here; unknown fields pass through untouched.
// Source of truth: backend/app/ingestion/atif_models.py in Pisama-AI/pisama.
interface AtifToolCall {
  tool_call_id?: string;
  function_name?: string;
  arguments?: unknown;
}

interface AtifObservationResult {
  source_call_id?: string;
  content?: unknown;
}

interface AtifStepMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
}

interface AtifContentPart {
  type?: string;
  text?: string | null;
  source?: { media_type?: string; path?: string } | null;
}

interface AtifStep {
  step_id?: number;
  timestamp?: string | null;
  source?: string;
  message?: string | AtifContentPart[];
  model_name?: string | null;
  tool_calls?: AtifToolCall[];
  observation?: { results?: AtifObservationResult[] };
  metrics?: AtifStepMetrics;
}

interface AtifTrajectory {
  schema_version?: string | null;
  session_id?: string | null;
  trajectory_id?: string | null;
  continued_trajectory_ref?: string | null;
  agent?: { name?: string; version?: string; model_name?: string | null };
  steps?: AtifStep[];
  subagent_trajectories?: unknown[] | null;
  final_metrics?: {
    total_prompt_tokens?: number | null;
    total_completion_tokens?: number | null;
    total_cost_usd?: number | null;
  } | null;
}

interface HostedSourceIdentity {
  traceId: string;
  schemaVersion: string;
  sessionId: string | null;
  trajectoryId: string | null;
}

interface LoadedTrajectory {
  source: AtifTrajectory;
  submitted: AtifTrajectory;
  traceId: string;
  identity?: HostedSourceIdentity;
}

function anonymousTrajectoryId(raw: Uint8Array): string {
  return `pisama-anonymous-${createHash('sha256')
    .update('pisama:atif:anonymous-source:v1\0', 'utf8')
    .update(raw)
    .digest('hex')}`;
}

function explicitTraceKey(trajectory: AtifTrajectory): string | undefined {
  if (trajectory.session_id) return trajectory.session_id.replace(/-cont-\d+$/, '');
  return trajectory.trajectory_id || undefined;
}

function traceIdFromKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

function parseTrajectory(file: string, raw: string): AtifTrajectory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    fail(`${basename(file)}: not valid JSON (${(error as Error).message})`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`${basename(file)}: trajectory JSON root must be an object`);
  }
  const trajectory = parsed as AtifTrajectory;

  const version = trajectory.schema_version === undefined ? 'ATIF-v1.7' : trajectory.schema_version;
  if (!version || !SUPPORTED_SCHEMA_VERSIONS.has(version)) {
    fail(
      `${basename(file)}: unsupported schema_version ${kleur.red(
        String(version),
      )}. Expected one of: ${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}`,
    );
  }
  return trajectory.schema_version === undefined
    ? { ...trajectory, schema_version: version }
    : trajectory;
}

function decodeUtf8(file: string, bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`${basename(file)}: trajectory file is not valid UTF-8`);
  }
}

function localInputError(file: string, detail: string): never {
  fail(`${basename(file)}: invalid ATIF trajectory for --local (${detail})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedIsoTimestamp(value: string): boolean {
  const match = ISO_ATIF_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const offsetHour = Number(match[8] ?? '0');
  const offsetMinute = Number(match[9] ?? '0');
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateContentParts(file: string, value: unknown, label: string): void {
  if (typeof value === 'string') return;
  if (!Array.isArray(value)) localInputError(file, `${label} must be a string or content array`);
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) localInputError(file, `${label}[${index}] must be an object`);
    if (item['type'] === 'text') {
      if (typeof item['text'] !== 'string' || (item['source'] ?? null) !== null) {
        localInputError(file, `${label}[${index}] is not a valid text content part`);
      }
      continue;
    }
    if (item['type'] === 'image') {
      const source = item['source'];
      if (
        !isRecord(source) ||
        !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(
          String(source['media_type']),
        ) ||
        typeof source['path'] !== 'string' ||
        (item['text'] ?? null) !== null
      ) {
        localInputError(file, `${label}[${index}] is not a valid image content part`);
      }
      continue;
    }
    localInputError(file, `${label}[${index}].type must be text or image`);
  }
}

function validateToolCalls(file: string, value: unknown, index: number): Set<string> {
  const toolCallIds = new Set<string>();
  if (value === undefined || value === null) return toolCallIds;
  if (!Array.isArray(value)) {
    localInputError(file, `steps[${index}].tool_calls must be an array`);
  }
  for (const [toolIndex, tool] of value.entries()) {
    if (
      !isRecord(tool) ||
      typeof tool['tool_call_id'] !== 'string' ||
      typeof tool['function_name'] !== 'string' ||
      !isRecord(tool['arguments'])
    ) {
      localInputError(file, `steps[${index}].tool_calls[${toolIndex}] is invalid`);
    }
    toolCallIds.add(tool['tool_call_id']);
  }
  return toolCallIds;
}

function validateSubagentReferences(file: string, value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) localInputError(file, `${label} must be an array or null`);
  for (const [index, reference] of value.entries()) {
    if (!isRecord(reference)) localInputError(file, `${label}[${index}] must be an object`);
    const trajectoryId = reference['trajectory_id'];
    const trajectoryPath = reference['trajectory_path'];
    for (const [key, candidate] of [
      ['trajectory_id', trajectoryId],
      ['trajectory_path', trajectoryPath],
    ] as const) {
      if (
        candidate !== undefined &&
        candidate !== null &&
        (typeof candidate !== 'string' || candidate.trim().length === 0)
      ) {
        localInputError(file, `${label}[${index}].${key} must be a non-empty string or null`);
      }
    }
    if (!trajectoryId && !trajectoryPath) {
      localInputError(file, `${label}[${index}] must have trajectory_id or trajectory_path`);
    }
  }
}

function validateObservation(
  file: string,
  value: unknown,
  index: number,
  toolCallIds: Set<string>,
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value) || !Array.isArray(value['results'])) {
    localInputError(file, `steps[${index}].observation.results must be an array`);
  }
  for (const [resultIndex, result] of value['results'].entries()) {
    if (!isRecord(result)) {
      localInputError(file, `steps[${index}].observation.results[${resultIndex}] is invalid`);
    }
    const callId = result['source_call_id'];
    if (callId !== undefined && callId !== null && typeof callId !== 'string') {
      localInputError(
        file,
        `steps[${index}].observation.results[${resultIndex}] has invalid source_call_id`,
      );
    }
    if (typeof callId === 'string' && !toolCallIds.has(callId)) {
      localInputError(
        file,
        `steps[${index}].observation.results[${resultIndex}] references an unknown tool call`,
      );
    }
    const content = result['content'];
    if (content !== undefined && content !== null) {
      validateContentParts(
        file,
        content,
        `steps[${index}].observation.results[${resultIndex}].content`,
      );
    }
    validateSubagentReferences(
      file,
      result['subagent_trajectory_ref'],
      `steps[${index}].observation.results[${resultIndex}].subagent_trajectory_ref`,
    );
  }
}

function validateLocalToolData(file: string, step: Record<string, unknown>, index: number): void {
  const toolCallIds = validateToolCalls(file, step['tool_calls'], index);
  validateObservation(file, step['observation'], index, toolCallIds);
}

function validateFiniteMetricObject(file: string, value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) localInputError(file, `${label} must be an object`);
  for (const key of [
    'prompt_tokens',
    'completion_tokens',
    'cached_tokens',
    'total_prompt_tokens',
    'total_completion_tokens',
    'total_cached_tokens',
    'total_steps',
  ]) {
    const metric = value[key];
    if (
      metric !== undefined &&
      metric !== null &&
      (typeof metric !== 'number' || !Number.isFinite(metric) || !Number.isInteger(metric))
    ) {
      localInputError(file, `${label}.${key} must be a finite integer`);
    }
  }
  for (const key of ['cost_usd', 'total_cost_usd']) {
    const metric = value[key];
    if (
      metric !== undefined &&
      metric !== null &&
      (typeof metric !== 'number' || !Number.isFinite(metric))
    ) {
      localInputError(file, `${label}.${key} must be a finite number`);
    }
  }
}

function validateLocalTimestamp(file: string, step: Record<string, unknown>, index: number): void {
  const timestamp = step['timestamp'];
  if (
    timestamp !== undefined &&
    timestamp !== null &&
    (typeof timestamp !== 'string' || !isSupportedIsoTimestamp(timestamp))
  ) {
    localInputError(file, `steps[${index}].timestamp must be an ISO 8601 string or null`);
  }
}

function validateLocalTextFields(file: string, step: Record<string, unknown>, index: number): void {
  for (const key of ['model_name', 'reasoning_content']) {
    const value = step[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      localInputError(file, `steps[${index}].${key} must be a string or null`);
    }
  }
}

function validateLocalReasoningEffort(
  file: string,
  step: Record<string, unknown>,
  index: number,
): void {
  const effort = step['reasoning_effort'];
  if (
    effort !== undefined &&
    effort !== null &&
    typeof effort !== 'string' &&
    (typeof effort !== 'number' || !Number.isFinite(effort))
  ) {
    localInputError(file, `steps[${index}].reasoning_effort must be a string or finite number`);
  }
}

function validateLocalStepCounters(
  file: string,
  step: Record<string, unknown>,
  index: number,
): void {
  const copied = step['is_copied_context'];
  if (copied !== undefined && copied !== null && typeof copied !== 'boolean') {
    localInputError(file, `steps[${index}].is_copied_context must be a boolean or null`);
  }
  const callCount = step['llm_call_count'];
  if (
    callCount !== undefined &&
    callCount !== null &&
    (typeof callCount !== 'number' || !Number.isInteger(callCount) || callCount < 0)
  ) {
    localInputError(file, `steps[${index}].llm_call_count must be a non-negative integer or null`);
  }
}

function validateLocalStepScalars(
  file: string,
  step: Record<string, unknown>,
  index: number,
): void {
  validateLocalTimestamp(file, step, index);
  validateLocalTextFields(file, step, index);
  validateLocalReasoningEffort(file, step, index);
  validateLocalStepCounters(file, step, index);
}

function validateLocalStepRules(file: string, step: Record<string, unknown>, index: number): void {
  const source = step['source'];
  const agentOnly = [
    'model_name',
    'reasoning_effort',
    'reasoning_content',
    'tool_calls',
    'metrics',
  ];
  if (
    source !== 'agent' &&
    agentOnly.some((key) => step[key] !== undefined && step[key] !== null)
  ) {
    localInputError(file, `steps[${index}] uses agent-only fields with source ${String(source)}`);
  }
  if (
    source === 'agent' &&
    step['llm_call_count'] === 0 &&
    ((step['metrics'] !== undefined && step['metrics'] !== null) ||
      (step['reasoning_content'] !== undefined && step['reasoning_content'] !== null))
  ) {
    localInputError(file, `steps[${index}] has metrics or reasoning_content with llm_call_count 0`);
  }
}

function validateLocalStepFields(file: string, step: Record<string, unknown>, index: number): void {
  validateLocalStepScalars(file, step, index);
  validateLocalStepRules(file, step, index);
}

function validateLocalIdentity(file: string, trajectory: AtifTrajectory): void {
  for (const key of ['session_id', 'trajectory_id'] as const) {
    const value = trajectory[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      localInputError(file, `${key} must be a string or null`);
    }
  }
}

function validateLocalAgent(file: string, value: unknown): void {
  if (!isRecord(value)) localInputError(file, 'agent is required');
  if (typeof value['name'] !== 'string' || typeof value['version'] !== 'string') {
    localInputError(file, 'agent.name and agent.version are required strings');
  }
  const model = value['model_name'];
  if (model !== undefined && model !== null && typeof model !== 'string') {
    localInputError(file, 'agent.model_name must be a string or null');
  }
}

function validateLocalSteps(file: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    localInputError(file, 'steps must be a non-empty array');
  }
  for (const [index, step] of value.entries()) {
    if (!isRecord(step)) localInputError(file, `steps[${index}] must be an object`);
    if (step['step_id'] !== index + 1) {
      localInputError(file, `steps[${index}].step_id must be ${index + 1}`);
    }
    if (!['system', 'user', 'agent'].includes(String(step['source']))) {
      localInputError(file, `steps[${index}].source is invalid`);
    }
    validateContentParts(file, step['message'], `steps[${index}].message`);
    validateLocalStepFields(file, step, index);
    validateLocalToolData(file, step, index);
    validateFiniteMetricObject(file, step['metrics'], `steps[${index}].metrics`);
  }
}

function validateLocalTrajectory(file: string, trajectory: AtifTrajectory): void {
  validateLocalIdentity(file, trajectory);
  validateLocalAgent(file, trajectory.agent);
  validateLocalSteps(file, trajectory.steps);
  validateFiniteMetricObject(file, trajectory.final_metrics, 'final_metrics');
  if (
    trajectory.subagent_trajectories !== undefined &&
    trajectory.subagent_trajectories !== null &&
    !Array.isArray(trajectory.subagent_trajectories)
  ) {
    localInputError(file, 'subagent_trajectories must be an array or null');
  }
}

function prepareHostedTrajectory(
  file: string,
  raw: Uint8Array,
  trajectory: AtifTrajectory,
): Required<Pick<LoadedTrajectory, 'submitted' | 'identity'>> {
  const sessionId = trajectory.session_id ?? null;
  const trajectoryId = trajectory.trajectory_id ?? null;
  if (sessionId !== null && typeof sessionId !== 'string') {
    fail(`${basename(file)}: session_id must be a string or null`);
  }
  if (trajectoryId !== null && typeof trajectoryId !== 'string') {
    fail(`${basename(file)}: trajectory_id must be a string or null`);
  }

  // When both optional ATIF identity fields are falsey, bind the exact source
  // bytes to a deterministic, domain-separated trajectory_id before sending.
  // The backend then follows its normal explicit-ID path and echoes that ID,
  // avoiding a fragile reimplementation of Pydantic + Python JSON numeric and
  // Unicode normalization in this Node client.
  const syntheticId = anonymousTrajectoryId(raw);
  const submitted =
    sessionId || trajectoryId ? trajectory : { ...trajectory, trajectory_id: syntheticId };
  const submittedTrajectoryId = submitted.trajectory_id ?? null;
  const key = explicitTraceKey(submitted)!;

  return {
    submitted,
    identity: {
      traceId: traceIdFromKey(key),
      schemaVersion: trajectory.schema_version!,
      sessionId,
      trajectoryId: submittedTrajectoryId,
    },
  };
}

async function loadTrajectories(
  files: string[],
  requireHostedIdentity: boolean,
): Promise<Map<string, LoadedTrajectory>> {
  const trajectories = new Map<string, LoadedTrajectory>();
  for (const file of files) {
    const raw = await readFile(file);
    const source = parseTrajectory(file, decodeUtf8(file, raw));
    if (!requireHostedIdentity) validateLocalTrajectory(file, source);
    const hosted = requireHostedIdentity ? prepareHostedTrajectory(file, raw, source) : undefined;
    const traceId =
      hosted?.identity.traceId ??
      traceIdFromKey(explicitTraceKey(source) ?? anonymousTrajectoryId(raw));
    trajectories.set(file, {
      source,
      submitted: hosted?.submitted ?? source,
      traceId,
      identity: hosted?.identity,
    });
  }
  return trajectories;
}

function toEpochMs(timestamp: string | null | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

function flattenToolCalls(steps: AtifStep[]): ToolEvent[] {
  const toolCalls: ToolEvent[] = [];
  for (const step of steps) {
    const stepTime = toEpochMs(step.timestamp) ?? 0;
    for (const call of step.tool_calls ?? []) {
      const result = step.observation?.results?.find(
        (r) => r.source_call_id === call.tool_call_id,
      )?.content;
      toolCalls.push({
        toolName: call.function_name ?? 'unknown',
        args: call.arguments,
        result,
        startTime: stepTime,
      });
    }
  }
  return toolCalls;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function metricNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function sumStepMetrics(steps: AtifStep[]): TokenTotals {
  return steps.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + metricNumber(s.metrics?.prompt_tokens),
      outputTokens: acc.outputTokens + metricNumber(s.metrics?.completion_tokens),
      costUsd: acc.costUsd + metricNumber(s.metrics?.cost_usd),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
}

// final_metrics is the authoritative total; per-step `metrics` is only a
// fallback for trajectories that omit it. Summing per-step metrics is cheap
// (trajectories are step-bounded), so it's always computed rather than
// gated behind an extra branch.
function resolveTokenTotals(trajectory: AtifTrajectory, steps: AtifStep[]): TokenTotals {
  const final = trajectory.final_metrics;
  const fallback = sumStepMetrics(steps);
  return {
    inputTokens:
      final?.total_prompt_tokens == null
        ? fallback.inputTokens
        : metricNumber(final.total_prompt_tokens),
    outputTokens:
      final?.total_completion_tokens == null
        ? fallback.outputTokens
        : metricNumber(final.total_completion_tokens),
    costUsd: final?.total_cost_usd == null ? fallback.costUsd : metricNumber(final.total_cost_usd),
  };
}

function contentToText(message: string | AtifContentPart[] | undefined): string | undefined {
  if (message === undefined || typeof message === 'string') return message;
  const parts: string[] = [];
  for (const part of message) {
    if (part.type === 'text' && part.text !== null && part.text !== undefined) {
      parts.push(part.text);
    } else if (part.type === 'image' && part.source) {
      parts.push(`[image: ${part.source.media_type} @ ${part.source.path}]`);
    }
  }
  return parts.join('\n');
}

// Projects a multi-step ATIF trajectory down to the flat single-turn
// AgentTrace shape @pisama/detectors' v1 pack understands: the first user
// message as `prompt`, the last agent message as `completion`, every step's
// tool_calls flattened (each result resolved from that step's `observation`
// by tool_call_id) into `toolCalls`, and token/cost totals from
// `final_metrics` (summed from per-step `metrics` when absent). This is a
// real, lossy-on-purpose projection — it lets the loop/repetition/cost/
// completion/hallucination/context/derailment detectors run over a
// trajectory's shape; it does not reconstruct the full multi-step structure
// the backend's ATIF-native detectors see.
function atifTrajectoryToAgentTrace(trajectory: AtifTrajectory, traceId: string): AgentTrace {
  const steps = trajectory.steps ?? [];
  const tokens = resolveTokenTotals(trajectory, steps);

  return {
    traceId,
    startTime: toEpochMs(steps[0]?.timestamp) ?? 0,
    endTime: toEpochMs(steps[steps.length - 1]?.timestamp),
    model: trajectory.agent?.model_name ?? steps.find((s) => s.model_name)?.model_name ?? undefined,
    prompt: contentToText(steps.find((s) => s.source === 'user')?.message),
    completion: contentToText(
      [...steps].reverse().find((s) => s.source === 'agent' && s.message)?.message,
    ),
    toolCalls: flattenToolCalls(steps),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    costUsd: tokens.costUsd,
  };
}

// Mirrors the backend's severity_from_confidence bands (backend/app/detection
// /outcome/base.py), collapsed to the three buckets analyze-atif renders:
// >=0.65 high, >=0.45 medium, else low.
function localSeverityLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 65) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function localDetectionsToApiShape(results: LocalDetectionResult[]): Detection[] {
  return results.map((r) => ({
    category: r.detector,
    confidence: r.severity / 100,
    severity: localSeverityLabel(r.severity),
    title: r.summary,
    description: r.fix,
  }));
}

function buildLocalResponse(
  trajectory: AtifTrajectory,
  trace: AgentTrace,
  results: LocalDetectionResult[],
  detectorsRun: string[],
  detectorsFailed: Record<string, string>,
): AnalyzeResponse {
  const coverageFailures = { ...detectorsFailed };
  if (
    Array.isArray(trajectory.subagent_trajectories) &&
    trajectory.subagent_trajectories.length > 0
  ) {
    coverageFailures['embedded_subagent_analysis'] =
      'local projection does not analyze embedded subagent trajectories';
  }
  const failedCount = Object.keys(coverageFailures).length;
  const topology = sourceTopologyContract(trajectory);
  const topologyComplete = topology.expectedUnresolvedReferences.length === 0;
  return {
    diagnosis: {
      trace_id: trace.traceId,
      has_failures: results.length > 0,
      failure_count: results.length,
      detection_status:
        failedCount === 0 ? 'complete' : detectorsRun.length === 0 ? 'failed' : 'partial',
      all_detections: localDetectionsToApiShape(results),
      detectors_run: detectorsRun,
      detectors_failed: coverageFailures,
    },
    trace: {
      trace_id: trace.traceId,
      // ATIF steps are the actual imported span units. Tool calls are a
      // lossy local-detector projection and can legitimately be empty for a
      // multi-step trajectory, so they must not be presented as span count.
      span_count: trajectory.steps?.length ?? 0,
      total_tokens: (trace.inputTokens ?? 0) + (trace.outputTokens ?? 0),
      atif_schema_version: trajectory.schema_version ?? 'unknown',
      atif_session_id: trajectory.session_id ?? null,
      atif_trajectory_id: trajectory.trajectory_id ?? null,
      topology_complete: topologyComplete,
      unresolved_trajectory_refs: topology.expectedUnresolvedReferences,
      client_resolved_trajectory_refs: [],
      reconciled_topology_complete: topologyComplete,
    },
    healing: null,
  };
}

function analyzeTrajectoryLocally(
  file: string,
  trajectory: AtifTrajectory,
  traceId: string,
): AnalyzeResponse {
  const trace = atifTrajectoryToAgentTrace(trajectory, traceId);
  const results: LocalDetectionResult[] = [];
  const detectorsRun: string[] = [];
  const detectorsFailed: Record<string, string> = {};
  for (const detector of v1Detectors) {
    try {
      const result = detector.detect(trace);
      detectorsRun.push(detector.name);
      if (result.detected) results.push(result);
    } catch {
      detectorsFailed[detector.name] = 'detector execution failed';
    }
  }
  return buildLocalResponse(trajectory, trace, results, detectorsRun, detectorsFailed);
}

function finishAnalysis(
  fileCount: number,
  totalFailures: number,
  incompleteAnalysisFound: boolean,
  blockingSeverityFound: boolean,
  applyFailureFound: boolean,
): void {
  console.log();
  const trajectoryLabel = fileCount === 1 ? 'trajectory' : 'trajectories';
  console.log(
    kleur.bold(`Summary: ${fileCount} ${trajectoryLabel}, ${totalFailures} total detection(s)`),
  );
  if (incompleteAnalysisFound) {
    console.log(
      kleur.red(
        '✗ At least one analysis had incomplete detector or topology evidence. Exiting with code 1.',
      ),
    );
    process.exit(1);
  }
  if (blockingSeverityFound) {
    console.log(
      kleur.red('✗ At least one critical/high-severity detection fired. Exiting with code 1.'),
    );
    process.exit(1);
  }
  if (applyFailureFound) {
    console.log(
      kleur.red('✗ A requested fix was missing, failed, or rolled back. Exiting with code 1.'),
    );
    process.exit(1);
  }
  console.log(kleur.green('✓ No critical/high-severity failures.'));
}

class AnalyzeResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeResponseValidationError';
  }
}

function invalidAnalyzeResponse(message: string): never {
  throw new AnalyzeResponseValidationError(message);
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidAnalyzeResponse(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function responseString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalidAnalyzeResponse(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function responseNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  if (!(key in record)) invalidAnalyzeResponse(`${label}.${key} is required`);
  const value = record[key];
  if (value !== null && typeof value !== 'string') {
    invalidAnalyzeResponse(`${label}.${key} must be a string or null`);
  }
  return value as string | null;
}

function responseCount(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalidAnalyzeResponse(`${label}.${key} must be a non-negative integer`);
  }
  return value;
}

function responseStringArray(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    invalidAnalyzeResponse(`${label}.${key} must be an array of non-empty strings`);
  }
  return value as string[];
}

function responseFailureMap(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, string> {
  const value = responseRecord(record[key], `${label}.${key}`);
  for (const [detector, error] of Object.entries(value)) {
    if (detector.trim().length === 0 || typeof error !== 'string') {
      invalidAnalyzeResponse(`${label}.${key} must map detector names to strings`);
    }
  }
  return value as Record<string, string>;
}

function validateDetection(value: unknown, index: number): Detection {
  const label = `diagnosis.all_detections[${index}]`;
  const record = responseRecord(value, label);
  const category = record['category'] ?? record['detector'] ?? record['detection_type'];
  if (typeof category !== 'string' || category.trim().length === 0) {
    invalidAnalyzeResponse(`${label} must identify a detector category`);
  }
  const detected = record['detected'];
  if (detected !== true) {
    invalidAnalyzeResponse(`${label}.detected must be true`);
  }
  const confidence = record['confidence'];
  if (
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    invalidAnalyzeResponse(`${label}.confidence must be a number from 0 through 1`);
  }
  const severity = responseString(record, 'severity', label).toLowerCase();
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(severity)) {
    invalidAnalyzeResponse(`${label}.severity is unsupported`);
  }
  responseString(record, 'title', label);
  responseString(record, 'description', label);
  return value as Detection;
}

function validateOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): void {
  const value = record[key];
  if (value !== undefined && typeof value !== 'string') {
    invalidAnalyzeResponse(`${label}.${key} must be a string when present`);
  }
}

function validateOptionalNullableStringField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): void {
  const value = record[key];
  if (value !== undefined && value !== null && typeof value !== 'string') {
    invalidAnalyzeResponse(`${label}.${key} must be a string or null when present`);
  }
}

function validateOptionalObjectField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): void {
  const value = record[key];
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'object' || Array.isArray(value))
  ) {
    invalidAnalyzeResponse(`${label}.${key} must be an object or null when present`);
  }
}

function validateHealing(value: unknown): AnalyzeResponse['healing'] {
  if (value === null) return null;
  const record = responseRecord(value, 'healing');
  if (typeof record['success'] !== 'boolean') {
    invalidAnalyzeResponse('healing.success must be a boolean');
  }
  if (record['rolled_back'] !== undefined && typeof record['rolled_back'] !== 'boolean') {
    invalidAnalyzeResponse('healing.rolled_back must be a boolean when present');
  }
  for (const key of ['healing_id', 'fix_type', 'fix_id', 'backup_commit_sha'] as const) {
    validateOptionalStringField(record, key, 'healing');
  }
  for (const key of ['applied_at', 'error'] as const) {
    validateOptionalNullableStringField(record, key, 'healing');
  }
  validateOptionalObjectField(record, 'successor_entity', 'healing');
  return value as AnalyzeResponse['healing'];
}

function validateCoverage(
  status: DetectionStatus,
  detectorsRun: string[],
  detectorsFailed: Record<string, string>,
): void {
  const failedCount = Object.keys(detectorsFailed).length;
  const consistent =
    (status === 'complete' && failedCount === 0 && detectorsRun.length > 0) ||
    (status === 'partial' && failedCount > 0 && detectorsRun.length > 0) ||
    (status === 'failed' && failedCount > 0 && detectorsRun.length === 0);
  if (!consistent) {
    invalidAnalyzeResponse('diagnosis detection status disagrees with detector coverage');
  }
}

function validateDiagnosis(value: unknown): AnalyzeResponse['diagnosis'] {
  const diagnosis = responseRecord(value, 'diagnosis');
  const diagnosisTraceId = responseString(diagnosis, 'trace_id', 'diagnosis');
  if (typeof diagnosis['has_failures'] !== 'boolean') {
    invalidAnalyzeResponse('diagnosis.has_failures must be a boolean');
  }
  const failureCount = responseCount(diagnosis, 'failure_count', 'diagnosis');
  const status = responseString(diagnosis, 'detection_status', 'diagnosis');
  if (!['complete', 'partial', 'failed'].includes(status)) {
    invalidAnalyzeResponse('diagnosis.detection_status must be complete, partial, or failed');
  }
  if (!Array.isArray(diagnosis['all_detections'])) {
    invalidAnalyzeResponse('diagnosis.all_detections must be an array');
  }
  const detections = diagnosis['all_detections'].map(validateDetection);
  if (failureCount !== detections.length) {
    invalidAnalyzeResponse('diagnosis.failure_count must equal all_detections.length');
  }
  if (diagnosis['has_failures'] !== failureCount > 0) {
    invalidAnalyzeResponse('diagnosis.has_failures disagrees with failure_count');
  }
  const detectorsRun = responseStringArray(diagnosis, 'detectors_run', 'diagnosis');
  const detectorsFailed = responseFailureMap(diagnosis, 'detectors_failed', 'diagnosis');
  validateCoverage(status as DetectionStatus, detectorsRun, detectorsFailed);
  return {
    ...(diagnosis as unknown as AnalyzeResponse['diagnosis']),
    trace_id: diagnosisTraceId,
    detection_status: status as DetectionStatus,
    all_detections: detections,
    detectors_run: detectorsRun,
    detectors_failed: detectorsFailed,
  };
}

interface SourceTopologyContract {
  expectedUnresolvedReferences: string[];
  safelyResolvablePathReferences: ReadonlySet<string>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = optionalRecord(item);
    return record ? [record] : [];
  });
}

interface EffectiveTopologyReference {
  target: string;
  isPath: boolean;
}

function unresolvedSubagentReferences(
  document: Record<string, unknown>,
  embeddedIds: ReadonlySet<string>,
): EffectiveTopologyReference[] {
  const unresolved: EffectiveTopologyReference[] = [];
  for (const step of recordArray(document['steps'])) {
    const observation = optionalRecord(step['observation']);
    for (const result of recordArray(observation?.['results'])) {
      for (const reference of recordArray(result['subagent_trajectory_ref'])) {
        const trajectoryId = reference['trajectory_id'];
        const trajectoryPath = reference['trajectory_path'];
        if (typeof trajectoryId === 'string' && embeddedIds.has(trajectoryId)) continue;
        if (typeof trajectoryPath === 'string' && trajectoryPath) {
          unresolved.push({ target: trajectoryPath, isPath: true });
        } else if (typeof trajectoryId === 'string') {
          unresolved.push({ target: trajectoryId, isPath: false });
        }
      }
    }
  }
  return unresolved;
}

function sourceTopologyContract(trajectory: AtifTrajectory): SourceTopologyContract {
  const expectedUnresolvedReferences: string[] = [];
  const allOccurrencesArePaths = new Map<string, boolean>();
  const add = (reference: EffectiveTopologyReference): void => {
    const prior = allOccurrencesArePaths.get(reference.target);
    if (prior === undefined) expectedUnresolvedReferences.push(reference.target);
    allOccurrencesArePaths.set(reference.target, (prior ?? true) && reference.isPath);
  };

  // Mirror backend/app/ingestion/atif_parser.py::_unresolved_trajectory_refs.
  // An immediate embedded child's trajectory_id resolves an ID-bearing ref,
  // even when that ref also carries a path. Otherwise the path wins over the
  // ID. Each embedded document has its own immediate-child resolution scope.
  const collect = (value: unknown): void => {
    const document = optionalRecord(value);
    if (!document) return;
    const embedded = recordArray(document['subagent_trajectories']);
    const embeddedIds = new Set(
      embedded.flatMap((candidate) => {
        const id = candidate['trajectory_id'];
        return typeof id === 'string' ? [id] : [];
      }),
    );
    for (const reference of unresolvedSubagentReferences(document, embeddedIds)) add(reference);

    const continuedReference = document['continued_trajectory_ref'];
    if (typeof continuedReference === 'string' && continuedReference) {
      add({ target: continuedReference, isPath: true });
    }
    for (const child of embedded) collect(child);
  };

  collect(trajectory);
  return {
    expectedUnresolvedReferences,
    safelyResolvablePathReferences: new Set(
      expectedUnresolvedReferences.filter((reference) => allOccurrencesArePaths.get(reference)),
    ),
  };
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function validateSourceTopology(unresolved: string[], contract: SourceTopologyContract): void {
  if (new Set(unresolved).size !== unresolved.length) {
    invalidAnalyzeResponse('trace.unresolved_trajectory_refs must not contain duplicates');
  }
  if (!sameOrderedStrings(unresolved, contract.expectedUnresolvedReferences)) {
    invalidAnalyzeResponse(
      'trace.unresolved_trajectory_refs must exactly match unresolved refs derived from the submitted trajectory',
    );
  }
}

function validateTrace(
  value: unknown,
  diagnosisTraceId: string,
  sourceIdentity: HostedSourceIdentity,
  topologyContract: SourceTopologyContract,
): AnalyzeResponse['trace'] {
  const trace = responseRecord(value, 'trace');
  const traceId = responseString(trace, 'trace_id', 'trace');
  if (traceId !== diagnosisTraceId) {
    invalidAnalyzeResponse('trace.trace_id does not match diagnosis.trace_id');
  }
  if (traceId !== sourceIdentity.traceId) {
    invalidAnalyzeResponse('response trace_id does not match the submitted trajectory identity');
  }
  responseCount(trace, 'span_count', 'trace');
  responseCount(trace, 'total_tokens', 'trace');
  const schemaVersion = responseString(trace, 'atif_schema_version', 'trace');
  const sessionId = responseNullableString(trace, 'atif_session_id', 'trace');
  const trajectoryId = responseNullableString(trace, 'atif_trajectory_id', 'trace');
  if (schemaVersion !== sourceIdentity.schemaVersion) {
    invalidAnalyzeResponse('trace.atif_schema_version does not match the submitted trajectory');
  }
  if (sessionId !== sourceIdentity.sessionId) {
    invalidAnalyzeResponse('trace.atif_session_id does not match the submitted trajectory');
  }
  if (trajectoryId !== sourceIdentity.trajectoryId) {
    invalidAnalyzeResponse('trace.atif_trajectory_id does not match the submitted trajectory');
  }
  if (typeof trace['topology_complete'] !== 'boolean') {
    invalidAnalyzeResponse('trace.topology_complete must be a boolean');
  }
  const unresolved = responseStringArray(trace, 'unresolved_trajectory_refs', 'trace');
  if (trace['topology_complete'] !== (unresolved.length === 0)) {
    invalidAnalyzeResponse('trace.topology_complete disagrees with unresolved_trajectory_refs');
  }
  validateSourceTopology(unresolved, topologyContract);
  return {
    ...(trace as unknown as AnalyzeResponse['trace']),
    unresolved_trajectory_refs: unresolved,
    client_resolved_trajectory_refs: [],
    reconciled_topology_complete: trace['topology_complete'],
  };
}

function validateAnalyzeResponse(
  value: unknown,
  trajectory: AtifTrajectory,
  sourceIdentity: HostedSourceIdentity,
): AnalyzeResponse {
  const root = responseRecord(value, 'response');
  const diagnosis = validateDiagnosis(root['diagnosis']);
  const trace = validateTrace(
    root['trace'],
    diagnosis.trace_id,
    sourceIdentity,
    sourceTopologyContract(trajectory),
  );

  if (!('healing' in root)) invalidAnalyzeResponse('response.healing is required');
  const healing = validateHealing(root['healing']);
  return {
    diagnosis,
    trace,
    healing,
  };
}

async function requestAnalysis(
  file: string,
  baseUrl: string,
  trajectory: AtifTrajectory,
  sourceIdentity: HostedSourceIdentity,
  opts: AnalyzeAtifOptions,
  credentials: Record<string, unknown> | undefined,
  auth: PlatformAuth,
): Promise<AnalyzeResponse> {
  const scope: TokenScope = opts.apply ? 'full' : 'read';
  const requestId = `atif-${nanoid()}`;
  const body = JSON.stringify({
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
  });
  let response: Response;
  try {
    response = await auth.fetch(scope, `${baseUrl}/api/v1/atif/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      body,
    });
  } catch (error) {
    fail(
      `${basename(file)}: authenticated analyze request failed\n` +
        `  ${kleur.dim((error as Error).message)}`,
    );
  }

  if (!response.ok) {
    const body = await safeReadBody(response);
    fail(`${basename(file)}: HTTP ${response.status} from analyze endpoint\n  ${kleur.dim(body)}`);
  }
  try {
    return validateAnalyzeResponse(await response.json(), trajectory, sourceIdentity);
  } catch (error) {
    const reason =
      error instanceof AnalyzeResponseValidationError
        ? error.message
        : 'response body is not valid JSON';
    fail(
      `${basename(file)}: analyze endpoint returned an invalid response\n  ${kleur.dim(reason)}`,
    );
  }
}

async function isSelectedPathReference(
  file: string,
  reference: string,
  submittedFiles: ReadonlySet<string>,
): Promise<boolean> {
  if (isAbsolute(reference) || win32.isAbsolute(reference)) return false;
  try {
    const target = await realpath(resolve(dirname(file), reference));
    return submittedFiles.has(target);
  } catch {
    return false;
  }
}

async function reconcileSubmittedReferences(
  file: string,
  trajectory: AtifTrajectory,
  submittedFiles: ReadonlySet<string>,
  data: AnalyzeResponse,
): Promise<AnalyzeResponse> {
  const contract = sourceTopologyContract(trajectory);
  const resolvedReferences: string[] = [];
  for (const reference of data.trace.unresolved_trajectory_refs) {
    if (!contract.safelyResolvablePathReferences.has(reference)) continue;
    if (await isSelectedPathReference(file, reference, submittedFiles)) {
      resolvedReferences.push(reference);
    }
  }
  if (resolvedReferences.length === 0) return data;

  const resolved = new Set(resolvedReferences);
  const remaining = data.trace.unresolved_trajectory_refs.filter((item) => !resolved.has(item));
  return {
    ...data,
    trace: {
      ...data.trace,
      client_resolved_trajectory_refs: resolvedReferences,
      reconciled_topology_complete: remaining.length === 0,
      unresolved_trajectory_refs: remaining,
    },
  };
}

async function analyzeTrajectory(
  file: string,
  loaded: LoadedTrajectory,
  target: string,
  targetIsDirectory: boolean,
  baseUrl: string,
  opts: AnalyzeAtifOptions,
  credentials: Record<string, unknown> | undefined,
  auth: PlatformAuth | undefined,
  submittedFiles: ReadonlySet<string>,
): Promise<{
  failureCount: number;
  blockingSeverity: boolean;
  analysisIncomplete: boolean;
  applyFailed: boolean;
}> {
  const trajectory = loaded.source;
  const rawData = opts.local
    ? analyzeTrajectoryLocally(file, trajectory, loaded.traceId)
    : await requestAnalysis(
        file,
        baseUrl,
        loaded.submitted,
        loaded.identity!,
        opts,
        credentials,
        auth!,
      );
  const data = await reconcileSubmittedReferences(file, trajectory, submittedFiles, rawData);
  const blockingSeverity = data.diagnosis.all_detections.some((detection) =>
    ['critical', 'high'].includes((detection.severity ?? '').toLowerCase()),
  );
  const applyFailed = Boolean(
    opts.apply && (!data.healing || !data.healing.success || data.healing.rolled_back),
  );
  const analysisIncomplete =
    data.diagnosis.detection_status !== 'complete' ||
    Object.keys(data.diagnosis.detectors_failed).length > 0 ||
    !data.trace.reconciled_topology_complete;
  const label = targetIsDirectory ? relative(target, file) || basename(file) : basename(file);

  renderTrajectorySummary(label, data);
  if (opts.apply && data.healing) renderHealingSummary(data.healing);
  return {
    failureCount: data.diagnosis.failure_count,
    blockingSeverity,
    analysisIncomplete,
    applyFailed,
  };
}

async function authenticateAnalysis(
  opts: AnalyzeAtifOptions,
  baseUrl: string,
): Promise<PlatformAuth | undefined> {
  if (opts.local) return undefined;
  const apiKey = opts.apiKey ?? process.env.PISAMA_API_KEY;
  if (!apiKey) {
    fail('Hosted analysis requires --api-key or PISAMA_API_KEY. Use --local for no network.');
  }
  const auth = new PlatformAuth(baseUrl, apiKey);
  const scope: TokenScope = opts.apply ? 'full' : 'read';
  try {
    await auth.identity(scope);
  } catch (error) {
    fail(`Could not authenticate for ${scope}-scoped ATIF analysis: ${(error as Error).message}`);
  }
  return auth;
}

export async function analyzeAtif(opts: AnalyzeAtifOptions): Promise<void> {
  if (opts.local && opts.apply) {
    fail(
      '--local runs detectors offline and cannot --apply fixes. --apply needs the ' +
        'hosted API to run the unified auto-apply service.',
    );
  }
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
  const trajectories = await loadTrajectories(files, !opts.local);
  const auth = await authenticateAnalysis(opts, baseUrl);
  const targetIsDir = (await stat(target)).isDirectory();
  const labelTarget = targetIsDir ? await realpath(target) : target;
  const submittedFiles = new Set(files);
  step(
    opts.local
      ? `Analyzing ${kleur.bold(String(files.length))} trajector${
          files.length === 1 ? 'y' : 'ies'
        } locally with ${kleur.dim('@pisama/detectors')} (offline, no API key)`
      : `Analyzing ${kleur.bold(String(files.length))} trajector${
          files.length === 1 ? 'y' : 'ies'
        } against ${kleur.dim(baseUrl)}`,
  );

  let blockingSeverityFound = false;
  let incompleteAnalysisFound = false;
  let applyFailureFound = false;
  let totalFailures = 0;

  for (const file of files) {
    const trajectory = trajectories.get(file)!;
    const result = await analyzeTrajectory(
      file,
      trajectory,
      labelTarget,
      targetIsDir,
      baseUrl,
      opts,
      credentials,
      auth,
      submittedFiles,
    );
    totalFailures += result.failureCount;
    blockingSeverityFound ||= result.blockingSeverity;
    incompleteAnalysisFound ||= result.analysisIncomplete;
    applyFailureFound ||= result.applyFailed;
  }

  finishAnalysis(
    files.length,
    totalFailures,
    incompleteAnalysisFound,
    blockingSeverityFound,
    applyFailureFound,
  );
}

async function collectTrajectoryFiles(target: string): Promise<string[]> {
  const st = await stat(target).catch(() => null);
  if (!st) fail(`No such file or directory: ${target}`);
  if (st.isFile()) {
    const boundary = await canonicalDirectory(dirname(target));
    return expandContinuationChains([target], boundary);
  }
  if (st.isDirectory()) {
    const boundary = await canonicalDirectory(target);
    // Three discovery modes, tried in order:
    // 1. Single Harbor trial dir: contains agent/trajectory.json
    // 2. Harbor job-output dir: recursive **/agent/trajectory.json
    //    (and as a fallback, any **/trajectory.json). This must precede the
    //    flat fallback because normal Harbor roots also contain config/result
    //    JSON that are metadata, not trajectories.
    // 3. Flat directory: *.json directly inside, for ad-hoc trajectory sets
    const directTrial = join(target, 'agent', 'trajectory.json');
    if (await fileExists(directTrial)) {
      return expandContinuationChains([directTrial], boundary);
    }

    const recursive = await findTrajectoryFiles(target, 6, boundary);
    if (recursive.length > 0) return expandContinuationChains(recursive.sort(), boundary);

    const entries = await readdir(target);
    const flat = entries
      .filter((name) => name.endsWith('.json') && !isContinuationHelper(name))
      .map((name) => join(target, name));
    if (flat.length > 0) return expandContinuationChains(flat.sort(), boundary);

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

function pathIsWithin(candidate: string, boundary: string): boolean {
  const rel = relative(boundary, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalDirectory(directory: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(directory);
  } catch (error) {
    fail(`Could not resolve ATIF directory ${directory}: ${(error as Error).message}`);
  }
  if (!(await stat(canonical)).isDirectory()) fail(`ATIF path is not a directory: ${directory}`);
  return canonical;
}

function isContinuationHelper(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes('.summarization-') ||
    lower.includes('.trajectory.cont-') ||
    lower.startsWith('trajectory.cont-')
  );
}

async function readContinuationReference(file: string): Promise<string | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    fail(`Could not read ATIF trajectory JSON ${file}: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${basename(file)}: trajectory JSON root must be an object`);
  }
  const reference = (value as Record<string, unknown>)['continued_trajectory_ref'];
  if (reference === undefined || reference === null) return undefined;
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    fail(`ATIF continued_trajectory_ref must be a non-empty string: ${file}`);
  }
  return reference;
}

async function resolveChainRoot(
  root: string,
  selectionBoundary: string,
): Promise<{
  agentDirectory: string;
  trajectory: string;
}> {
  let agentDirectory: string;
  let trajectory: string;
  try {
    agentDirectory = await realpath(dirname(root));
    trajectory = await realpath(root);
  } catch (error) {
    fail(`Could not resolve ATIF trajectory file ${root}: ${(error as Error).message}`);
  }
  if (
    !pathIsWithin(agentDirectory, selectionBoundary) ||
    !pathIsWithin(trajectory, selectionBoundary) ||
    !pathIsWithin(trajectory, agentDirectory) ||
    !(await stat(trajectory)).isFile()
  ) {
    fail(`ATIF trajectory root escapes the selected directory: ${root}`);
  }
  return { agentDirectory, trajectory };
}

async function continuationChain(root: string, selectionBoundary: string): Promise<string[]> {
  const { agentDirectory, trajectory } = await resolveChainRoot(root, selectionBoundary);
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = trajectory;

  while (true) {
    if (!pathIsWithin(current, agentDirectory) || !pathIsWithin(current, selectionBoundary)) {
      fail(`ATIF continued_trajectory_ref escapes the selected agent directory: ${current}`);
    }
    if (seen.has(current)) fail(`ATIF continued_trajectory_ref cycle detected at: ${current}`);
    if (chain.length >= MAX_CONTINUATION_SEGMENTS) {
      fail(`ATIF continuation chain exceeds ${MAX_CONTINUATION_SEGMENTS} segments: ${root}`);
    }
    if (!(await stat(current)).isFile()) fail(`ATIF continuation is not a file: ${current}`);
    seen.add(current);
    chain.push(current);

    const reference = await readContinuationReference(current);
    if (reference === undefined) return chain;
    if (isAbsolute(reference) || win32.isAbsolute(reference)) {
      fail(`ATIF continued_trajectory_ref must be relative: ${JSON.stringify(reference)}`);
    }

    let candidate: string;
    try {
      candidate = resolve(dirname(current), reference);
    } catch (error) {
      fail(
        `Invalid ATIF continued_trajectory_ref ${JSON.stringify(reference)}: ${(error as Error).message}`,
      );
    }
    if (!pathIsWithin(candidate, agentDirectory)) {
      fail(`ATIF continued_trajectory_ref escapes agent directory: ${JSON.stringify(reference)}`);
    }
    try {
      current = await realpath(candidate);
    } catch {
      fail(`Missing ATIF continued_trajectory_ref ${JSON.stringify(reference)} in ${root}`);
    }
  }
}

async function expandContinuationChains(
  roots: string[],
  selectionBoundary: string,
): Promise<string[]> {
  const expanded: string[] = [];
  const emitted = new Set<string>();
  for (const root of roots) {
    for (const file of await continuationChain(root, selectionBoundary)) {
      if (emitted.has(file)) continue;
      if (expanded.length >= MAX_TRAJECTORY_FILES) {
        fail(`ATIF selection exceeds ${MAX_TRAJECTORY_FILES} trajectory files`);
      }
      emitted.add(file);
      expanded.push(file);
    }
  }
  return expanded;
}

async function findTrajectoryFiles(
  root: string,
  maxDepth: number,
  selectionBoundary: string,
): Promise<string[]> {
  // Targeted walk: only follow directories and only collect files named
  // trajectory.json. Caps depth so a misaimed path doesn't churn through
  // a huge tree (Harbor trial trees are 3-4 levels deep, so 6 is generous).
  const out: string[] = [];
  const visitedDirectories = new Set<string>();

  async function descend(directory: string, currentDepth: number): Promise<void> {
    if (currentDepth >= maxDepth) {
      fail(`ATIF discovery exceeds maximum depth ${maxDepth} at ${directory}`);
    }
    await walk(directory, currentDepth + 1);
  }

  async function inspectRelevantSymlink(full: string, name: string, depth: number): Promise<void> {
    let canonical: string;
    let targetStat: Awaited<ReturnType<typeof stat>>;
    try {
      canonical = await realpath(full);
      targetStat = await stat(canonical);
    } catch (error) {
      fail(`Could not resolve ATIF symlink ${full}: ${(error as Error).message}`);
    }
    if (!pathIsWithin(canonical, selectionBoundary)) {
      fail(`ATIF symlink escapes selected directory: ${full}`);
    }
    if (name === 'trajectory.json') {
      if (!targetStat.isFile()) fail(`ATIF trajectory symlink is not a file: ${full}`);
      out.push(full);
      return;
    }
    if (!targetStat.isDirectory()) fail(`ATIF agent symlink is not a directory: ${full}`);
    await descend(full, depth);
  }

  async function walk(dir: string, depth: number): Promise<void> {
    let canonicalDirectoryPath: string;
    try {
      canonicalDirectoryPath = await realpath(dir);
    } catch (error) {
      fail(`Could not resolve ATIF directory ${dir}: ${(error as Error).message}`);
    }
    if (!pathIsWithin(canonicalDirectoryPath, selectionBoundary)) {
      fail(`ATIF directory symlink escapes selected directory: ${dir}`);
    }
    if (visitedDirectories.has(canonicalDirectoryPath)) return;
    visitedDirectories.add(canonicalDirectoryPath);

    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
      })) as unknown as import('node:fs').Dirent[];
    } catch (error) {
      fail(`Could not read ATIF directory ${dir}: ${(error as Error).message}`);
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name === 'trajectory.json') {
        out.push(full);
        continue;
      }
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await descend(full, depth);
        continue;
      }
      if (e.isSymbolicLink() && (e.name === 'agent' || e.name === 'trajectory.json')) {
        await inspectRelevantSymlink(full, e.name, depth);
      }
    }
  }
  await walk(root, 0);
  return out;
}

type Detection = AnalyzeResponse['diagnosis']['all_detections'][number];

function severityColor(severity: string): (value: string) => string {
  if (severity === 'critical' || severity === 'high') return kleur.red;
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

  const failedDetectors = Object.keys(d.detectors_failed);
  const detectorIncomplete = d.detection_status !== 'complete' || failedDetectors.length > 0;
  const topologyIncomplete = !t.reconciled_topology_complete;
  const incomplete = detectorIncomplete || topologyIncomplete;
  if (detectorIncomplete) {
    console.log(
      `  ${kleur.red('✗')} Detection analysis ${d.detection_status}; result is incomplete`,
    );
    if (failedDetectors.length > 0) {
      console.log(`  ${kleur.dim('detectors_failed:')} ${failedDetectors.join(', ')}`);
    }
  }
  if (t.client_resolved_trajectory_refs.length > 0) {
    console.log(
      `  ${kleur.green('✓')} selected trajectory refs: ${t.client_resolved_trajectory_refs.join(', ')}`,
    );
  }
  if (topologyIncomplete) {
    console.log(`  ${kleur.red('✗')} Trajectory topology is incomplete; result is not clean`);
    console.log(
      `  ${kleur.dim('unresolved_trajectory_refs:')} ${t.unresolved_trajectory_refs.join(', ')}`,
    );
  }

  if (d.failure_count === 0) {
    if (incomplete) {
      console.log(`  ${kleur.yellow('!')} 0 confirmed detections returned; result is not clean`);
      return;
    }
    console.log(`  ${kleur.green('✓')} No detections (${d.detectors_run.length} detectors ran)`);
    return;
  }

  console.log(
    `  ${kleur.yellow('!')} ${d.failure_count} detection(s) across ${d.detectors_run.length} detector(s)`,
  );
  const grouped = groupBySeverity(d.all_detections);
  for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
    renderSeverityGroup(severity, grouped.get(severity) ?? []);
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
