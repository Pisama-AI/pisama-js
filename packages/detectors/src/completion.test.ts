import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCompletion } from './completion.js';
import type { AgentTrace } from './types.js';

const trace = (overrides: Partial<AgentTrace>): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: [],
  ...overrides,
});

test('flags premature stop on a question', () => {
  const r = detectCompletion(
    trace({
      prompt: 'What is the capital of France?',
      completion: 'Sure.',
      finishReason: 'stop',
    }),
  );
  assert.equal(r.detected, true);
  assert.match(r.summary, /Premature/i);
});

test('flags runaway long completion', () => {
  const r = detectCompletion(
    trace({
      completion: 'lots of text here',
      outputTokens: 5000,
    }),
  );
  assert.equal(r.detected, true);
  assert.match(r.summary, /Runaway|runaway/);
});

test('clean reply on greeting passes', () => {
  const r = detectCompletion(
    trace({
      prompt: 'Hi',
      completion: 'Hello.',
      finishReason: 'stop',
    }),
  );
  assert.equal(r.detected, false);
});

test('normal completion passes', () => {
  const r = detectCompletion(
    trace({
      prompt: 'Explain TLS handshakes.',
      completion: 'TLS begins with a ClientHello, then ServerHello, then certificate exchange...',
      finishReason: 'stop',
      outputTokens: 600,
    }),
  );
  assert.equal(r.detected, false);
});
