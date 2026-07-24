# Express integration

Replit Agent commonly defaults to Express for backend APIs. The reference at `src/index.ts` shows the `observe()` wrap inside a standard Express route.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Express app

```bash
mkdir my-app && cd my-app
pnpm init
pnpm add express @pisama/sdk @ai-sdk/openai ai
# copy src/index.ts as a reference
WHOOPSIE_PROJECT_ID=ws_yourid OPENAI_API_KEY=sk-... node --loader tsx src/index.ts
```

Express is more verbose than Hono/Next/TanStack for AI SDK responses because Express doesn't natively support `Response` objects — see `src/index.ts` for the pipe-through pattern. The `observe()` wrap itself is unchanged.
