# TanStack Start integration

This reference app wires `@pisama/sdk` through `observe()` in a TanStack Start
server route.

## Project files

- `src/routes/__root.tsx` defines the root route.
- `src/routes/index.tsx` provides the chat UI.
- `src/routes/api/chat.ts` wraps the AI SDK model with `observe()`.
- `tanstack-start.test.ts` exercises the middleware integration.

## Run the automated test

From the SDK package:

```bash
pnpm exec tsx test/integration/tanstack-start/tanstack-start.test.ts
```

The automated test is hermetic and does not prove hosted ingest. Use the live
verification below for end-to-end delivery evidence.

## Verify the real app

Provide a real OpenAI API key through your normal secret-management flow:

```bash
cd packages/sdk/test/integration/tanstack-start
pnpm install
PISAMA_PROJECT_ID=ps_your_project_id OPENAI_API_KEY="$OPENAI_API_KEY" pnpm dev
```

Open `http://localhost:3000`, send a chat message, then verify delivery in
another terminal:

```bash
PISAMA_PROJECT_ID=ps_your_project_id \
  npx --yes --package=@pisama/cli@latest -- pisama verify
```

The reference app validates the framework wiring. Hosted ingest and dashboard
behavior remain separate deployment contracts.
