import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'cost';
const HIGH_TOKEN_THRESHOLD = 8000;
const HIGH_COST_USD = 0.5;

export function detectCost(trace: AgentTrace): DetectionResult {
  const inTok = trace.inputTokens ?? 0;
  const outTok = trace.outputTokens ?? 0;
  const total = inTok + outTok;
  const cost = trace.costUsd ?? 0;

  const issues: string[] = [];
  let severity = 0;
  const evidence: Record<string, unknown> = {
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: cost,
  };

  if (total > HIGH_TOKEN_THRESHOLD) {
    severity += total > HIGH_TOKEN_THRESHOLD * 2 ? 60 : 35;
    issues.push(`High token usage: ${total} tokens (threshold ${HIGH_TOKEN_THRESHOLD})`);
  }

  if (cost > HIGH_COST_USD) {
    severity += cost > HIGH_COST_USD * 2 ? 50 : 30;
    issues.push(`High call cost: $${cost.toFixed(3)} (threshold $${HIGH_COST_USD})`);
  }

  if ((inTok > 0 || outTok > 0) && !trace.model) {
    severity += 10;
    issues.push('Tokens reported without a model name (mis-instrumented)');
  }

  if (issues.length === 0) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: Math.min(100, severity),
    summary: issues[0]!,
    fix: 'Cap output tokens, switch to a cheaper model for this prompt, or shorten the system message.',
    evidence: { ...evidence, allIssues: issues },
  };
}

export const costDetector: Detector = {
  name: NAME,
  description: 'Flags token / cost spikes and missing model attribution',
  detect: detectCost,
};
