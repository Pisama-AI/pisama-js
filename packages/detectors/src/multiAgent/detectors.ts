/**
 * MultiAgentDetectors — typed clients for the backend's multi-agent failure
 * detector suite categories currently exposed by the diagnose endpoint
 * (coordination and persona_drift).
 *
 * The TS side does NO detection. Each function:
 *   1. Validates / normalises the typed input.
 *   2. Serialises it into a `raw` trace payload the backend understands.
 *   3. POSTs to the authenticated `/api/v1/diagnose/multi-agent/{detector}`
 *      contract, which runs exactly one real backend detector.
 *   4. Projects the resulting `all_detections` entry for the category and
 *      returns a single typed result. If the backend produced no detection
 *      for that supported category, we return a `detected: false` result.
 *
 * Unsupported operations (tracked in README):
 *   - `delegation` and `consensus_collapse` are evaluated elsewhere in the
 *     backend but are NOT mapped to a category returned by this endpoint.
 *     They are deliberately absent from this public client so unsupported
 *     operations can never be mistaken for clean detector results.
 */

import { MultiAgentClient, PisamaBackendError, type MultiAgentClientOptions } from './client.js';
import type {
  CoordinationInput,
  CoordinationResult,
  MultiAgentDetection,
  MultiAgentSeverity,
  PersonaInput,
  PersonaResult,
} from './types.js';

const COORDINATION_PATH = '/api/v1/diagnose/multi-agent/coordination';
const PERSONA_PATH = '/api/v1/diagnose/multi-agent/persona_drift';

interface DiagnoseDetectionRaw {
  category: string;
  detected: boolean;
  confidence: number;
  severity: string;
  title: string;
  description: string;
  evidence?: Array<Record<string, unknown>>;
  affected_spans?: string[];
  suggested_fix?: string | null;
}

interface DiagnoseRequestBody {
  content: string;
}

function isSeverity(value: unknown): value is MultiAgentSeverity {
  return (
    value === 'critical' ||
    value === 'high' ||
    value === 'medium' ||
    value === 'low' ||
    value === 'info'
  );
}

function projectDetection(raw: DiagnoseDetectionRaw): MultiAgentDetection {
  return {
    category: raw.category,
    detected: raw.detected,
    confidence: raw.confidence,
    severity: raw.severity as MultiAgentSeverity,
    title: raw.title,
    description: raw.description,
    evidence: raw.evidence ?? [],
    affectedSpans: raw.affected_spans ?? [],
    suggestedFix: raw.suggested_fix ?? null,
  };
}

