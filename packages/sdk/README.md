## @pisama/sdk

```bash
pnpm add @pisama/sdk
```

```ts
import { observe } from "@pisama/sdk";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = observe(openai("gpt-4o"), { redact: "metadata-only" });

const result = await streamText({ model, prompt: "..." });
```

Set `PISAMA_PROJECT_ID` in `.env.local`. Get yours from `npx pisama init` (or sign up at https://pisama.ai).

`observe(model, opts)` is the canonical entry point. It returns the model with pisama's middleware attached: one function call, no `wrapLanguageModel` ceremony.

### Advanced

If you need direct access to the middleware (e.g. you're composing multiple middlewares), import `pisamaMiddleware` and pass it to `wrapLanguageModel` yourself:

```ts
import { wrapLanguageModel } from "ai";
import { pisamaMiddleware } from "@pisama/sdk";

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: [pisamaMiddleware(), yourOtherMiddleware],
});
```

### Privacy

PII is redacted in the SDK before bytes leave the machine. Default mode is `standard` (emails, phones, SSNs, cards, JWTs, OpenAI/Anthropic/AWS/GitHub/Slack-shaped API keys). Pass `redact: 'aggressive'` for more, `'metadata-only'` for token counts and detector verdicts only, or `'off'` to disable. The ingest server re-runs the same redaction patterns before writing to storage: defense in depth.

```ts
observe(model, { redact: "metadata-only" });
```

### Diagnostics

The SDK is loud by default about whether it's wired correctly. On first model call, you'll see:

```
[pisama] enabled · project=ps_abc123… · redact=metadata-only
```

If no events fire within 30 seconds, the SDK logs a warning with the most common causes (wrong wrap, file not imported, missing env var, blocked egress) and a link to verify on your dashboard. This catches silent integration failures that previously looked identical to working integration.

### Telemetry and opt-out

The SDK ships traces (your prompt, completion, token counts, model id, finish reason, timing) to your project's dashboard at `pisama.ai/live/<projectId>`. It also attaches three diagnostic headers on each ingest request:

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
