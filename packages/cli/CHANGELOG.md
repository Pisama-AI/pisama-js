# Changelog

All notable changes to `@pisama/cli` are documented here.

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
