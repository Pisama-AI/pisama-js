import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'repetition';
const MIN_LINE_LEN = 12;
const MIN_LINE_REPEATS = 3;
const NGRAM_SIZE = 6;
const MIN_NGRAM_REPEATS = 4;

export function detectRepetition(trace: AgentTrace): DetectionResult {
  const text = trace.completion ?? '';
  if (text.length < 80) return noIssue(NAME);

  const issues: string[] = [];
  let severity = 0;
  const evidence: Record<string, unknown> = {};

  const lineHit = checkLineRepetition(text);
  if (lineHit) {
    severity += 40;
    issues.push(`Line repeated ${lineHit.count}x: "${truncate(lineHit.line, 60)}"`);
    evidence.line = lineHit;
  }

  const ngramHit = checkNgramRepetition(text);
  if (ngramHit) {
    severity += 35;
    issues.push(`Phrase "${ngramHit.phrase}" repeated ${ngramHit.count}x in completion`);
    evidence.ngram = ngramHit;
  }

  if (issues.length === 0) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: Math.min(100, severity),
    summary: issues[0]!,
    fix: 'The model is looping on its own output. Lower temperature, add stop sequences, or shorten max tokens.',
    evidence: { ...evidence, allIssues: issues },
  };
}

function checkLineRepetition(text: string): { line: string; count: number } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= MIN_LINE_LEN);
  if (lines.length < MIN_LINE_REPEATS) return null;

  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }

  let best: { line: string; count: number } | null = null;
  for (const [line, count] of counts) {
    if (count >= MIN_LINE_REPEATS && (!best || count > best.count)) {
      best = { line, count };
    }
  }
  return best;
}

function checkNgramRepetition(text: string): { phrase: string; count: number } | null {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < NGRAM_SIZE * MIN_NGRAM_REPEATS) return null;

  const counts = new Map<string, number>();
  for (let i = 0; i <= tokens.length - NGRAM_SIZE; i++) {
    const phrase = tokens.slice(i, i + NGRAM_SIZE).join(' ');
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }

  let best: { phrase: string; count: number } | null = null;
  for (const [phrase, count] of counts) {
    if (count >= MIN_NGRAM_REPEATS && (!best || count > best.count)) {
      best = { phrase, count };
    }
  }
  return best;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

export const repetitionDetector: Detector = {
  name: NAME,
  description: 'Detects looping or repeating completion text',
  detect: detectRepetition,
};
