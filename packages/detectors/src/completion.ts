import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'completion';
const PREMATURE_MAX_LEN = 20;
const RUNAWAY_TOKEN_THRESHOLD = 4000;

const TASK_VERBS = [
  'list',
  'explain',
  'write',
  'show',
  'describe',
  'compare',
  'summarize',
  'create',
  'implement',
  'build',
  'design',
  'outline',
  'find',
];

export function detectCompletion(trace: AgentTrace): DetectionResult {
  const issues: string[] = [];
  let severity = 0;
  const evidence: Record<string, unknown> = {};

  const completion = trace.completion ?? '';
  const trimmed = completion.trim();

  const finishStop = trace.finishReason === 'stop' || trace.finishReason === 'end_turn';
  if (finishStop && trimmed.length > 0 && trimmed.length < PREMATURE_MAX_LEN) {
    if (promptExpectsOutput(trace.prompt)) {
      severity += 50;
      issues.push(
        `Premature completion: stopped after ${trimmed.length} chars while the prompt asked for output`,
      );
      evidence.completionLength = trimmed.length;
    }
  }

  const outTok = trace.outputTokens ?? 0;
  if (outTok > RUNAWAY_TOKEN_THRESHOLD) {
    severity += outTok > RUNAWAY_TOKEN_THRESHOLD * 2 ? 50 : 30;
    issues.push(
      `Runaway completion: ${outTok} output tokens (threshold ${RUNAWAY_TOKEN_THRESHOLD})`,
    );
    evidence.outputTokens = outTok;
  }

  if (issues.length === 0) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: Math.min(100, severity),
    summary: issues[0]!,
    fix: 'Set a tighter max_tokens, ensure the system prompt has clear stop conditions, or check if the prompt is being delivered correctly.',
    evidence: { ...evidence, allIssues: issues },
  };
}

function promptExpectsOutput(prompt: string | undefined): boolean {
  if (!prompt) return false;
  const lower = prompt.toLowerCase();
  if (lower.includes('?')) return true;
  for (const verb of TASK_VERBS) {
    if (new RegExp(`\\b${verb}\\b`).test(lower)) return true;
  }
  return false;
}

export const completionDetector: Detector = {
  name: NAME,
  description: 'Flags premature stops and runaway completions',
  detect: detectCompletion,
};
