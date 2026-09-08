## @pisama/sdk

```bash
pnpm add @pisama/sdk
```

```ts
import { observe } from '@pisama/sdk';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

const model = observe(openai('gpt-4o'), { redact: 'metadata-only' });

const result = await streamText({ model, prompt: '...' });
```

Set `PISAMA_API_KEY` in the server runtime. Create a key at
`https://pisama.ai/settings/api-keys`. Keep it out of browser bundles and
client components. `PISAMA_PROJECT_ID` is an optional service label for
existing installations; it is not an authentication credential.

`observe(model, opts)` is the canonical entry point. It returns the model with pisama's middleware attached: one function call, no `wrapLanguageModel` ceremony.

### Advanced

If you need direct access to the middleware (e.g. you're composing multiple middlewares), import `pisamaMiddleware` and pass it to `wrapLanguageModel` yourself:

```ts
import { wrapLanguageModel } from 'ai';
import { pisamaMiddleware } from '@pisama/sdk';

const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: [pisamaMiddleware(), yourOtherMiddleware],
});
```

### Privacy

Recognized sensitive-value patterns are redacted in the SDK before bytes leave the machine. Default mode is `standard` (emails, phones, SSNs, cards, JWTs, Pisama/OpenAI/Anthropic/AWS/GitHub/Slack-shaped API keys). Pass `redact: 'aggressive'` for more, `'metadata-only'` to remove prompt/completion/error content while retaining model ID, token counts, finish reason, tool-call ID/name/timing, detector verdicts, and base metadata, or `'off'` to disable. An explicitly configured contact value is retained in metadata-only mode. Redaction is client-side and happens before the OTLP payload is serialized; identifiers and custom metadata should not contain secrets.

```ts
observe(model, { redact: 'metadata-only' });
```

### Diagnostics

The SDK is loud by default about whether it's wired correctly. On first model call, you'll see:

```
[pisama] enabled · project=ps_abc123… · redact=metadata-only
```

If no events fire within 30 seconds, the SDK logs a warning with the most common causes (wrong wrap, file not imported, missing env var, blocked egress) and where to verify. This catches silent integration failures that previously looked identical to working integration.

### Telemetry and opt-out

The SDK collects traces (your prompt, completion, token counts, model id,
finish reason, timing), encodes them as OTLP JSON, and posts them to
`POST /api/v1/traces/ingest`. Before ingest it exchanges `PISAMA_API_KEY` at
`POST /api/v1/auth/token` for an ingest-scoped JWT. The JWT is cached; if the
server returns 401, the exporter re-exchanges once and retries the exact batch
with the same `X-Request-ID`. The raw API key is never sent as bearer auth.

Missing credentials fail closed with no network request. Rejected batches are
reported with their status and endpoint instead of being silently discarded.
`PISAMA_INGEST_URL` can point to a self-hosted deployment that implements the
same authenticated route. Ingest requests also attach diagnostic headers:

- `x-pisama-client-id`: anonymous 16-char id, persisted to `~/.pisama/client.json` so retention can be measured per install
- `x-pisama-sdk-version`: the published version of `@pisama/sdk`
- `x-pisama-runtime`: `node`, `bun`, `deno`, or `edge`

No PII is included in these headers. The client id is random, not derived from anything user-identifying.

Env vars:

- `PISAMA_API_KEY`: required server-side credential. It is exchanged for a scoped access token.
- `PISAMA_PROJECT_ID`: optional service label retained for existing installations.
- `PISAMA_INGEST_URL`: optional full OTLP ingest URL (default `https://api.pisama.ai/api/v1/traces/ingest`).
- `PISAMA_DEBUG=1`: log every flush with HTTP status. Useful when integration is silently failing.
- `PISAMA_SILENT=1`: suppress all SDK logging (does not affect egress).
- `PISAMA_TELEMETRY=false`: master kill switch. No events, no headers, no network egress. Use this if you want pisama installed but inactive.

### License

MIT
