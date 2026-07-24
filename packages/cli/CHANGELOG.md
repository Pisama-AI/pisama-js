# Changelog

All notable changes to `@pisama/cli` are documented here.

## [Unreleased]

### Changed

- Expose `pisama` as the canonical global command while retaining the
  `pisama-ts` compatibility alias.
- Split ATIF loading, validation, API transport, and rendering into bounded
  functions, with a repository-wide cyclomatic complexity ceiling of 15.

## [0.10.0] - 2026-07-23

### Added

- `analyze-atif` support for single trajectories, flat directories, and Harbor
  job outputs using ATIF v1.0 through v1.7.
- CI-friendly nonzero exits for high-severity findings.
- Explicit, single-trajectory fix application through Pisama's unified
  auto-apply service.

### Changed

- Added tokenless npm trusted publishing and a tag-to-version release guard.
