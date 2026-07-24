import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'loop';
const MIN_CONSECUTIVE_WARN = 3;
const MIN_CONSECUTIVE_CRIT = 5;
const MIN_CYCLE_REPS = 3;
const MAX_CYCLE_LEN = 5;
const MIN_DIVERSITY_LEN = 5;
const LOW_DIVERSITY_RATIO = 0.2;

export interface ConsecutiveResult {
  count: number;
  tool: string | null;
}

export interface CycleResult {
  pattern: string[];
  count: number;
  length: number;
}

export interface DiversityResult {
  ratio: number;
  unique: number;
  total: number;
}

export function checkConsecutive(sequence: string[]): ConsecutiveResult {
  if (sequence.length === 0) return { count: 0, tool: null };

  let maxCount = 1;
  let maxTool = sequence[0]!;
  let currentCount = 1;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] === sequence[i - 1]) {
      currentCount++;
      if (currentCount > maxCount) {
        maxCount = currentCount;
        maxTool = sequence[i]!;
      }
    } else {
      currentCount = 1;
    }
  }

  return { count: maxCount, tool: maxTool };
}

export function detectCycle(sequence: string[]): CycleResult | null {
  if (sequence.length < 4) return null;

  const maxLength = Math.min(MAX_CYCLE_LEN + 1, Math.floor(sequence.length / 2) + 1);

  for (let length = 2; length < maxLength; length++) {
    const pattern = sequence.slice(0, length);
    let matches = 0;
    let i = 0;

    while (i + length <= sequence.length) {
      if (arraysEqual(sequence.slice(i, i + length), pattern)) {
        matches++;
        i += length;
      } else {
        break;
      }
    }

    if (matches >= MIN_CYCLE_REPS) {
      return { pattern, count: matches, length };
    }
  }

  return null;
}

export function checkDiversity(sequence: string[]): DiversityResult {
  if (sequence.length === 0) return { ratio: 1.0, unique: 0, total: 0 };

  const counts = new Map<string, number>();
  for (const item of sequence) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }

  return {
    ratio: counts.size / sequence.length,
    unique: counts.size,
    total: sequence.length,
  };
}

export function detectLoop(trace: AgentTrace): DetectionResult {
  const sequence = trace.toolCalls.map((t) => t.toolName);
  if (sequence.length < MIN_CONSECUTIVE_WARN) return noIssue(NAME);

  const issues: string[] = [];
  let severity = 0;
  const evidence: Record<string, unknown> = {};

  const consecutive = checkConsecutive(sequence);
  if (consecutive.count >= MIN_CONSECUTIVE_WARN) {
    severity += consecutive.count >= MIN_CONSECUTIVE_CRIT ? 50 : 25;
    issues.push(`Tool '${consecutive.tool}' repeated ${consecutive.count}x consecutively`);
    evidence.consecutive = consecutive;
  }

  const cycle = detectCycle(sequence);
  if (cycle) {
    severity += 30;
    issues.push(`Loop pattern: ${cycle.pattern.join(' -> ')} (${cycle.count}x)`);
    evidence.cycle = cycle;
  }

  const diversity = checkDiversity(sequence);
  if (diversity.ratio < LOW_DIVERSITY_RATIO && sequence.length >= MIN_DIVERSITY_LEN) {
    severity += 20;
    issues.push(`Low tool diversity (${Math.round(diversity.ratio * 100)}%)`);
    evidence.diversity = diversity;
  }

  if (issues.length === 0) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: Math.min(100, severity),
    summary: issues[0]!,
    fix: 'Stop the current loop. Try a different approach or ask the user for guidance.',
    evidence: { ...evidence, allIssues: issues },
  };
}

export const loopDetector: Detector = {
  name: NAME,
  description: 'Detects infinite loops, retry storms, and stuck patterns',
  detect: detectLoop,
};

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
