# Hono integration

The reference at `src/index.ts` shows `observe()` inside a Hono route.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Hono app

```bash
npm create hono@latest my-app
cd my-app
pnpm add @pisama/sdk@alpha ai@^6 @ai-sdk/openai@^2
# copy src/index.ts as a reference
PISAMA_PROJECT_ID=ps_your_project_id OPENAI_API_KEY="$OPENAI_API_KEY" pnpm dev
```

In another terminal, verify delivery:

```bash
PISAMA_PROJECT_ID=ps_your_project_id \
  npx --yes --package=@pisama/cli@latest -- pisama verify
```

The Hono-specific code is the route registration. The `observe()` call is
unchanged.
