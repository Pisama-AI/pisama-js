// Integration test for @pisama/sdk on TanStack Start (Lovable's framework).
// The reference route is at src/routes/api/chat.ts — TanStack Start's
// server-route convention. We exercise the SDK contract directly here rather
// than booting a full TanStack server, because the middleware operates at the
// AI SDK's LanguageModelV4 layer, which is framework-agnostic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText } from 'ai';
import { observe } from '../../../src/index.js';
import { setupFetchCapture, mockTextModel, failingModel } from '../_shared/observe-helpers.js';

test('TanStack Start: observe() emits an event end-to-end', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_tanstack_test_gen';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockTextModel('hi from tanstack', 'mock-gpt-4o-mini'), {
      redact: 'metadata-only',
    });
    const result = await streamText({ model, prompt: 'say hi' });
    for await (const _ of result.textStream) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(captured.length > 0);
    const events = captured[0]!.body.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.projectId, 'ws_tanstack_test_gen');
    assert.equal(ev.model, 'mock-gpt-4o-mini');
    assert.equal(ev.finishReason, 'stop');
    assert.equal(ev.completion, undefined, 'metadata-only redacts completion');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});

test('TanStack Start: observe() captures errors', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_tanstack_test_err';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(failingModel(), { redact: 'metadata-only' });
    try {
      const result = await streamText({ model, prompt: 'trigger failure' });
      for await (const _ of result.textStream) {
        // drain
      }
    } catch {
      // expected
    }
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(captured.length > 0);
    const ev = captured[0]!.body.events[0] as Record<string, unknown>;
    assert.equal(ev.projectId, 'ws_tanstack_test_err');
    assert.ok((ev.error as { message?: string })?.message?.includes('simulated'));
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});

test('TanStack Start: observe() preserves model output (transparency)', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_tanstack_test_transparent';
  process.env.PISAMA_SILENT = '1';
  const { restore } = setupFetchCapture();
  try {
    const model = observe(mockTextModel('transparent output'), {
      redact: 'metadata-only',
    });
    const result = await streamText({ model, prompt: 'anything' });
    let collected = '';
    for await (const chunk of result.textStream) {
      collected += chunk;
    }
    assert.equal(collected, 'transparent output');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});
