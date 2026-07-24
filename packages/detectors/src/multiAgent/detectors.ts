/**
 * MultiAgentDetectors — typed clients for the backend's multi-agent failure
 * detector suite (coordination, delegation, persona_drift, consensus_collapse).
 *
 * The TS side does NO detection. Each function:
 *   1. Validates / normalises the typed input.
 *   2. Serialises it into a `raw` trace payload the backend understands.
 *   3. POSTs to `/api/v1/diagnose/why-failed` (current backend reality —
 *      per-detector REST routes do not yet exist).
 *   4. Filters the resulting `all_detections` for the matching category and
 *      returns a single typed result. If the backend produced no detection
 *      for that category, we return a `detected: false` stub so callers can
 *      always rely on a result object.
 *
 * Backend gap (tracked in README):
 *   - No `POST /api/v1/detect/{type}` routes today. Wrap-and-filter is the
 *     honest workaround. Once those routes exist, swap the path here.
 *   - `delegation` and `consensus_collapse` are evaluated through the
 *     orchestrator/calibration runner but are NOT yet mapped to a
 *     `DetectionCategory` returned by `/diagnose/why-failed`. Until the
 *     backend exposes them in `all_detections`, those two clients will
 *     return `detected: false` with a clear `description` noting the gap.
 */

import { MultiAgentClient, type MultiAgentClientOptions } from './client.js';
import type {
  ConsensusCollapseInput,
  ConsensusCollapseResult,
  CoordinationInput,
  CoordinationResult,
  DelegationInput,
  DelegationResult,
  MultiAgentDetection,
  MultiAgentSeverity,
  PersonaInput,
  PersonaResult,
} from './types.js';

const DIAGNOSE_PATH = '/api/v1/diagnose/why-failed';

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

interface DiagnoseResponseRaw {
  all_detections?: DiagnoseDetectionRaw[];
  primary_failure?: DiagnoseDetectionRaw | null;
}

interface DiagnoseRequestBody {
  content: string;
  format: 'raw';
  include_fixes: boolean;
  run_all_detections: boolean;
}

function normaliseSeverity(s: string): MultiAgentSeverity {
  const lower = s.toLowerCase();
  if (
    lower === 'critical' ||
    lower === 'high' ||
    lower === 'medium' ||
    lower === 'low' ||
    lower === 'info'
  ) {
    return lower;
  }
  return 'medium';
}

function projectDetection(raw: DiagnoseDetectionRaw): MultiAgentDetection {
  return {
    category: raw.category,
    detected: raw.detected,
    confidence: raw.confidence,
    severity: normaliseSeverity(raw.severity),
    title: raw.title,
    description: raw.description,
    evidence: raw.evidence ?? [],
    affectedSpans: raw.affected_spans ?? [],
    suggestedFix: raw.suggested_fix ?? null,
  };
}

/**
 * Pick the strongest detection in `all_detections` matching `category`.
 * Falls back to a synthetic `detected: false` stub when the backend ran but
 * found nothing in that category — keeps the caller's typed result shape
 * stable.
 */
function pickByCategory<T extends MultiAgentDetection>(
  response: DiagnoseResponseRaw,
  category: T['category'],
  fallbackTitle: string,
): T {
  const matches = (response.all_detections ?? []).filter((d) => d.category === category);
  if (matches.length > 0) {
    // Pick the highest-confidence detection in the category.
    matches.sort((a, b) => b.confidence - a.confidence);
    const projected = projectDetection(matches[0]!);
    return { ...projected, category } as unknown as T;
  }
  const stub: MultiAgentDetection = {
    category,
    detected: false,
    confidence: 0,
    severity: 'info',
    title: fallbackTitle,
    description: 'Backend ran detection suite but did not surface a detection in this category.',
    evidence: [],
    affectedSpans: [],
    suggestedFix: null,
  };
  return stub as unknown as T;
}

function buildRequest(content: unknown): DiagnoseRequestBody {
  return {
    content: JSON.stringify(content),
    format: 'raw',
    include_fixes: true,
    run_all_detections: true,
  };
}

// ---- Trace shaping (typed input → orchestrator trace JSON) ----
//
// The backend's `raw` importer accepts a JSON object with `spans`/`agents`
// fields. We build the minimal shape each detector needs so the orchestrator
// has enough context to fire the relevant detector.

function coordinationToTrace(input: CoordinationInput): unknown {
  return {
    trace_id: input.correlation_id ?? `ts-coord-${Date.now()}`,
    detector_hint: 'coordination',
    agents: input.agent_ids.map((id) => ({ id })),
    messages: input.messages,
  };
}

