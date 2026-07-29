# TanStack Start integration reference

A runnable TanStack Start app that wires `@pisama/sdk` via the `observe()` helper. This is the reference Lovable's AI should target when wiring pisama into a Lovable project — Lovable runs TanStack Start, not Next.js.

## What's here

- `src/routes/__root.tsx` — TanStack root route
- `src/routes/index.tsx` — minimal chat UI
- `src/routes/api/chat.ts` — **the load-bearing file**: TanStack Start server route that wraps `openai('gpt-4o-mini')` with `observe()`
- `tanstack-start.test.ts` — automated integration test that uses a mock model (no OpenAI spend) and verifies pisama's exporter fires correctly

## Run the automated test

From the SDK package root:

```bash
cd packages/sdk
pnpm exec tsx test/integration/tanstack-start/tanstack-start.test.ts
```

Or just `pnpm test` from `packages/sdk` to run all SDK tests including this one.

This exercises `observe()` against the AI SDK's `LanguageModelV3` contract using mock fetch and a mock model. Passing the test proves the SDK works correctly in any framework that respects the AI SDK middleware contract — TanStack Start included.

## Run the real app (manual verification)

Requires `OPENAI_API_KEY` and `WHOOPSIE_PROJECT_ID` env vars.

```bash
cd packages/sdk/test/integration/tanstack-start
pnpm install
WHOOPSIE_PROJECT_ID=ws_yourid OPENAI_API_KEY=sk-... pnpm dev
```

Open http://localhost:3000 and send a chat message. The hosted ingest route is not currently served, so the exporter reports the rejected batch rather than delivering it.

## Why this exists

Today's cross-platform test found that Lovable's AI accepted the pisama install but the integration silently no-op'd — chat returned real OpenAI completions, zero traces fired. Root cause was almost certainly framework mismatch: the install prompt's example was Next.js-shaped, Lovable runs TanStack Start. This reference proves that `observe()` works on TanStack Start at the SDK level, and gives the Lovable install prompt a concrete file structure to point at.

See `docs/PLATFORM_TESTING.md` for the manual verification rhythm.
