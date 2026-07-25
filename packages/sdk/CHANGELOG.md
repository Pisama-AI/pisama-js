# Changelog

All notable changes to `@pisama/sdk` are documented here.

## [Unreleased]

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
