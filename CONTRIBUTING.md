# Contributing

Contributions to the SDK, local detectors, CLI, tests, and documentation are
welcome.

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Keep changes focused and include a test for behavior changes. By submitting a
contribution, you agree to license it under MIT.

## Dependency policy

The lockfile is committed, Dependabot checks npm and GitHub Actions weekly
after a seven-day supply-chain cooldown, and CI rejects moderate or higher
production and bundled-input advisories. A CLI runtime dependency change must
pass the packed-artifact verifier on Node.js 20 and 24. If an MCP bundle input
changes, update `THIRD_PARTY_NOTICES.md` in the same pull request. Review major
upgrades individually because the supported Node.js floor and command output
are public contracts.

## CLI release policy

Do not publish `@pisama/cli` from a workstation. Releases use the committed
`.github/workflows/publish-cli.yml` workflow and npm trusted publishing.

1. Update `packages/cli/package.json` and `packages/cli/CHANGELOG.md` in a pull
   request.
2. Merge every required check to `main`.
3. Tag that commit as `cli-v<package-version>`.
4. Confirm that the workflow builds and verifies one tarball, records its
   checksum and GitHub attestation, publishes it, then reinstalls the exact
   version from npm.

The npm trusted publisher must name organization `Pisama-AI`, repository
`pisama-js`, and workflow `publish-cli.yml`. The workflow requires no npm
token. For a stable release, confirm that the package version and the `latest`
dist-tag match:

```bash
npm view @pisama/cli@latest version dist.integrity dist.attestations
npx --yes --package=@pisama/cli@latest -- pisama-ts --version
```
