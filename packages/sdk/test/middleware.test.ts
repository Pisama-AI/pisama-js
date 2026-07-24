import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { pisamaMiddleware } from '../src/middleware.js';
import { TraceExporter } from '../src/exporter.js';
import type { TraceEvent } from '../src/types.js';

interface CapturedRequest {
  url: string;
  body: { events: TraceEvent[] };
  headers: Record<string, string>;
}

function captureExporter() {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: string },
  ) => {
    captured.push({
      url: String(input),
      body: JSON.parse(init?.body ?? '{}'),
      headers: init?.headers ?? {},
    });
    return new Response(JSON.stringify({ accepted: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const exporter = new TraceExporter({
    projectId: 'ws_test',
    endpoint: 'http://test/api/v1/spans',
    fetchImpl,
    flushIntervalMs: 5,
    maxBatchSize: 1,
  });
  return { captured, exporter };
}

test('generateText: TraceEvent captured with text + tool calls + tokens', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'test-model',
    doGenerate: async () => ({
      content: [
        { type: 'text', text: 'Hello world' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'lookup',
          input: '{"query":"weather"}',
        },
      ],
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  await generateText({
    model: wrapped,
    prompt: 'Say hi.',
  });

  await exporter.flush();

  assert.equal(captured.length, 1, 'exporter should have flushed exactly one batch');
  const events = captured[0]!.body.events;
  assert.equal(events.length, 1);
  const ev = events[0]!;

  assert.equal(ev.projectId, 'ws_test');
  assert.equal(ev.model, 'test-model');
  assert.equal(ev.completion, 'Hello world');
  assert.equal(ev.inputTokens, 8);
  assert.equal(ev.outputTokens, 4);
  assert.equal(ev.finishReason, 'stop');
  assert.equal(ev.toolCalls.length, 1);
  assert.equal(ev.toolCalls[0]!.toolName, 'lookup');
  assert.deepEqual(ev.toolCalls[0]!.args, { query: 'weather' });
  assert.match(ev.prompt ?? '', /Say hi/);
  assert.equal(captured[0]!.headers['x-pisama-project-id'], 'ws_test');
});

test('streamText: deltas accumulate into completion text', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'stream-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Once ' },
          { type: 'text-delta', id: 't1', delta: 'upon ' },
          { type: 'text-delta', id: 't1', delta: 'a ' },
          { type: 'text-delta', id: 't1', delta: 'time.' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 5 },
              outputTokens: { total: 14 },
            },
          },
        ],
        chunkDelayInMs: null,
      }),
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  const result = streamText({
    model: wrapped,
    prompt: 'Tell me a story.',
  });

  // Consume the stream
  for await (const _ of result.textStream) {
    void _;
  }
  await result.consumeStream();

  await exporter.flush();

  assert.equal(captured.length, 1);
  const ev = captured[0]!.body.events[0]!;
  assert.equal(ev.completion, 'Once upon a time.');
  assert.equal(ev.inputTokens, 5);
  assert.equal(ev.outputTokens, 14);
  assert.equal(ev.finishReason, 'stop');
  assert.equal(ev.toolCalls.length, 0);
});

test('streamText: tool calls are collected through the stream', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'tool-model',
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'tc_1',
            toolName: 'search',
            input: '{"q":"bun"}',
          },
          {
            type: 'tool-call',
            toolCallId: 'tc_2',
            toolName: 'search',
            input: '{"q":"deno"}',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: { total: 12 }, outputTokens: { total: 6 } },
          },
        ],
        chunkDelayInMs: null,
      }),
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ projectId: 'ws_test', exporter, redact: 'off' }),
  });

  const result = streamText({
    model: wrapped,
    prompt: 'Search for bun and deno.',
  });
  await result.consumeStream();
  await exporter.flush();

  const ev = captured[0]!.body.events[0]!;
  assert.equal(ev.toolCalls.length, 2);
  assert.deepEqual(
    ev.toolCalls.map((t) => t.toolName),
    ['search', 'search'],
  );
  assert.deepEqual(ev.toolCalls[0]!.args, { q: 'bun' });
});

test('redact: standard mode strips emails from completion', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'redact-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Email me at hello@example.com please.' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 8 } },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({
      projectId: 'ws_test',
      exporter,
      redact: 'standard',
    }),
  });

  await generateText({ model: wrapped, prompt: 'What is your email?' });
  await exporter.flush();

  const ev = captured[0]!.body.events[0]!;
  assert.match(ev.completion ?? '', /\[email\]/);
  assert.doesNotMatch(ev.completion ?? '', /hello@example\.com/);
});

test('disabled middleware (no projectId) is a passthrough no-op', async () => {
  const { captured, exporter } = captureExporter();

  const model = new MockLanguageModelV3({
    modelId: 'noop-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'passthrough' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  });

  const wrapped = wrapLanguageModel({
    model,
    middleware: pisamaMiddleware({ exporter, enabled: false }),
  });

  const result = await generateText({ model: wrapped, prompt: 'Hi.' });
  await exporter.flush();

  assert.equal(result.text, 'passthrough');
  assert.equal(captured.length, 0, 'exporter should not have been called');
});
