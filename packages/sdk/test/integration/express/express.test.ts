// Integration test for @pisama/sdk on Express (Replit Agent's common
// default). Same observe() contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText } from 'ai';
import { observe } from '../../../src/index.js';
import { setupFetchCapture, mockTextModel } from '../_shared/observe-helpers.js';

test('Express: observe() emits an event end-to-end', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_express_test_gen';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockTextModel('hi from express', 'mock-gpt-4o-mini'), {
      redact: 'metadata-only',
    });
    const result = await streamText({ model, prompt: 'say hi' });
    for await (const _ of result.textStream) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(captured.length > 0);
    const ev = captured[0]!.body.events[0] as Record<string, unknown>;
    assert.equal(ev.projectId, 'ws_express_test_gen');
    assert.equal(ev.model, 'mock-gpt-4o-mini');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});
