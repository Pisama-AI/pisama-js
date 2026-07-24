# Changelog

All notable changes to `@pisama/cli` are documented here.

## [Unreleased]

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

## [0.10.0] - 2026-07-23

### Added

- `analyze-atif` support for single trajectories, flat directories, and Harbor
  job outputs using ATIF v1.0 through v1.7.
- CI-friendly nonzero exits for high-severity findings.
- Explicit, single-trajectory fix application through Pisama's unified
  auto-apply service.

### Changed

- Added tokenless npm trusted publishing and a tag-to-version release guard.
