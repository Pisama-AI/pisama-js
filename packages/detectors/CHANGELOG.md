# Changelog

All notable changes to `@pisama/detectors` are documented here.

## [Unreleased]

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
