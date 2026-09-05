# @pisama/cli

Install Pisama instrumentation, verify ingestion, analyze Harbor ATIF
trajectories, and expose failure data to MCP clients.

Requires Node.js 20 or newer. You can run every command through `npx` without
a global install.

| Command                  | Purpose                                  | Network behavior                                                         |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| `pisama-ts init`         | Patch a Next.js and AI SDK project       | Opens the project dashboard unless `--no-open` is set                    |
| `pisama-ts verify`       | Prove ingestion and dashboard visibility | Sends a generated verification trace to the configured API               |
| `pisama-ts analyze-atif` | Analyze Harbor ATIF trajectories         | Sends trajectory content to the configured API (or none, with `--local`) |
| `pisama-ts mcp`          | Expose Pisama failures to an MCP client  | Reads authenticated tenant trace data from the configured API            |

The `pisama` and `pisama-ts` commands are equivalent starting in version
0.10.3. The registry-backed examples use `pisama-ts` so they also work with
earlier public releases.

Check the installed version at any time:

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts --version
```

### `pisama-ts init`

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts init
```

For a persistent command, install the package globally and run `pisama-ts`:

```bash
npm install --global @pisama/cli
pisama-ts init
```

Run this inside your Next.js and Vercel AI SDK project. The CLI:

1. Detects `ai` + `next` in `package.json`.
2. Uses the TypeScript AST to patch the first `streamText` or `generateText`
   call so its model is wrapped with `observe(model)` from `@pisama/sdk`.
3. Writes an optional `PISAMA_PROJECT_ID` service label to `.env.local`.
4. Checks for `PISAMA_API_KEY` and points to the API-key settings page when it
   is missing. The CLI never invents or persists this secret; configure it in
   the server runtime.
5. Prints the command to install `@pisama/sdk` when it is missing. The CLI does not
   edit your `package.json`, so run that command yourself before building.
6. Opens `https://pisama.ai/dashboard`.

Hit your chat route once. The first failure your agent throws will show up live.

Flags:

- `--cwd <path>`: project root (default: cwd)
- `--no-open`: skip browser open
- `--dry-run`: print planned changes, don't write

### `pisama-ts verify`

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts verify
```

Exchanges `PISAMA_API_KEY` for narrowly scoped access tokens, posts a generated
OTLP JSON trace to Pisama's authenticated ingest API, and waits for it to
surface through the tenant read API. Tokens are cached by scope and exchanged
at most once again after a 401; the raw key is never sent as bearer auth. Use
this after installation to prove the full round trip independently of SDK
instrumentation. If `verify` succeeds but your real chat produces no traces,
check that the model is wrapped in a code path your application actually
imports.

API-key resolution order:

1. `--api-key`
2. `PISAMA_API_KEY`

Flags:

- `--cwd <path>`: project root for reading `.env.local` (default: cwd)
- `--api-key <key>`: override `PISAMA_API_KEY` (prefer the environment to avoid shell history)
- `--base-url <url>`: point at a self-hosted Pisama API (default `https://api.pisama.ai`)
- `--timeout-ms <ms>`: positive finite total deadline for authentication, ingest,
  and trace readback (default 15000)

Exit code is 0 on success, 1 on any failure (missing/rejected key, insufficient
scope, ingest 5xx, network error, or trace not landing within the timeout).

### `pisama-ts analyze-atif`

Analyze one ATIF trajectory, a flat directory of trajectories, or a Harbor job
output directory:

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts analyze-atif ./harbor-output
```

The command accepts ATIF v1.0 through v1.7 and checks any explicit schema
version in both modes below. Matching the backend model, an omitted version is
set to ATIF-v1.7 in memory; explicit null, empty, or unknown values are rejected.
The source file is never changed. It prints detector evidence and exits with
code 1 when a high-severity finding is present, making it suitable for CI gates.

- **Default**: sends each trajectory to Pisama's `/api/v1/atif/analyze`
  endpoint, which runs the full calibrated backend detector suite (and
  supports `--apply` healing). Requires network access and `PISAMA_API_KEY`.
  The key is exchanged for a read-scoped JWT, or a full-scoped JWT when you
  explicitly pass `--apply`; it is never sent as bearer auth. A 401 causes at
  most one token re-exchange and exact request retry. The command rejects a
  response whose trace, schema, session, trajectory, or unresolved-topology
  identity does not match the submitted source. For an anonymous document
  (both identity fields absent, null, or empty), the CLI adds a deterministic
  `pisama-anonymous-…` trajectory ID to the in-memory request clone only. That
  ID is a domain-separated full SHA-256 of the original UTF-8 file bytes: the
  same bytes are idempotent, while a content or formatting change intentionally
  gets a different ID. The file on disk is never changed. This CLI-assigned
  byte identity intentionally differs from the backend's canonical-step
  identity when an anonymous document is posted directly without the CLI.
  Across a multi-file selection, a server-unresolved file-backed trajectory
  reference is reconciled only when its canonical target was also selected and
  submitted; an ID-only, missing, absolute, or escaping reference remains
  incomplete and makes the command exit 1.
- **`--local`**: runs `@pisama/detectors`' v1 pack (loop, repetition, cost,
  completion, hallucination, context, derailment) in-process. No network
  call, no API key, and no `--apply` — it's a simplified subset of the
  backend's suite, the same one `@pisama/detectors` documents itself as, not
  a replacement for it. `@pisama/cli` depends on `@pisama/detectors`
  directly, so this works with no separate install. The CLI validates the
  projection fields and flattens ATIF multimodal content using the backend's
  text/image convention before detection. Any local detector exception makes
  the result incomplete and the command exits 1; it is never reported clean.
  File-backed continuation and subagent references are complete only when the
  canonical target is also in the selected trajectory set. Missing, escaping,
  or ID-only references remain incomplete. Embedded `subagent_trajectories`
  require hosted analysis because the simplified local projection does not
  recursively analyze them; local mode exits 1 instead of calling them clean.
  Local trace attribution uses the same session-first, continuation-normalized
  identity order as hosted analysis, including the byte-derived fallback for
  anonymous files.

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts analyze-atif ./harbor-output --local
```

