// Integration test for @pisama/sdk on Hono (Cloudflare Workers / Bun).
// Same observe() contract — the SDK is framework-agnostic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText } from 'ai';
import { observe } from '../../../src/index.js';
import { setupFetchCapture, mockTextModel } from '../_shared/observe-helpers.js';

test('Hono: observe() emits an event end-to-end', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_hono_test_gen';
  process.env.PISAMA_SILENT = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const model = observe(mockTextModel('hi from hono', 'mock-gpt-4o-mini'), {
      redact: 'metadata-only',
    });
    const result = await streamText({ model, prompt: 'say hi' });
    for await (const _ of result.textStream) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 1200));

    assert.ok(captured.length > 0);
    const ev = captured[0]!.body.events[0] as Record<string, unknown>;
    assert.equal(ev.projectId, 'ws_hono_test_gen');
    assert.equal(ev.model, 'mock-gpt-4o-mini');
  } finally {
    restore();
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});
