/**
 * Typed input/output shapes for MultiAgentDetectors.
 *
 * Inputs mirror the backend's golden_dataset keys (see CLAUDE.md Golden
 * Dataset Key Reference) so requests round-trip without rename gymnastics.
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

// ---- Delegation ----

export interface DelegationInput {
  /** The handoff message from the delegating agent to the subagent. */
  handoff_instruction: string;
  /** 0.0–1.0 — how complete is the context bundle accompanying the handoff. */
  context_completeness: number;
  /** Explicit limits / boundaries given to the subagent. */
  bounds: string[];
  /** What "done" looks like for the delegated task. */
  success_criteria: string[];
  correlation_id?: string;
}

export interface DelegationResult extends MultiAgentDetection {
  category: 'delegation';
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

// ---- Consensus collapse ----

export interface ConsensusCollapseInput {
  /** Final outputs from each agent in the debate. */
  agent_outputs: Array<{ agent_id: string; output: string }>;
  /** Patterns observed across the debate (e.g. ["dropped_dissent", "anchor_bias"]). */
  challenge_patterns: string[];
  /** 0.0–1.0 final agreement ratio across agents. */
  agreement_ratio: number;
  /** Full ordered debate trace for the backend to re-analyze. */
  debate_trace: Array<{
    agent_id: string;
    round: number;
    content: string;
  }>;
  correlation_id?: string;
}

export interface ConsensusCollapseResult extends MultiAgentDetection {
  category: 'consensus_collapse';
}
