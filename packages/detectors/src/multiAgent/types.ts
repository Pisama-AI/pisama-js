/**
 * Typed input/output shapes for MultiAgentDetectors.
 *
 * Outputs are a thin TS projection of the backend's `DiagnoseDetectionResult`
 * schema (see app/api/v1/schemas.py — DiagnoseDetectionResult). Each detector
 * surfaces the matching detection from the full diagnose response.
 */

// ---- Shared detection result ----

export type MultiAgentSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface MultiAgentDetection {
  /** Backend DetectionCategory value (e.g. "coordination", "persona_drift"). */
  category: string;
  detected: boolean;
  /** 0.0–1.0 confidence. */
  confidence: number;
  severity: MultiAgentSeverity;
  title: string;
  description: string;
  /** Free-form evidence rows the detector emitted. */
  evidence: Array<Record<string, unknown>>;
  /** Span ids implicated, when the detector localised the failure. */
  affectedSpans: string[];
  suggestedFix: string | null;
}

// ---- Coordination ----

export interface CoordinationInput {
  /** Stable ids for the agents whose messages are below. */
  agent_ids: string[];
  /** Message stream between the agents, in send order. */
  messages: Array<{
    sender: string;
    recipient?: string;
    content: string;
    timestamp?: number;
  }>;
  /** Optional correlation id so the backend can group with related traces. */
  correlation_id?: string;
}

export interface CoordinationResult extends MultiAgentDetection {
  category: 'coordination';
}

// ---- Persona ----

export interface PersonaAgent {
  id: string;
  persona_description: string;
  allowed_actions: string[];
}

export interface PersonaInput {
  agent: PersonaAgent;
  /** The agent's most recent output to be checked for persona drift. */
  output: string;
  correlation_id?: string;
}

export interface PersonaResult extends MultiAgentDetection {
  category: 'persona_drift';
}
