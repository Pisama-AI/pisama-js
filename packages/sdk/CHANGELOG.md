# Changelog

All notable changes to `@pisama/sdk` are documented here.

## [Unreleased]

## [0.10.0] - 2026-07-29

### Changed

- **Breaking:** `peerDependencies.ai` moved from `^6.0.0` to `^7.0.0`, and
  `peerDependencies["@ai-sdk/provider"]` from `^3.0.0` to `^4.0.0` (the
  version that ships in lockstep with `ai@^7`). Consumers on `ai@6.x` must
  upgrade to `ai@^7` (and their model-provider package to the matching
  major — e.g. `@ai-sdk/openai@^4`) before installing this version. This is
  a security fix, not a feature bump: the `ai@6.x` line has no patched
  release anywhere in its history and pulls in `@ai-sdk/provider-utils@4.x`,
  which pins the vulnerable `undici@5.29.0` (high-severity: unbounded
  decompression, request/response smuggling, and related advisories).
  `ai@^7`'s `@ai-sdk/provider-utils@^5` moves to `undici@^7`, which is
  unaffected. `ai` is a peer dependency, not a hard runtime one, so this
  only forces action for consumers wiring the Vercel AI SDK middleware
  (`observe()` / `pisamaMiddleware()`); everything else in the package is
  unaffected.
- The middleware's `specificationVersion` moves from `'v3'` to `'v4'`,
  matching the `ai@^7` / `@ai-sdk/provider@^4` language-model contract.
  `observe()` still accepts v2/v3/v4 models (verified against `ai@7.0.42`:
  `wrapLanguageModel` upgrades all three transparently), and the peer-dep
  version guard's "known good, no warning" set moves from `{v3}` to
  `{v3, v4}` to match — a v3 provider that hasn't yet republished against
  `@ai-sdk/provider@^4` keeps tracing correctly and silently.

## [0.9.0-alpha.3] - 2026-07-25

- Verify the SDK against its packed detector dependency before artifact
  promotion, without depending on registry release order.

## [0.9.0-alpha.2] - 2026-07-23

- Bound exporter and middleware complexity to the repository ceiling of 15.
- Preserve partial-flush diagnostics while isolating batching, transport, and
  failure reporting.
- Declare the package side-effect free for safe consumer tree shaking.

## [0.9.0-alpha.1] - 2026-07-23

- Publish the Vercel AI SDK middleware, trace exporter, privacy controls, and
  framework integration coverage from the canonical public repository.
