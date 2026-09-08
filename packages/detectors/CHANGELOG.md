# Changelog

All notable changes to `@pisama/detectors` are documented here.

## [Unreleased]

## [0.10.1] - 2026-09-04

- Exchange API keys for full-scoped platform JWTs before calling the hosted
  diagnose service; raw keys are never sent as bearer credentials.
- Cache the scoped JWT and refresh it exactly once after a 401 while preserving
  the serialized request and `X-Request-ID` for safe backend deduplication.
- Fail closed without an API key, before any network request.

- Remove the unsupported `delegation` and `consensus_collapse` client
  operations so an unavailable backend capability cannot look like a clean
  detector result.

## [0.10.0-alpha.4] - 2026-07-25

- Promote the verified tarball through an explicit filesystem path in the npm
  publishing job.

## [0.10.0-alpha.3] - 2026-07-25

- Publish through an isolated, tag-verified npm trusted-publishing workflow
  after the complete monorepo quality suite passes.
- Keep endpoint-status documentation independent of the package version.

## [0.10.0-alpha.2] - 2026-07-23

- Declare the package side-effect free for safe consumer tree shaking.
- Enforce the shared complexity ceiling of 15 across detector source.

## [0.10.0-alpha.1] - 2026-07-23

- Publish the local TypeScript detector engine and typed multi-agent backend
  client from the canonical public repository.
