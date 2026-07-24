import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRepetition } from './repetition.js';
import type { AgentTrace } from './types.js';

const traceWithCompletion = (completion: string): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: [],
  completion,
});

test('no issue on short completion', () => {
  const r = detectRepetition(traceWithCompletion('Hi there friend.'));
  assert.equal(r.detected, false);
});

test('flags repeated identical lines', () => {
  const text = Array(5).fill('I am unable to help with that request.').join('\n');
  const r = detectRepetition(traceWithCompletion(text));
  assert.equal(r.detected, true);
  assert.match(r.summary, /repeated/);
});

test('flags repeated 6-gram phrase', () => {
  const phrase = 'the quick brown fox jumps over';
  const text = `${phrase} ${phrase} the lazy dog. and ${phrase} again, plus one more time ${phrase}.`;
  const r = detectRepetition(traceWithCompletion(text));
  assert.equal(r.detected, true);
});

test('clean completion passes', () => {
  const r = detectRepetition(
    traceWithCompletion(
      'Sure. The capital of France is Paris. It sits on the Seine and has a population of around two million.',
    ),
  );
  assert.equal(r.detected, false);
});
