import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHallucination } from './hallucination.js';
import type { AgentTrace } from './types.js';

const trace = (prompt: string, completion: string): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: [],
  prompt,
  completion,
});

test('no sources block, no flag', () => {
  const r = detectHallucination(
    trace(
      'Tell me about Geoffrey Hinton.',
      'Geoffrey Hinton won the Turing Award in 2018 with Yoshua Bengio and Yann LeCun.',
    ),
  );
  assert.equal(r.detected, false);
});

test('flags multiple unsupported claims', () => {
  const r = detectHallucination(
    trace(
      'Sources: Bart Smith was the founder of Acme Corp in 1992. Acme makes paint.\n\nQ: who started Acme?',
      'According to records, Bart Smith founded Acme Corp. The company was advised by Albert Einstein and Marie Curie. Their lawyer was Roger Federer.',
    ),
  );
  assert.equal(r.detected, true);
  assert.match(r.summary, /Albert Einstein|Marie Curie|Roger Federer/);
});

test('does not flag a single unsupported phrase (above threshold)', () => {
  const r = detectHallucination(
    trace(
      'Sources: Bart Smith was the founder of Acme Corp in 1992. Acme makes paint.',
      'According to records, Bart Smith founded Acme Corp. They built a paint factory in Newark City.',
    ),
  );
  // "Newark City" alone isn't enough to fire; needs ≥2 unsupported.
  assert.equal(r.detected, false);
});

test('supported claim does not flag', () => {
  const r = detectHallucination(
    trace(
      '<sources>Bart Smith founded Acme Corp in 1992. Acme makes paint.</sources>\nWho started Acme?',
      'Bart Smith founded Acme Corp.',
    ),
  );
  assert.equal(r.detected, false);
});

test('short completion is ignored', () => {
  const r = detectHallucination(trace('Sources: Hello world.\nWhat is in the sources?', 'Hello.'));
  assert.equal(r.detected, false);
});

test("common-knowledge entities don't trigger false positives", () => {
  const r = detectHallucination(
    trace(
      'Sources: Bart Smith founded Acme Corp in 1992 in San Francisco. Acme makes paint.',
      'Bart Smith founded Acme Corp in San Francisco. Acme operates in the United States and ships to New York and Los Angeles.',
    ),
  );
  // San Francisco/United States/New York/Los Angeles all in stoplist → no fire
  assert.equal(r.detected, false);
});

test('regression: real RAG-style answer with light recall does not fire', () => {
  // Realistic vibe-coder use: RAG bot with a Sources block and a faithful summary.
  const r = detectHallucination(
    trace(
      'Sources: PoolBird is a Pittsburgh startup that ships pool-cleaning robots. The company raised a seed round in March 2025. CEO is Anita Reyes.',
      'PoolBird ships pool-cleaning robots and is based in Pittsburgh. Anita Reyes leads the company. They raised a seed round in March 2025.',
    ),
  );
  assert.equal(r.detected, false);
});
