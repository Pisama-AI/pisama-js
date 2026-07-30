# Changelog

This repository publishes three independently versioned npm packages, so it has no
single version of its own. The root `package.json` is private and stays at `0.0.0`.

Release notes live with the package they describe:

| Package             | Changelog                                                          | Release tag            |
| ------------------- | ------------------------------------------------------------------ | ---------------------- |
| `@pisama/sdk`       | [packages/sdk/CHANGELOG.md](packages/sdk/CHANGELOG.md)             | `v<version>`           |
| `@pisama/detectors` | [packages/detectors/CHANGELOG.md](packages/detectors/CHANGELOG.md) | `detectors-v<version>` |
| `@pisama/cli`       | [packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)             | `cli-v<version>`       |

Each package moves on its own schedule, and the version numbers are not aligned with
each other. A release of one package does not imply a release of the others, so read
the changelog for the package you actually install rather than looking for a combined
history here. Nothing is duplicated into this file, which keeps it from drifting out
of step with the notes that ship to npm.

## Repository changes that are not package releases

Work that ships no npm version, such as CI, security policy, dependency maintenance,
or contributor documentation, is recorded in the git history and in the pull request
that made it. It does not appear in any changelog.

## How a release is cut

Publication runs from tagged workflows, never from a workstation. Each publish
workflow rebuilds the package, runs the full quality suite, then verifies that the
tag matches the package version, that the tagged commit is an ancestor of `main`,
and that the exact published version reinstalls from the public registry. The
per-package release policy is in [CONTRIBUTING.md](CONTRIBUTING.md).
