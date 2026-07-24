# @pisama/cli

Install Pisama instrumentation, verify ingestion, analyze Harbor ATIF
trajectories, and expose failure data to MCP clients.

Requires Node.js 20 or newer. You can run every command through `npx` without
a global install.

### `pisama init`

```bash
npx @pisama/cli init
```

For a persistent command, install the package globally and run `pisama`:

```bash
npm install --global @pisama/cli
pisama init
```

Run this inside your Next.js and Vercel AI SDK project. The CLI:

1. Detects `ai` + `next` in `package.json`.
2. Uses the TypeScript AST to patch the first `streamText` or `generateText`
   call so its model is wrapped with `observe(model)` from `@pisama/sdk`.
3. Writes `PISAMA_PROJECT_ID` to `.env.local`.
4. Opens `https://pisama.ai/live/<projectId>`.

Hit your chat route once. The first failure your agent throws will show up live.

Flags:

- `--cwd <path>`: project root (default: cwd)
- `--no-open`: skip browser open
- `--dry-run`: print planned changes, don't write

### `pisama verify`

```bash
npx @pisama/cli verify
```

Posts a synthetic trace to Pisama's ingest API and waits for it to surface on
`/live/<projectId>`. Use this after installation to prove the full round trip
works independently of the SDK instrumentation. If `verify` succeeds but your
real chat produces no traces, check that the model is wrapped in a code path
your application actually imports.

Project ID resolution order:

1. `--project-id`
2. `PISAMA_PROJECT_ID`
3. `.env.local` in `--cwd`

Flags:

- `--cwd <path>`: project root for reading `.env.local` (default: cwd)
- `-p, --project-id <id>`: override the resolved project id
- `--base-url <url>`: point at a self-hosted Pisama API (default `https://api.pisama.ai`)
- `--timeout-ms <ms>`: how long to wait for the trace to surface (default 15000)

Exit code is 0 on success, 1 on any failure (no project id, ingest 5xx, network error, or trace didn't land within the timeout).

### `pisama analyze-atif`

Analyze one ATIF trajectory, a flat directory of trajectories, or a Harbor job
output directory:

```bash
npx @pisama/cli analyze-atif ./harbor-output
```

The command validates ATIF v1.0 through v1.7, sends each real trajectory to
Pisama's analysis endpoint, prints detector evidence, and exits with code 1
when a high-severity finding is present. This makes it suitable for CI gates.

Use `--base-url` for a self-hosted Pisama API. `--project-id` adds project
correlation to the analysis request.

To apply the primary recommended fix, pass a single trajectory and explicitly
provide the target framework, entity, and credentials:

```bash
npx @pisama/cli analyze-atif ./trajectory.json \
  --apply \
  --framework n8n \
  --entity-id workflow-id \
  --credentials ./n8n-credentials.json
```

Apply mode is intentionally limited to one trajectory. Credentials may be an
inline JSON object or a path to a JSON file. Review the target and use
least-privilege credentials before applying a change.

Trajectory content is sent to the configured Pisama API for analysis. Review
your data handling requirements before analyzing sensitive production traces.

### `pisama mcp`

Runs an MCP server over stdio so any MCP-compatible AI assistant can read your
project's failures inline. The server exposes three read-only tools:

- `get_recent_failures(limit?)`: recent traces that fired any detector
- `get_recent_traces(limit?)`: recent traces, regardless of failure status
- `get_trace(traceId)`: full prompt, completion, tool calls, detector hits for one trace

#### Connecting an MCP client

Add this to your MCP client's server config (path varies by client: consult your client's docs):

```json
{
  "mcpServers": {
    "pisama": {
      "command": "npx",
      "args": ["-y", "@pisama/cli", "mcp"],
      "env": { "PISAMA_PROJECT_ID": "ws_yourprojectid" }
    }
  }
}
```

Then ask your assistant something like, "What did my AI agent break in the
last hour?" The assistant can call `get_recent_failures` and answer with data
from your Pisama project.

Flags:

- `-p, --project-id <id>`: overrides the `PISAMA_PROJECT_ID` env var
- `--base-url <url>`: point at a self-hosted Pisama API (default `https://api.pisama.ai`)

## Support

Report defects in the
[Pisama JavaScript repository](https://github.com/Pisama-AI/pisama-js/issues).
The public API exposes its current dependency health at
[api.pisama.ai/api/v1/health](https://api.pisama.ai/api/v1/health).
