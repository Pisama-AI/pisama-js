import type { AgentTrace, Detector, DetectionResult } from './types.js';
import { noIssue } from './types.js';

const NAME = 'derailment';
const MIN_TOOLS = 5;
const SEVERITY = 35;

const TASK_VERBS = new Set([
  'write',
  'create',
  'build',
  'make',
  'generate',
  'compose',
  'edit',
  'update',
  'modify',
  'rewrite',
  'patch',
  'refactor',
  'delete',
  'remove',
  'drop',
  'analyze',
  'summarize',
  'explain',
  'describe',
  'compare',
  'plan',
  'design',
  'verify',
  'check',
  'test',
  'validate',
  'send',
  'post',
  'publish',
  'deploy',
  'ship',
  'translate',
  'convert',
  'format',
  'render',
  'visualize',
]);

// Universal tools that satisfy almost any task verb because agents legitimately
// use them as a research/setup step.
const UNIVERSAL_TOOLS = [
  'search',
  'read',
  'fetch',
  'find',
  'get',
  'list',
  'ls',
  'view',
  'look',
  'browse',
];

// Verbs that are too vague to draw a derailment conclusion from.
const VAGUE_VERBS = new Set(['do', 'help', 'try', 'go', 'be', 'have', 'let', 'make']);

export function detectDerailment(trace: AgentTrace): DetectionResult {
  if (trace.toolCalls.length < MIN_TOOLS) return noIssue(NAME);

  const verbs = extractFirstSentenceVerbs(trace.prompt);
  if (verbs.length === 0) return noIssue(NAME);

  const toolNames = trace.toolCalls.map((t) => t.toolName.toLowerCase());

  // If the agent used any universal "look up" tool, the trace can't be called
  // derailed — it's behaving like a typical research-then-act agent.
  if (toolNames.some((tn) => UNIVERSAL_TOOLS.some((u) => tn.includes(u)))) {
    return noIssue(NAME);
  }

  // Stem-match each verb against any tool name.
  const aligned = verbs.some((v) => toolNames.some((tn) => containsStem(tn, v)));
  if (aligned) return noIssue(NAME);

  return {
    detector: NAME,
    detected: true,
    severity: SEVERITY,
    summary: `Tool sequence drifts from task. Asked to [${verbs.join(', ')}] but called [${toolNames.slice(0, 5).join(', ')}]`,
    fix: 'Align tool selection with the task verb. Add a planning step before tool calls or constrain available tools.',
    evidence: { taskVerbs: verbs, toolNames },
  };
}

function extractFirstSentenceVerbs(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const firstSentence = prompt
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .find((s) => s.length > 4);
  if (!firstSentence) return [];

  const tokens = firstSentence
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const verbs = tokens.filter((t) => TASK_VERBS.has(t) && !VAGUE_VERBS.has(t));
  return Array.from(new Set(verbs));
}

function containsStem(toolName: string, verb: string): boolean {
  if (toolName.includes(verb)) return true;
  // Common morphological variants
  if (verb.endsWith('e') && toolName.includes(verb.slice(0, -1))) return true;
  return false;
}

export const derailmentDetector: Detector = {
  name: NAME,
  description: "Flags tool sequences that don't align with the prompt's task verbs",
  detect: detectDerailment,
};
