export interface ToolEvent {
  toolName: string;
  args?: unknown;
  result?: unknown;
  startTime: number;
}

export interface AgentTrace {
  traceId: string;
  startTime: number;
  endTime?: number;
  model?: string;
  prompt?: string;
  completion?: string;
  toolCalls: ToolEvent[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  finishReason?: string;
}

/**
 * Union of detector keys recognized by the Pisama backend. Used to type
 * `DetectionResult.detector` for autocomplete. The trailing `(string & {})`
 * means new detectors that ship after this SDK version still type-check.
 *
 * Source of truth: backend/data/capability_registry.json in Pisama-AI/pisama.
 * Update this union when new detectors land in production.
 */
export type DetectorKey =
  // Core ICP detectors
  | 'loop'
  | 'corruption'
  | 'persona_drift'
  | 'hallucination'
  | 'derailment'
  | 'overflow'
  | 'coordination'
  | 'injection'
  | 'communication'
  | 'context'
  | 'decomposition'
  | 'workflow'
  | 'grounding'
  | 'retrieval_quality'
  | 'completion'
  | 'specification'
  | 'specification_compliance'
  | 'withholding'
  | 'convergence'
  | 'delegation'
  | 'citation'
  // Safety v2 (Sprint 12 Phase B promotion, 2026-05-26)
  | 'scope_escalation'
  | 'jailbreak_compliance'
  | 'over_refusal'
  | 'under_refusal'
  | 'impersonation_risk'
  | 'deception'
  // Cross-agent / behavioral whitespace (Sprint 12 Phase C, 2026-05-26)
  | 'multi_agent_contagion'
  | 'reward_hacking'
  // Other production detectors (selected)
  | 'sycophancy'
  | 'consensus_collapse'
  | 'authority_gradient'
  | 'planning_fallacy'
  | 'mcp_protocol'
  | 'task_starvation'
  // Catch-all for detectors not yet listed in this SDK version
  | (string & {});

export interface DetectionResult {
  detector: DetectorKey;
  detected: boolean;
  severity: number;
  summary: string;
  fix?: string;
  evidence?: Record<string, unknown>;
}

export interface Detector {
  name: string;
  description: string;
  detect(trace: AgentTrace): DetectionResult;
}

export const noIssue = (detector: string): DetectionResult => ({
  detector,
  detected: false,
  severity: 0,
  summary: 'no issue detected',
});
