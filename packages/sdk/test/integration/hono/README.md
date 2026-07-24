# Hono integration

Hono is the common server framework for Cloudflare Workers, Bun, and Deno apps. Vibe-coder platforms that bundle for Workers (or that prefer the smaller runtime footprint) often default to Hono.

## Run the automated test

```bash
cd packages/sdk
pnpm test
```

## Verify in a real Hono app

```bash
npm create hono@latest my-app
cd my-app
pnpm add @pisama/sdk @ai-sdk/openai ai
# copy src/index.ts as a reference
WHOOPSIE_PROJECT_ID=ws_yourid OPENAI_API_KEY=sk-... pnpm dev
```

The `observe()` wrap is identical to all other frameworks. The Hono-specific bits are just the route registration: `app.post("/api/chat", ...)`.
