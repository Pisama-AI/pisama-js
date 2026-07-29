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

Set `PISAMA_PROJECT_ID` in `.env.local`. Get yours from `npx pisama init` (or sign up at https://pisama.ai).

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

PII is redacted in the SDK before bytes leave the machine. Default mode is `standard` (emails, phones, SSNs, cards, JWTs, OpenAI/Anthropic/AWS/GitHub/Slack-shaped API keys). Pass `redact: 'aggressive'` for more, `'metadata-only'` for token counts and detector verdicts only, or `'off'` to disable. Redaction is client-side only. This version does not reach a server-side redaction pass, because the hosted ingest route it targets is not currently served (see below).

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

The SDK collects traces (your prompt, completion, token counts, model id, finish reason, timing) and posts them to `POST /api/v1/spans`. **That route is not currently served by `api.pisama.ai` and returns 404**, so traces from this version do not reach the hosted dashboard. The exporter reports every rejected batch, with the status, the endpoint and the number of events dropped, rather than discarding them silently as versions before 0.9.0 did. Point `PISAMA_INGEST_URL` at a deployment that serves this contract if you need delivery today. It also attaches three diagnostic headers on each ingest request:

- `x-pisama-client-id`: anonymous 16-char id, persisted to `~/.pisama/client.json` so retention can be measured per install
- `x-pisama-sdk-version`: the published version of `@pisama/sdk`
- `x-pisama-runtime`: `node`, `bun`, `deno`, or `edge`

No PII is included in these headers. The client id is random, not derived from anything user-identifying.

Env vars:

- `PISAMA_DEBUG=1`: log every flush with HTTP status. Useful when integration is silently failing.
- `PISAMA_SILENT=1`: suppress all SDK logging (does not affect egress).
- `PISAMA_TELEMETRY=false`: master kill switch. No events, no headers, no network egress. Use this if you want pisama installed but inactive.

### License

MIT
