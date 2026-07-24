import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'context';
const MIN_TOKEN_LEN = 4;
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'into',
  'your',
  'their',
  'have',
  'been',
  'will',
  'would',
  'could',
  'should',
  'about',
  'after',
  'before',
  'context',
  'given',
  'below',
  'above',
]);

export function detectContext(trace: AgentTrace): DetectionResult {
  const block = extractContextBlock(trace.prompt);
  if (!block) return noIssue(NAME);

  const completion = (trace.completion ?? '').trim();
  if (completion.length < 30) return noIssue(NAME);

  const contextTokens = nounLikeTokens(block);
  if (contextTokens.size === 0) return noIssue(NAME);

  const completionLower = completion.toLowerCase();
  const matched = [...contextTokens].filter((t) => completionLower.includes(t));
  const overlap = matched.length / contextTokens.size;

  if (overlap > 0) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: 55,
    summary: `Completion ignores all ${contextTokens.size} key tokens from the supplied context`,
    fix: 'Pass context inside the system message or restate the relevant facts in the user message.',
    evidence: { contextTokens: [...contextTokens].slice(0, 12), overlap },
  };
}

function extractContextBlock(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const tag = prompt.match(/<context>([\s\S]*?)<\/context>/i);
  if (tag && tag[1]) return tag[1];

  const heading = prompt.match(/\b(?:context|given)\s*:\s*([\s\S]+?)(\n\s*\n|$)/i);
  if (heading && heading[1]) return heading[1];

  return null;
}

function nounLikeTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOP_WORDS.has(t));
  return new Set(tokens);
}

export const contextDetector: Detector = {
  name: NAME,
  description: 'Flags completions that ignore all key tokens from a supplied context block',
  detect: detectContext,
};
