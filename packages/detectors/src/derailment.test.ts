import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDerailment } from './derailment.js';
import type { AgentTrace } from './types.js';

const trace = (prompt: string, tools: string[]): AgentTrace => ({
  traceId: 't',
  startTime: 0,
  toolCalls: tools.map((t, i) => ({ toolName: t, startTime: i })),
  prompt,
});

test('aligned tools with stem match, no flag', () => {
  const r = detectDerailment(
    trace('Edit the README to add a quickstart section.', [
      'read_file',
      'edit_file',
      'edit_file',
      'edit_file',
      'edit_file',
    ]),
  );
  assert.equal(r.detected, false);
});

test('flags clearly drifting tools', () => {
  const r = detectDerailment(
    trace('Write a haiku about autumn leaves.', [
      'execute_sql',
      'execute_sql',
      'execute_sql',
      'execute_sql',
      'execute_sql',
      'execute_sql',
    ]),
  );
  assert.equal(r.detected, true);
  assert.match(r.summary, /drifts/i);
});

test('under tool-count threshold, no flag', () => {
  const r = detectDerailment(
    trace('Write a haiku about autumn leaves.', ['execute_sql', 'execute_sql', 'execute_sql']),
  );
  assert.equal(r.detected, false);
});

test('no clear task verb in prompt, no flag', () => {
  const r = detectDerailment(trace('Hi there!', ['a', 'b', 'c', 'd', 'e', 'f']));
  assert.equal(r.detected, false);
});

test('regression: research-then-act pattern is allowed (universal tool)', () => {
  // The agent searched first, then wrote. Common pattern, must not fire.
  const r = detectDerailment(
    trace('Write a blog post about Bun.', [
      'web_search',
      'web_search',
      'read_url',
      'execute_sql',
      'execute_sql',
      'execute_sql',
    ]),
  );
  assert.equal(r.detected, false);
});

test("regression: vague verb in prompt doesn't trigger derailment alone", () => {
  const r = detectDerailment(
    trace('Help me figure this out.', [
      'execute_sql',
      'execute_sql',
      'execute_sql',
      'execute_sql',
      'execute_sql',
    ]),
  );
  assert.equal(r.detected, false);
});

test('regression: stem match across verb morphologies', () => {
  // Verb "compose" matches tool name "composer.create"
  const r = detectDerailment(
    trace('Compose a follow-up email.', [
      'composer.create',
      'composer.create',
      'composer.create',
      'composer.create',
      'composer.send',
    ]),
  );
  assert.equal(r.detected, false);
});

test("regression: realistic cooking-recipe agent doesn't fire", () => {
  const r = detectDerailment(
    trace('Generate a weekly meal plan for a family of four with budget under $150.', [
      'recipe_search',
      'recipe_search',
      'nutrition_lookup',
      'shopping_list',
      'shopping_list',
    ]),
  );
  // recipe_SEARCH is universal -> exempt
  assert.equal(r.detected, false);
});

test('aligned tools, no flag (legacy case)', () => {
  const r = detectDerailment(
    trace('Search for and summarize recent posts about Bun.', [
      'web_search',
      'web_search',
      'summarize',
      'write_file',
      'summarize',
    ]),
  );
  assert.equal(r.detected, false);
});