function delegationToTrace(input: DelegationInput): unknown {
  return {
    trace_id: input.correlation_id ?? `ts-deleg-${Date.now()}`,
    detector_hint: 'delegation',
    handoff_instruction: input.handoff_instruction,
    context_completeness: input.context_completeness,
    bounds: input.bounds,
    success_criteria: input.success_criteria,
  };
}

function personaToTrace(input: PersonaInput): unknown {
  return {
    trace_id: input.correlation_id ?? `ts-persona-${Date.now()}`,
    detector_hint: 'persona_drift',
    agents: [
      {
        id: input.agent.id,
        persona_description: input.agent.persona_description,
        allowed_actions: input.agent.allowed_actions,
      },
    ],
    output: input.output,
  };
}

function consensusCollapseToTrace(input: ConsensusCollapseInput): unknown {
  return {
    trace_id: input.correlation_id ?? `ts-consensus-${Date.now()}`,
    detector_hint: 'consensus_collapse',
    agent_outputs: input.agent_outputs,
    challenge_patterns: input.challenge_patterns,
    agreement_ratio: input.agreement_ratio,
    debate_trace: input.debate_trace,
  };
}

// ---- Public namespace ----

export function createMultiAgentDetectors(opts: MultiAgentClientOptions = {}) {
  const client = new MultiAgentClient(opts);

  return {
    /** Detect coordination failures across an agent message stream. */
    async coordination(input: CoordinationInput): Promise<CoordinationResult> {
      if (!input.agent_ids?.length) {
        throw new TypeError('coordination: agent_ids must be a non-empty array');
      }
      if (!Array.isArray(input.messages)) {
        throw new TypeError('coordination: messages must be an array');
      }
      const body = buildRequest(coordinationToTrace(input));
      const res = await client.post<DiagnoseResponseRaw>(DIAGNOSE_PATH, body);
      return pickByCategory<CoordinationResult>(
        res,
        'coordination',
        'No coordination failure detected',
      );
    },

    /**
     * Score a delegation handoff for missing criteria / vague instructions.
     *
     * NOTE: `delegation` is not yet returned as a discrete category by the
     * orchestrator's `/diagnose/why-failed` endpoint. Until the backend gap
     * closes this call will round-trip to the backend but return
     * `detected: false`. Use the typed shape now so call sites don't change
     * when the backend lands the route.
     */
    async delegation(input: DelegationInput): Promise<DelegationResult> {
      if (typeof input.handoff_instruction !== 'string') {
        throw new TypeError('delegation: handoff_instruction must be a string');
      }
      if (
        typeof input.context_completeness !== 'number' ||
        input.context_completeness < 0 ||
        input.context_completeness > 1
      ) {
        throw new TypeError('delegation: context_completeness must be a number in [0, 1]');
      }
      const body = buildRequest(delegationToTrace(input));
      const res = await client.post<DiagnoseResponseRaw>(DIAGNOSE_PATH, body);
      return pickByCategory<DelegationResult>(res, 'delegation', 'No delegation failure detected');
    },

    /** Detect persona drift in an agent's output against its declared persona. */
    async persona(input: PersonaInput): Promise<PersonaResult> {
      if (!input.agent?.id) {
        throw new TypeError('persona: agent.id is required');
      }
      if (typeof input.output !== 'string') {
        throw new TypeError('persona: output must be a string');
      }
      const body = buildRequest(personaToTrace(input));
      const res = await client.post<DiagnoseResponseRaw>(DIAGNOSE_PATH, body);
      return pickByCategory<PersonaResult>(res, 'persona_drift', 'No persona drift detected');
    },

    /**
     * Detect consensus collapse in a multi-agent debate.
     *
     * NOTE: same gap as `delegation` — the backend has a calibrated
     * `consensus_collapse` detector (F1 0.967 per the calibration registry)
     * but `/diagnose/why-failed` does not yet surface it in `all_detections`.
     * The B2 batch endpoint `/api/v1/diagnose/batch` is the natural home;
     * this client will switch to it once shipped.
     */
    async consensus_collapse(input: ConsensusCollapseInput): Promise<ConsensusCollapseResult> {
      if (!Array.isArray(input.agent_outputs) || input.agent_outputs.length === 0) {
        throw new TypeError('consensus_collapse: agent_outputs must be a non-empty array');
      }
      if (
        typeof input.agreement_ratio !== 'number' ||
        input.agreement_ratio < 0 ||
        input.agreement_ratio > 1
      ) {
        throw new TypeError('consensus_collapse: agreement_ratio must be a number in [0, 1]');
      }
      const body = buildRequest(consensusCollapseToTrace(input));
      const res = await client.post<DiagnoseResponseRaw>(DIAGNOSE_PATH, body);
      return pickByCategory<ConsensusCollapseResult>(
        res,
        'consensus_collapse',
        'No consensus collapse detected',
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
