// Reasoning capture tests. SDK 0.5.0 adds a `reasoning` field to TraceEvent
// and wires the middleware to collect:
//   - `reasoning-delta` stream parts (LanguageModelV3/V4 streaming contract —
//     unchanged field shape across the ai@6 -> ai@7 migration)
//   - `type: "reasoning"` content parts from doGenerate
//
// Both go through the same redactObject pipeline as prompt/completion. Under
// `redact: "metadata-only"` mode reasoning is dropped to `undefined`; under
// `redact: "standard"` it ships with PII patterns scrubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText } from 'ai';
import { observe } from '../src/observe.js';
import { mockReasoningModel, setupFetchCapture } from './integration/_shared/observe-helpers.js';

const FLUSH_WAIT_MS = 1300;

async function flush() {
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));
}

interface CapturedTrace {
  prompt?: string;
  completion?: string;
  reasoning?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function firstEvent(captured: { length: number; [i: number]: unknown }[]): CapturedTrace {
  // The middleware POSTs to /api/v1/spans with body { events: [{ ... }] }.
  const body = (captured as unknown as { body: { events: CapturedTrace[] } }[])[0]!.body;
  return body.events[0]!;
}

test('wrapStream captures reasoning content from reasoning-delta parts', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_reasoning_stream';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockReasoningModel('I should add 2 + 2.', '4', 'mock-r1'), {
      redact: 'standard',
    });
    const result = await streamText({ model, prompt: 'what is 2 + 2?' });
    for await (const _ of result.textStream) {
      // drain
    }
    await flush();
    assert.ok(captured.length > 0, 'expected at least one trace POST');
    const ev = firstEvent(captured as unknown as { length: number; [i: number]: unknown }[]);
    assert.equal(ev.reasoning, 'I should add 2 + 2.');
    assert.equal(ev.completion, '4');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});

test("wrapGenerate captures reasoning content from type:'reasoning' content parts", async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_reasoning_gen';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockReasoningModel('Let me think — 7 × 8 is 56.', '56', 'mock-r-gen'), {
      redact: 'standard',
    });
    const out = await generateText({ model, prompt: 'what is 7 times 8?' });
    assert.equal(out.text, '56');
    await flush();
    assert.ok(captured.length > 0, 'expected at least one trace POST');
    const ev = firstEvent(captured as unknown as { length: number; [i: number]: unknown }[]);
    assert.equal(ev.reasoning, 'Let me think — 7 × 8 is 56.');
    assert.equal(ev.completion, '56');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});

test('reasoning is PII-scrubbed under standard mode', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_reasoning_pii';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(
      mockReasoningModel(
        "The user's email alice@example.com matches the record.",
        'ok',
        'mock-r-pii',
      ),
      { redact: 'standard' },
    );
    const result = await streamText({ model, prompt: 'lookup user' });
    for await (const _ of result.textStream) {
      // drain
    }
    await flush();
    const ev = firstEvent(captured as unknown as { length: number; [i: number]: unknown }[]);
    assert.match(
      String(ev.reasoning),
      /\[email\]/,
      'email in reasoning text should be replaced with [email]',
    );
    assert.doesNotMatch(
      String(ev.reasoning),
      /alice@example\.com/,
      'raw email must not appear in the shipped reasoning text',
    );
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});

test('reasoning is undefined under metadata-only mode', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_reasoning_strict';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockReasoningModel('private chain of thought', 'x', 'mock-r-strict'), {
      redact: 'metadata-only',
    });
    const result = await streamText({ model, prompt: 'p' });
    for await (const _ of result.textStream) {
      // drain
    }
    await flush();
    const ev = firstEvent(captured as unknown as { length: number; [i: number]: unknown }[]);
    assert.equal(
      ev.reasoning,
      undefined,
      'metadata-only must drop reasoning to undefined, like prompt/completion',
    );
    assert.equal(ev.completion, undefined);
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});
