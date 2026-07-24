import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContext } from './context.js';
import type { AgentTrace } from './types.js';

const trace = (prompt: string, completion: string): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: [],
  prompt,
  completion,
});

test('no context block, no flag', () => {
  const r = detectContext(
    trace('Hello, how are you?', 'I am well, thank you for asking. The weather is fine.'),
  );
  assert.equal(r.detected, false);
});

test('flags completion that ignores context block', () => {
  const r = detectContext(
    trace(
      'Context: The user owns three labradors named Mochi, Banzai, and Pepper.\n\nQ: tell me a story.',
      'Once upon a time, a knight rode through forests on a brave horse to slay a dragon.',
    ),
  );
  assert.equal(r.detected, true);
});

test('does not flag when context tokens overlap', () => {
  const r = detectContext(
    trace(
      '<context>The startup PoolBird sells pool maintenance robots.</context>\n\nDescribe their product.',
      'PoolBird sells pool maintenance robots that clean swimming pools automatically.',
    ),
  );
  assert.equal(r.detected, false);
});

test('ignores tiny completions', () => {
  const r = detectContext(trace('Context: One thing about kangaroos.\n\nDescribe.', 'ok'));
  assert.equal(r.detected, false);
});