function invalidResponse(reason: string): never {
  throw new PisamaBackendError(`invalid Pisama multi-agent response: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalidResponse(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalidResponse(`${label} must be a string`);
  return value;
}

function requireConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalidResponse('confidence must be a finite number between 0 and 1');
  }
  if (value < 0 || value > 1) {
    invalidResponse('confidence must be a finite number between 0 and 1');
  }
  return value;
}

function requireEvidence(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) invalidResponse('evidence must be an array of objects');
  if (!value.every(isRecord)) invalidResponse('evidence must be an array of objects');
  return value;
}

function requireAffectedSpans(value: unknown): string[] {
  if (!Array.isArray(value)) invalidResponse('affected_spans must be an array of strings');
  if (!value.every((span) => typeof span === 'string')) {
    invalidResponse('affected_spans must be an array of strings');
  }
  return value;
}

function requireSuggestedFix(value: unknown): string | null {
  if (value === null || typeof value === 'string') return value;
  return invalidResponse('suggested_fix must be a string or null');
}

function validateDetection(
  value: unknown,
  category: MultiAgentDetection['category'],
): DiagnoseDetectionRaw {
  const raw = requireRecord(value, 'detection');
  if (raw['category'] !== category) invalidResponse(`expected category ${category}`);
  if (raw['detected'] !== true) {
    invalidResponse('a non-empty detection must have detected=true');
  }
  if (!isSeverity(raw['severity'])) invalidResponse('severity is unsupported');
  return {
    category,
    detected: true,
    confidence: requireConfidence(raw['confidence']),
    severity: raw['severity'],
    title: requireString(raw['title'], 'title'),
    description: requireString(raw['description'], 'description'),
    evidence: requireEvidence(raw['evidence']),
    affected_spans: requireAffectedSpans(raw['affected_spans']),
    suggested_fix: requireSuggestedFix(raw['suggested_fix']),
  };
}

function validateResponse(
  value: unknown,
  category: MultiAgentDetection['category'],
  expectedTraceId: string,
): DiagnoseDetectionRaw | undefined {
  const response = requireRecord(value, 'response');
  if (response['trace_id'] !== expectedTraceId) {
    invalidResponse('trace_id does not match the submitted trace');
  }
  if (response['detector'] !== category) invalidResponse(`expected detector ${category}`);
  const detections = response['all_detections'];
  if (!Array.isArray(detections)) invalidResponse('all_detections must be an array');
  if (detections.length > 1) invalidResponse('all_detections must contain at most one result');
  return detections.length === 0 ? undefined : validateDetection(detections[0], category);
}

/**
 * Validate the narrow backend contract before projecting it. Schema drift,
 * proxy corruption, or a response from the wrong detector must never become
 * a synthetic clean result. Only a valid response with an empty detection
 * array means the requested detector ran and found nothing.
 */
function pickByCategory<T extends MultiAgentDetection>(
  response: unknown,
  category: T['category'],
  expectedTraceId: string,
  fallbackTitle: string,
): T {
  const raw = validateResponse(response, category, expectedTraceId);
  if (raw) {
    const projected = projectDetection(raw);
    return { ...projected, category } as unknown as T;
  }
  const stub: MultiAgentDetection = {
    category,
    detected: false,
    confidence: 0,
    severity: 'info',
    title: fallbackTitle,
    description: 'Backend ran the requested detector and did not surface a detection.',
    evidence: [],
    affectedSpans: [],
    suggestedFix: null,
  };
  return stub as unknown as T;
}

function buildRequest(content: unknown): DiagnoseRequestBody {
  return {
    content: JSON.stringify(content),
  };
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizedIdentifier(value: unknown, label: string): string {
  return requireNonBlankString(value, label).trim();
}

function normalizedCorrelationId(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : normalizedIdentifier(value, label);
}

function normalizeCoordinationInput(input: CoordinationInput): CoordinationInput {
  if (!Array.isArray(input?.agent_ids) || input.agent_ids.length === 0) {
    throw new TypeError('coordination: agent_ids must be a non-empty array');
  }
  const agentIds = input.agent_ids.map((id, index) =>
    normalizedIdentifier(id, `coordination: agent_ids[${index}]`),
  );
  if (new Set(agentIds).size !== agentIds.length) {
    throw new TypeError('coordination: agent_ids must be unique');
  }
  if (!Array.isArray(input.messages)) {
    throw new TypeError('coordination: messages must be an array');
  }
  const participants = new Set(agentIds);
  const messages = input.messages.map((message, index) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      throw new TypeError(`coordination: messages[${index}] must be an object`);
    }
    const sender = normalizedIdentifier(
      (message as CoordinationInput['messages'][number]).sender,
      `coordination: messages[${index}].sender`,
    );
    if (!participants.has(sender)) {
      throw new TypeError(`coordination: messages[${index}].sender must appear in agent_ids`);
    }
    const content = requireNonBlankString(
      (message as CoordinationInput['messages'][number]).content,
      `coordination: messages[${index}].content`,
    );
    const rawRecipient = (message as CoordinationInput['messages'][number]).recipient;
    const recipient =
      rawRecipient === undefined
        ? undefined
        : normalizedIdentifier(rawRecipient, `coordination: messages[${index}].recipient`);
    const timestamp = (message as CoordinationInput['messages'][number]).timestamp;
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) {
      throw new TypeError(`coordination: messages[${index}].timestamp must be a finite number`);
    }
    return {
      sender,
      ...(recipient === undefined ? {} : { recipient }),
      content,
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  });
  return {
    agent_ids: agentIds,
    messages,
    ...(input.correlation_id === undefined
      ? {}
      : {
          correlation_id: normalizedCorrelationId(
            input.correlation_id,
            'coordination: correlation_id',
          ),
        }),
  };
}

function normalizePersonaInput(input: PersonaInput): PersonaInput {
  if (typeof input?.agent !== 'object' || input.agent === null) {
    throw new TypeError('persona: agent is required');
  }
  const id = normalizedIdentifier(input.agent.id, 'persona: agent.id');
  const personaDescription = requireNonBlankString(
    input.agent.persona_description,
    'persona: agent.persona_description',
  );
  if (!Array.isArray(input.agent.allowed_actions)) {
    throw new TypeError('persona: agent.allowed_actions must be an array');
  }
  const allowedActions = input.agent.allowed_actions.map((action, index) =>
    requireNonBlankString(action, `persona: agent.allowed_actions[${index}]`),
  );
  const task = requireNonBlankString(input.task, 'persona: task');
  if (typeof input.output !== 'string') {
    throw new TypeError('persona: output must be a string');
  }
  return {
    agent: {
      id,
      persona_description: personaDescription,
      allowed_actions: allowedActions,
    },
    task,
    output: input.output,
    ...(input.correlation_id === undefined
      ? {}
      : {
          correlation_id: normalizedCorrelationId(input.correlation_id, 'persona: correlation_id'),
        }),
  };
}

// ---- Trace shaping (typed input → orchestrator trace JSON) ----
//
// The backend's `raw` importer only turns span-like objects into
// `UniversalSpan`s. Agent/message fields on a wrapper object are not detector
// input, so preserve every message as a real child span. The root span carries
// the declared participant set (including silent agents); message spans carry
// sender, response text, and an explicit recipient in metadata.

function createTraceId(kind: 'coord' | 'persona'): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `ts-${kind}-${globalThis.crypto.randomUUID()}`;
  }
  return `ts-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

interface ShapedTrace {
  traceId: string;
  payload: unknown;
}

function coordinationToTrace(input: CoordinationInput): ShapedTrace {
  const traceId = input.correlation_id ?? createTraceId('coord');
  return {
    traceId,
    payload: {
      id: `${traceId}-root`,
      trace_id: traceId,
      name: 'pisama.multi_agent.coordination',
      detector_hint: 'coordination',
      metadata: {
        'pisama.coordination.agent_ids': input.agent_ids,
      },
      spans: input.messages.map((message, index) => ({
        id: `${traceId}-message-${index + 1}`,
        trace_id: traceId,
        parent_id: `${traceId}-root`,
        name: 'pisama.agent.message',
        agent_id: message.sender,
        agent_name: message.sender,
        response: message.content,
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        ...(message.recipient
          ? { metadata: { 'pisama.message.recipient': message.recipient } }
          : {}),
      })),
    },
  };
}

function personaToTrace(input: PersonaInput): ShapedTrace {
  const traceId = input.correlation_id ?? createTraceId('persona');
  return {
    traceId,
    payload: {
      id: `${traceId}-root`,
      trace_id: traceId,
      name: 'pisama.multi_agent.persona',
      detector_hint: 'persona_drift',
      spans: [
        {
          id: `${traceId}-output-1`,
          trace_id: traceId,
          parent_id: `${traceId}-root`,
          name: 'pisama.agent.output',
          agent_id: input.agent.id,
          agent_name: input.agent.id,
          prompt: input.task,
          response: input.output,
          metadata: {
            'gen_ai.persona': input.agent.persona_description,
            'pisama.allowed_actions': input.agent.allowed_actions,
          },
        },
      ],
    },
  };
}

// ---- Public namespace ----

export function createMultiAgentDetectors(opts: MultiAgentClientOptions = {}) {
  const client = new MultiAgentClient(opts);

  return {
    /** Detect coordination failures across an agent message stream. */
    async coordination(input: CoordinationInput): Promise<CoordinationResult> {
      const normalized = normalizeCoordinationInput(input);
      const shaped = coordinationToTrace(normalized);
      const body = buildRequest(shaped.payload);
      const res = await client.post<unknown>(COORDINATION_PATH, body);
      return pickByCategory<CoordinationResult>(
        res,
        'coordination',
        shaped.traceId,
        'No coordination failure detected',
      );
    },

    /** Detect persona drift in an agent's output against its declared persona. */
    async persona(input: PersonaInput): Promise<PersonaResult> {
      const normalized = normalizePersonaInput(input);
      const shaped = personaToTrace(normalized);
      const body = buildRequest(shaped.payload);
      const res = await client.post<unknown>(PERSONA_PATH, body);
      return pickByCategory<PersonaResult>(
        res,
        'persona_drift',
        shaped.traceId,
        'No persona drift detected',
      );
    },
  };
}

export type MultiAgentDetectorsApi = ReturnType<typeof createMultiAgentDetectors>;

/**
 * Default singleton bound to env-driven config (PISAMA_ENDPOINT,
 * PISAMA_API_KEY, PISAMA_PROJECT_ID). For tests or custom auth, use
 * `createMultiAgentDetectors({ ... })`.
 */
export const MultiAgentDetectors: MultiAgentDetectorsApi = createMultiAgentDetectors();
