export type { AgentTrace, Detector, DetectionResult, ToolEvent } from './types.js';
export { noIssue } from './types.js';

export { detectLoop, loopDetector, checkConsecutive, detectCycle, checkDiversity } from './loop.js';
export { detectRepetition, repetitionDetector } from './repetition.js';
export { detectCost, costDetector } from './cost.js';
export { detectCompletion, completionDetector } from './completion.js';
export { detectHallucination, hallucinationDetector } from './hallucination.js';
export { detectContext, contextDetector } from './context.js';
export { detectDerailment, derailmentDetector } from './derailment.js';

// B4: typed clients for the backend's multi-agent failure detectors.
// Pure POST clients — detection runs server-side, never in TS.
export {
  MultiAgentDetectors,
  createMultiAgentDetectors,
  MultiAgentClient,
  PisamaBackendError,
  type MultiAgentDetectorsApi,
  type MultiAgentClientOptions,
  type MultiAgentDetection,
  type MultiAgentSeverity,
  type CoordinationInput,
  type CoordinationResult,
  type DelegationInput,
  type DelegationResult,
  type PersonaAgent,
  type PersonaInput,
  type PersonaResult,
  type ConsensusCollapseInput,
  type ConsensusCollapseResult,
} from './multiAgent/index.js';

import { loopDetector } from './loop.js';
import { repetitionDetector } from './repetition.js';
import { costDetector } from './cost.js';
import { completionDetector } from './completion.js';
import { hallucinationDetector } from './hallucination.js';
import { contextDetector } from './context.js';
import { derailmentDetector } from './derailment.js';
import type { AgentTrace, Detector, DetectionResult } from './types.js';

export const v1Detectors: Detector[] = [
  loopDetector,
  repetitionDetector,
  costDetector,
  completionDetector,
  hallucinationDetector,
  contextDetector,
  derailmentDetector,
];

export function runDetectors(
  trace: AgentTrace,
  detectors: Detector[] = v1Detectors,
): DetectionResult[] {
  const out: DetectionResult[] = [];
  for (const d of detectors) {
    try {
      const r = d.detect(trace);
      if (r.detected) out.push(r);
    } catch {
      // detectors must never break the pipeline
    }
  }
  return out;
}
