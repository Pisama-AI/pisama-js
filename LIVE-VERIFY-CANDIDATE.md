# CLI production contract correction — 2026-09-09

Status: independently reproduced candidate; not released. The reproduction
baseline now accepts the reviewed CLI correction described below. This does not
approve publishing, a release tag, or npm staging.

## Independent artifact review, 2026-09-10

Exact candidate `a64c227d3ad56d0afca417e742a3950364308733` was built in two
isolated clean worktrees on Node 22.14.0, Python 3.11.13 and pnpm 10.34.5.
All six archives match byte for byte between builds. The five non-CLI archives
retain their previous reviewed digests. The CLI reproduces the digest recorded
below; archive membership is unchanged, with changes only in `dist/verify.js`
and its `verify.js.map` and `verify.d.ts.map` mappings.

An independent agent reviewed the member differences against the original
reviewed archive. The coordinating agent separately reviewed the source delta,
including the response-body deadline, and recomputed all twelve archive hashes.
The CLI correction is accepted for the reproduction baseline on that evidence,
not by copying an unexplained CI mismatch. The original CI retained no failed
archive, so this does not identify its actual computed digest retrospectively.

Full lint, formatting, typecheck, coverage and dependency audits passed:
263 tests passed and one live-credential SDK test skipped. Both pack runs passed
real packed-consumer verification and audits. This is macOS evidence; the Linux
hosted reproduction gate must pass separately. Publisher-control evidence,
human environment approval, immutable tag approval, stage approval and registry
verification remain required under `RELEASING.md`.

## Original correction and live verification evidence

An owner-authorized isolated production test tenant exposed a real defect in
the previously reviewed CLI 0.11.3 candidate. Its synthetic `pisama.verify`
span lacked a recognized GenAI marker. Production returned HTTP 202 with
submitted=1, accepted=0, rejected=0, duplicates=0, traces=0. The CLI incorrectly
reported acceptance and waited until its deadline for a nonexistent trace.

The correction identifies the synthetic span explicitly as GenAI, without
claiming a real provider, and validates all five acceptance counters before
polling. Zero acceptance, rejected/duplicate spans, partial counters and
incorrect counter types fail immediately without a success message.

Validation:

- Repository lint and changed-file formatting checks passed.
- CLI TypeScript/build passed; all 126 CLI tests passed with the coverage gate
  (96.05% lines, 85.13% branches). The targeted verify suite has 29 tests.
- The final packed CLI was installed with lifecycle scripts disabled in a
  temporary consumer. Its dependency audit reported zero vulnerabilities.
- Production returned submitted=1, accepted=1, rejected=0, duplicates=0,
  traces=1. The packed command retrieved its trace in 0.1 seconds and exited 0.
- Only synthetic data in a test tenant was used. Billing was not enabled.
- The temporary key was revoked; subsequent raw-key exchange, existing read
  session and session refresh each returned HTTP 401.

Final locally tested archive SHA-256 (evidence, **not release approval**):

`da7c3e36a68daf12ebc9345a47edb066b36f329aa26a2922646cf597e185b74c`

Temporary test tenant: `f34f2624-4e01-4b20-805b-304c1ffa1bb7`.
Final probe's revoked key ID: `8f3d4d87-d83b-47f2-baf4-9229fbd90866`.
Synthetic traces are retained as evidence; no active test credential remains.

Next: complete protected CI/release gates against the reviewed baseline above.
Do not publish against the old digest. Public SDK instrumentation, MCP live contracts and fresh-user onboarding
are separate checks; this probe does not establish those outcomes. The backend
deployment hold remains in place. No score uplift is claimed for an unreleased
local correction; previously reported scores remain repo 69, live product 32,
candidate 37 pending a rubric-level milestone rescore.
