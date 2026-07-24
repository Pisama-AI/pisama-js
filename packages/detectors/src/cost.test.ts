import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCost } from './cost.js';
import type { AgentTrace } from './types.js';

const baseTrace = (overrides: Partial<AgentTrace> = {}): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: [],
  model: 'gpt-4o',
  ...overrides,
});

test('clean trace passes', () => {
  const r = detectCost(baseTrace({ inputTokens: 200, outputTokens: 300, costUsd: 0.01 }));
  assert.equal(r.detected, false);
});

test('flags high token count', () => {
  const r = detectCost(baseTrace({ inputTokens: 10000, outputTokens: 5000 }));
  assert.equal(r.detected, true);
  assert.match(r.summary, /token usage/i);
});

test('flags high cost', () => {
  const r = detectCost(baseTrace({ inputTokens: 100, outputTokens: 100, costUsd: 0.75 }));
  assert.equal(r.detected, true);
  assert.match(r.summary, /cost/i);
});

test('flags missing model when tokens present', () => {
  const r = detectCost({
    traceId: 't',
    startTime: 0,
    toolCalls: [],
    inputTokens: 100,
    outputTokens: 100,
  });
  assert.equal(r.detected, true);
});

test('missing model with no tokens is fine', () => {
  const r = detectCost({ traceId: 't', startTime: 0, toolCalls: [] });
  assert.equal(r.detected, false);
});
