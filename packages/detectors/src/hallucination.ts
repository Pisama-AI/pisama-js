// Lite hallucination detector. NOT a substitute for an LLM judge.
// Heuristic: when the prompt includes a Sources: block (or <sources> tags),
// flag completion sentences whose capitalized multi-word phrases never appear
// in any source. Conservative: requires multiple unsupported phrases and
// filters common geographic/brand phrases.

import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'hallucination';
const MIN_PHRASE_LEN = 6;
const MIN_TOTAL_PHRASES = 3;
const MIN_UNSUPPORTED = 2;
const MIN_SEVERITY = 35;
const MAX_FLAGGED_PHRASES = 5;

// Phrases that are common general knowledge and don't require source citation.
// Lowercased; matched as a whole phrase.
const COMMON_KNOWLEDGE = new Set([
  'united states',
  'united kingdom',
  'european union',
  'new york',
  'los angeles',
  'san francisco',
  'great britain',
  'world war',
  'world war one',
  'world war two',
  'north america',
  'south america',
  'middle east',
  'far east',
  'silicon valley',
  'open source',
  'machine learning',
  'artificial intelligence',
]);

export function detectHallucination(trace: AgentTrace): DetectionResult {
  const completion = (trace.completion ?? '').trim();
  if (completion.length < 40) return noIssue(NAME);

  const sources = extractSources(trace.prompt);
  if (sources.length === 0) return noIssue(NAME);

  const sourceCorpus = sources.join(' ').toLowerCase();
  const phrases = extractCapPhrases(completion);
  if (phrases.length < MIN_TOTAL_PHRASES) return noIssue(NAME);

  const unsupported = phrases.filter((p) => {
    const lower = p.toLowerCase();
    if (sourceCorpus.includes(lower)) return false;
    if (COMMON_KNOWLEDGE.has(lower)) return false;
    return true;
  });
  if (unsupported.length < MIN_UNSUPPORTED) return noIssue(NAME);

  const flagged = unsupported.slice(0, MAX_FLAGGED_PHRASES);
  const ratio = unsupported.length / phrases.length;
  const severity = Math.min(100, Math.round(ratio * 80));
  if (severity < MIN_SEVERITY) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity,
    summary: `${unsupported.length} of ${phrases.length} named phrases not found in sources: ${flagged.join(', ')}`,
    fix: 'Verify these claims against the sources or have the model cite explicitly.',
    evidence: { unsupported: flagged, totalPhrases: phrases.length, ratio },
  };
}

function extractSources(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const tagMatch = prompt.match(/<sources>([\s\S]*?)<\/sources>/i);
  if (tagMatch && tagMatch[1]) return [tagMatch[1]];

  const blockMatch = prompt.match(/\bsources?\s*:\s*([\s\S]+?)(\n\s*\n|$)/i);
  if (blockMatch && blockMatch[1]) return [blockMatch[1]];

  return [];
}

function extractCapPhrases(text: string): string[] {
  const matches = text.match(/\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g) ?? [];
  return matches.filter((m) => m.length >= MIN_PHRASE_LEN);
}

export const hallucinationDetector: Detector = {
  name: NAME,
  description: "Flags completion claims not supported by the prompt's sources block (heuristic)",
  detect: detectHallucination,
};