Use `--base-url` for a self-hosted Pisama API. `--project-id` adds project
correlation to the analysis request. Both are ignored in `--local` mode.

To apply the primary recommended fix, pass a single trajectory and explicitly
provide the target framework, entity, and credentials:

```bash
npx --yes --package=@pisama/cli@latest -- pisama-ts analyze-atif ./trajectory.json \
  --apply \
  --framework n8n \
  --entity-id workflow-id \
  --credentials ./n8n-credentials.json
```

Apply mode is intentionally limited to one trajectory. Credentials may be an
inline JSON object or a path to a JSON file. Review the target and use
least-privilege credentials before applying a change.

Trajectory content is sent to the configured Pisama API for analysis, unless
you pass `--local`. Review your data handling requirements before analyzing
sensitive production traces; `--local` keeps trajectory content on your
machine entirely, at the cost of the backend's full calibrated suite.

### `pisama-ts mcp`

Runs an MCP server over stdio so any MCP-compatible AI assistant can read your
tenant's failures inline. The server exchanges `PISAMA_API_KEY` for a
read-scoped JWT and uses the authenticated tenant API. The raw key is never a
bearer token, and each protected request re-exchanges at most once after a 401. The server exposes three read-only tools:

- `get_recent_failures(limit?)`: recent traces that fired any detector
- `get_recent_traces(limit?)`: recent traces, regardless of failure status
- `get_trace(traceId)`: available prompt/completion state, trace metadata, and detector hits

The current tenant state response does not expose stored tool-call objects;
`get_trace` therefore reports `toolCalls: []` and
`metadata.toolCallsAvailable: false` instead of inventing data.

It also exposes four reusable MCP prompts:

- `investigate_recent_failures`: triage failures for a configurable lookback
- `explain_trace`: explain one trace from detector evidence
- `propose_fix`: inspect a failure and propose a reviewable fix
- `daily_quality_report`: summarize recent trace and failure health

#### Connecting an MCP client

Add this to your MCP client's server config (path varies by client: consult your client's docs):

```json
{
  "mcpServers": {
    "pisama": {
      "command": "npx",
      "args": ["--yes", "--package=@pisama/cli@latest", "--", "pisama-ts", "mcp"],
      "env": { "PISAMA_API_KEY": "pisama_your_server_side_key" }
    }
  }
}
```

Then ask your assistant something like, "What did my AI agent break in the
last hour?" The assistant can call `get_recent_failures` and answer with data
from your Pisama tenant.

Flags:

- `--api-key <key>`: overrides `PISAMA_API_KEY` (prefer the environment to avoid shell history)
- `--base-url <url>`: point at a self-hosted Pisama API (default `https://api.pisama.ai`)

## Trust and privacy

`init --dry-run` shows source and environment-file changes without writing
them. `verify`, `analyze-atif`, and `mcp` communicate with the configured API,
so use `--base-url` for a self-hosted deployment when data must stay in your
environment, or `analyze-atif --local` to skip the network entirely. Do not
pass credentials through shared shell history. For `analyze-atif --apply`,
prefer a least-privilege credentials file and remove it when the operation is
complete.

Official releases are built from an immutable tag whose commit is on `main`,
tested on Node.js 20 and 24, installed from the exact digest-bound tarball, and
checked for vulnerable production dependencies. The package-specific workflow
can only stage through npm trusted publishing; a human separately inspects and
approves that stage with 2FA. Registry/account readback and token-revocation
gates are mandatory before staging; see the repository `RELEASING.md`. Inspect
the resulting public provenance with:

```bash
npm view @pisama/cli@latest dist.integrity dist.attestations
npm pack @pisama/cli@latest
gh attestation verify pisama-cli-*.tgz --repo Pisama-AI/pisama-js
```

## Support

Report defects in the
[Pisama JavaScript repository](https://github.com/Pisama-AI/pisama-js/issues).
Include the CLI version, Node.js version, command, exit code, and redacted
output. Report security issues privately as described in the repository's
[security policy](https://github.com/Pisama-AI/pisama-js/security/policy).
The public API exposes its current dependency health at
[api.pisama.ai/api/v1/health](https://api.pisama.ai/api/v1/health).
