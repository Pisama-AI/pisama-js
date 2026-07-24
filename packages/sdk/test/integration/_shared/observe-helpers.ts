// Shared test utilities for cross-framework integration tests. Each framework
// (Next.js, TanStack Start, Hono, Express, etc.) gets its own .test.ts that
// imports these helpers, demonstrates the framework-idiomatic route shape in
// src/, and runs the same observe() integration assertions. The SDK contract
// is framework-agnostic, so passing this helper suite proves the SDK works
// on whichever runtime is calling it.

import { simulateReadableStream } from 'ai';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';

export interface CapturedEvent {
  endpoint: string;
  body: { events: unknown[] };
}

export function setupFetchCapture(): {
  captured: CapturedEvent[];
  restore: () => void;
} {
  const captured: CapturedEvent[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/v1/spans')) {
      captured.push({
        endpoint: url,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(JSON.stringify({ accepted: 1, detections: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = originalFetch) };
}

export function mockTextModel(text: string, modelId = 'mock'): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId,
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        warnings: [],
      };
    },
    async doStream() {
      const stream = simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: text },
          { type: 'text-end', id: 't0' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          },
        ] as LanguageModelV3StreamPart[],
      });
      return { stream, warnings: [] };
    },
  };
}

/**
 * Mock model that emits reasoning content alongside the final text. Used to
 * verify the middleware captures `reasoning-delta` stream parts and
 * `type: "reasoning"` content parts from doGenerate. The Vercel AI SDK v6
 * spec for reasoning is documented in
 * node_modules/@ai-sdk/provider/dist/index.d.ts (LanguageModelV3ReasoningPart
 * and the reasoning-start / reasoning-delta / reasoning-end stream parts).
 */
export function mockReasoningModel(
  reasoning: string,
  text: string,
  modelId = 'mock-reasoning',
): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId,
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        warnings: [],
      };
    },
    async doStream() {
      const stream = simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'reasoning-start', id: 'r0' },
          { type: 'reasoning-delta', id: 'r0', delta: reasoning },
          { type: 'reasoning-end', id: 'r0' },
          { type: 'text-start', id: 't0' },
          { type: 'text-delta', id: 't0', delta: text },
          { type: 'text-end', id: 't0' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          },
        ] as LanguageModelV3StreamPart[],
      });
      return { stream, warnings: [] };
    },
  };
}

export function failingModel(modelId = 'mock-failing'): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error('simulated model failure');
    },
    async doStream() {
      throw new Error('simulated model failure');
    },
  };
}
