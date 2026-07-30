# Changelog

All notable changes to `@pisama/cli` are documented here.

## 0.11.2

Patch release to exercise the retried attestation checks in `publish-cli.yml`'s "Verify public registry release" step (see repo history): the previous two releases published correctly but the CI run itself failed on an unretried read against npm's attestations endpoint.

## 0.11.1

Patch release to confirm a clean publish/verification run (the prior release hit a transient npm registry-propagation delay during its own CI verification step, not a real defect -- see repo history).

## 0.11.0

### Added

- `@pisama/cli` now depends on `@pisama/detectors` directly (the same
  `workspace:*` convention `@pisama/sdk` already uses), so installing the CLI
  alone gives you real local detector functionality with no separate
  `npm install @pisama/detectors` step.
- `analyze-atif --local`: runs `@pisama/detectors`' v1 pack (loop,
  repetition, cost, completion, hallucination, context, derailment) against
  each ATIF trajectory in-process. No network call, no `PISAMA_API_KEY`, and
  no `--apply` (that still needs the hosted auto-apply service). It's the
  same simplified subset `@pisama/detectors` documents itself as, not a
  replacement for the backend's full calibrated suite — the default
  (network) mode is unchanged and still recommended when you have an API
  key.

## 0.10.5

### Fixed

- `init` now tells you to install `@pisama/sdk`. It patches your call site to
  `import { observe } from "@pisama/sdk"` but never added the package, so every fresh
  `init` left a project that could not resolve the import. The install line uses the
  package manager your lockfile implies (`pnpm add`, `yarn add`, `bun add`, otherwise
  `npm i`), and is skipped when the dependency is already present. `init` still does not
  edit your `package.json`.
- `init` no longer prints `https://pisama.ai/live/<projectId>`. That route does not exist:
  it redirects to `/sign-in` and resolves to nothing after login. It now prints
  `https://pisama.ai/dashboard`, which is a real page. The dashboard is not project-scoped,
  so the project id is no longer appended to the link; `init` still prints the id on its
  own line.

## 0.10.4

### Fixed

- `verify` no longer targets the removed anonymous project-scoped ingest flow. It now
  authenticates with an API key, resolves the tenant via `/api/v1/auth/me`, sends OTLP to
  `/api/v1/traces/ingest`, and reads back from `/api/v1/tenants/{tenant_id}/traces`. The
  previous flow returned 404 on every call.
- `analyze-atif` accepts `--api-key` (or `PISAMA_API_KEY`) and sends it as a bearer token.
  `/api/v1/atif/analyze` is authenticated, so this command previously returned 401 for every
  user with no flag available to fix it.
- `mcp` reports an actionable error when the trace-read endpoint returns 404 instead of an
  opaque upstream message.

## [Unreleased]

## [0.10.3] - 2026-07-26

### Added

- Verify the exact CLI tarball, both command aliases, public package metadata,
  archive contents, dependency health, and a 200 kB compressed-size budget.
- Rebuild the CLI automatically before every local or automated pack
  operation.
- Hold automated dependency updates for seven days before review.
- Record SHA-256 checksums and GitHub build provenance for release tarballs.
- Reinstall every successful release from npm and verify its npm provenance,
  registry signatures, dist-tag, command version, and production audit.
- Document MCP prompts, command network behavior, privacy boundaries, release
  provenance, and useful support diagnostics.
- Correct `analyze-atif --project-id` help to describe its active correlation
  behavior.

### Changed

- Only release tags whose commit belongs to `main` may publish the CLI.
- Declare npm public access and registry policy in package metadata.

### Fixed

- Use an explicit package and binary in every `npx` example so the command
  remains unambiguous while `pisama` and `pisama-ts` are both published.
- Use the cross-version `pisama-ts` binary in registry-backed examples until
  the new `pisama` alias is available in the public release.
- Reserve a fresh package version after the `cli-v0.10.2` publishing attempt
  failed, because npm release tags and package versions are immutable.

## [0.10.2] - 2026-07-25

### Fixed

- Promote the verified tarball through an explicit filesystem path in the npm
  publishing job.

## [0.10.1] - 2026-07-23

### Changed

- Expose `pisama` as the canonical global command while retaining the
  `pisama-ts` compatibility alias.
- Split ATIF loading, validation, API transport, and rendering into bounded
  functions, with a repository-wide cyclomatic complexity ceiling of 15.
- Bundle the CLI's stdio-only MCP implementation so clean consumer installs
  no longer include the unused HTTP server dependency tree.
- Remove the nonexistent library entry point from this command-only package.
- Show the production dashboard host after a successful verification while
  retaining the configured host for self-hosted installations.
- Direct failure diagnostics to the public API health endpoint.
- Report the package version in the MCP initialization handshake.
- Include license notices for every dependency incorporated into the MCP
  bundle.
- Audit the dependency set incorporated into the bundle and continuously test
  the documented Node.js 20 minimum.
- Audit the packed CLI artifact as a clean consumer install before publishing.
- Upgrade `ts-morph` to remove the vulnerable transitive `brace-expansion`
  release from the production dependency graph.

## [0.10.0] - 2026-07-23

### Added

- `analyze-atif` support for single trajectories, flat directories, and Harbor
  job outputs using ATIF v1.0 through v1.7.
- CI-friendly nonzero exits for high-severity findings.
- Explicit, single-trajectory fix application through Pisama's unified
  auto-apply service.

### Changed

- Added tokenless npm trusted publishing and a tag-to-version release guard.
