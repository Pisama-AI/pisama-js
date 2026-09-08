# Release runbook

These packages use npm trusted publishing from this public repository. The
workflows only **stage** one reviewed tarball; they never directly publish,
approve, or batch multiple package versions.

## Mandatory external gate

Do not create a release tag or dispatch a workflow until an npm owner has
provided current readback evidence for the exact package being staged and an
independent reviewer has accepted it. The evidence must prove all of the
following:

- the npm trusted publisher names `Pisama-AI/pisama-js`, the exact workflow
  filename in the table below, and GitHub environment `npm-staging`;
- the trusted publisher is allowed to run `npm stage publish` only, while
  direct trusted `npm publish` is disabled;
- package publishing access is set to **Require two-factor authentication and
  disallow tokens**;
- every legacy automation token and granular access token capable of
  publishing the package has been revoked, and the post-revocation token list
  has been read back;
- the package is public, the GitHub repository is public, and the protected
  `npm-staging` environment exists with its required human reviewers.

Workflow-local checks cannot prove those registry/account settings. Missing,
stale, ambiguous, or screenshot-only evidence without the exact package and
workflow identity is a stop condition.

| package | workflow | immutable tag |
|---|---|---|
| `@pisama/detectors@0.10.1` | `publish-detectors.yml` | `detectors-v0.10.1` |
| `@pisama/sdk@0.10.2` | `publish-sdk.yml` | `v0.10.2` |
| `@pisama/cli@0.11.3` | `publish-cli.yml` | `cli-v0.11.3` |
| `@whoopsie/detectors@0.7.0` | `publish-whoopsie-detectors.yml` | `whoopsie-detectors-v0.7.0` |
| `@whoopsie/sdk@0.9.0` | `publish-whoopsie-sdk.yml` | `whoopsie-sdk-v0.9.0` |
| `@whoopsie/cli@0.9.0` | `publish-whoopsie-cli.yml` | `whoopsie-cli-v0.9.0` |

## Stage one reviewed artifact

1. Re-run the full repository gate and two independent pack runs from a clean
   checkout of the exact candidate commit. Compare the tarballs byte for byte.
2. Confirm the version does not already exist on the official npm registry.
3. Review and approve the exact lowercase SHA-256, version, dist-tag, tag, and
   workflow filename. Create the immutable tag only with separate approval.
4. Dispatch the package-specific workflow from that exact tag ref and supply
   the independently reviewed SHA-256. Both jobs bind the event ref, event SHA,
   tag commit, public `main` ancestry, and tarball digest.
5. Inspect the npm stage. A human npm owner may then approve that one stage
   interactively with 2FA. Staging authorization is not approval authorization.
6. Download the registry tarball independently. Require the exact digest and
   provenance binding to this public repository, exact workflow, source commit,
   package, and version before moving to the next package.

Release successors in dependency order: Pisama detectors, SDK, then CLI. Only
after all three pass registry and live verification may the Whoopsie detector
bridge, SDK bridge, and CLI tombstone be staged in that order. Stop on any
mismatch. npm package bytes are immutable, so a published defect is repaired
only by a higher version.

The staged-publish jobs require a GitHub-hosted runner, OIDC `id-token: write`,
Node.js 22.14.0, and npm 11.19.1. They reject npm credentials and registry
redirection. npm stage approval, deprecation, DNS changes, and repository
archival are separate permission gates.

## Canonical artifact compression

The packed-consumer gate preserves the entire uncompressed tar stream and
canonicalizes gzip encoding before installation, auditing, or digest checks.
It uses Python's standard zlib at level 6, a zero timestamp, no filename, and
fixed gzip OS byte 19 from the reviewed archives (metadata only, not a target
platform restriction). Node's bundled zlib can produce different compressed
bytes from identical content, including on the pinned Linux release runtime.

The preparation action pins Python 3.11.13. Local verification needs Python 3
with standard zlib. Real-file tests cover content preservation, idempotence,
changed-content digest rejection, malformed input, symlinks, and size limits.
This step does not unpack or alter package members. It does not bypass the
independently supplied expected SHA-256: a changed compressor or tar stream
still stops the release on any mismatch. Never update an approved digest just
to accommodate unexplained build drift.
