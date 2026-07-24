import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLoop } from './loop.js';
import type { AgentTrace } from './types.js';

const traceWith = (tools: string[]): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: tools.map((toolName, i) => ({ toolName, startTime: i })),
});

test('returns no-issue for short trace', () => {
  const r = detectLoop(traceWith(['a', 'b']));
  assert.equal(r.detected, false);
});

test('flags consecutive repetition', () => {
  const r = detectLoop(traceWith(['search', 'search', 'search', 'search', 'search']));
  assert.equal(r.detected, true);
  assert.ok(r.severity >= 50);
  assert.match(r.summary, /search/);
});

test('flags cyclic pattern A->B->A->B', () => {
  const r = detectLoop(traceWith(['a', 'b', 'a', 'b', 'a', 'b']));
  assert.equal(r.detected, true);
  assert.ok(r.severity >= 30);
});

test('flags low tool diversity', () => {
  const r = detectLoop(traceWith(['x', 'x', 'x', 'x', 'x', 'x']));
  assert.equal(r.detected, true);
});

test('clean trace passes', () => {
  const r = detectLoop(traceWith(['plan', 'search', 'read', 'write', 'verify']));
  assert.equal(r.detected, false);
});
