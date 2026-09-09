# CLI production contract correction — 2026-09-09

Status: locally verified candidate; not released. The approved release digest
baseline is intentionally unchanged and does not approve these new bytes.

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

Next: independently review the changed artifact, reproduce packages from a
clean candidate commit, deliberately update the reviewed baseline only after
review, and complete protected CI/release gates. Do not publish against the old
digest. Public SDK instrumentation, MCP live contracts and fresh-user onboarding
are separate checks; this probe does not establish those outcomes. The backend
deployment hold remains in place. No score uplift is claimed for an unreleased
local correction; previously reported scores remain repo 69, live product 32,
candidate 37 pending a rubric-level milestone rescore.
