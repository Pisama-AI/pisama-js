# @pisama/sdk

[![npm version](https://img.shields.io/npm/v/%40pisama%2Fsdk)](https://www.npmjs.com/package/@pisama/sdk)
[![npm downloads](https://img.shields.io/npm/dm/%40pisama%2Fsdk)](https://www.npmjs.com/package/@pisama/sdk)
[![CI](https://github.com/Pisama-AI/pisama-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Pisama-AI/pisama-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40pisama%2Fsdk)](../../LICENSE)

Observe Vercel AI SDK model calls and send privacy-filtered traces to Pisama for
failure detection.

## Requirements

- Node.js 20 or newer
- `ai` 6.x
- An AI SDK provider that implements the `LanguageModelV3` contract
- A Pisama project ID for trace delivery

This package is ESM-only.

## Choose a release channel

`latest` remains the stable `0.8.x` line. The `alpha` channel contains the
`observe()` API, AI SDK 6 support, serverless delivery, and the current privacy
controls documented below.

```bash
# Stable
pnpm add @pisama/sdk

# Current prerelease
pnpm add @pisama/sdk@alpha ai@^6 @ai-sdk/openai@^2
```

Prereleases are published only under the npm `alpha` dist-tag. Stable versions
are published under `latest`. Pin an exact version in production if you need
fully repeatable installs.

## Quick start

Set the project ID in your server environment:

```bash
PISAMA_PROJECT_ID=ps_your_project_id
```

Get a project ID with `npx pisama init` or from
[pisama.ai](https://pisama.ai).

Wrap the model once:

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { observe } from "@pisama/sdk";

const model = observe(openai("gpt-4o"), {
  redact: "standard",
});

const result = await streamText({
  model,
  prompt: "Summarize the supplied incident report.",
});
```

`observe(model, options)` returns the same model type with Pisama middleware
attached. Existing AI SDK calls do not otherwise change.

## Verify the integration

Set `PISAMA_DEBUG=1`, make one model call, and confirm both signals:

1. The server logs a Pisama enabled message.
2. A trace appears at `https://pisama.ai/live/<projectId>`.

If no events are produced within 30 seconds, the SDK logs common causes such
as a missing environment variable, an unwrapped model, or blocked egress.

## Privacy and telemetry

Redaction runs in the SDK before trace data leaves the runtime. The ingest
service applies redaction again before storage.

| Mode | Behavior |
| --- | --- |
| `standard` | Redacts common PII and credential-shaped values. This is the default. |
| `aggressive` | Applies the broadest available local redaction. |
| `metadata-only` | Sends token counts and detector metadata without prompt or completion text. |
| `off` | Disables SDK redaction. Use only when your own controls are sufficient. |

```ts
const model = observe(baseModel, { redact: "metadata-only" });
```

Each ingest request includes anonymous client, SDK version, and runtime
headers. The client ID is randomly generated and is not derived from user
identity.

Environment controls:

| Variable | Effect |
| --- | --- |
| `PISAMA_PROJECT_ID` | Selects the destination project. Without it, middleware is a no-op. |
| `PISAMA_INGEST_URL` | Overrides the hosted ingest endpoint for self-hosted deployments. |
| `PISAMA_DEBUG=1` | Logs every flush result. |
| `PISAMA_SILENT=1` | Suppresses SDK logs without disabling delivery. |
| `PISAMA_TELEMETRY=false` | Disables events, headers, and network egress. |

## Serverless runtimes

The SDK automatically uses eager delivery on Vercel, Cloudflare Workers, AWS
Lambda, Netlify Functions, and Cloud Run. This keeps trace delivery inside the
request lifecycle when the runtime may freeze background work.

Override detection only when you understand the latency and delivery tradeoff:

```ts
const model = observe(baseModel, { eager: true });
```

## Advanced middleware composition

Use `pisamaMiddleware()` directly when combining multiple AI SDK middlewares:

```ts
import { wrapLanguageModel } from "ai";
import { pisamaMiddleware } from "@pisama/sdk";

const model = wrapLanguageModel({
  model: baseModel,
  middleware: [pisamaMiddleware(), yourOtherMiddleware],
});
```

For normal integrations, prefer `observe()`.

## Compatibility evidence

The release gate exercises packed artifacts on Node.js 20, 22, and 24.
Integration coverage includes Express, Hono, Next.js, and TanStack Start. It
also checks the public export surface, generated declarations, exact detector
dependency version, package metadata, and production dependency audit.

## Public API

| Export | Purpose |
| --- | --- |
| `observe` | Wrap a `LanguageModelV3` model in one call. |
| `pisamaMiddleware` | Compose Pisama with other AI SDK middleware. |
| `redactText`, `redactObject` | Apply the SDK redaction rules directly. |
| `SDK_VERSION` | Report the exact running SDK version. |

Type exports include `PisamaMiddlewareOptions`, `RedactMode`, `TraceEvent`, and
`ToolCall`.

## Support and security

- [Open a bug or feature request](https://github.com/Pisama-AI/pisama-js/issues)
- [Read the security policy](https://github.com/Pisama-AI/pisama-js/security/policy)
- [Review the source](https://github.com/Pisama-AI/pisama-js/tree/main/packages/sdk)

## License

[MIT](../../LICENSE)
