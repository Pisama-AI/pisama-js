# Fixture provenance

`hello-world-context-summarization.trajectory.json` is a real ATIF trajectory,
copied byte-for-byte (sha256 `a62c680d303e055b5492526f72fb4dbeecc631f07ca02aa7b1380a8b6ffba023`)
from Pisama-AI/pisama's own vendored Harbor golden fixtures:

- Source repository: https://github.com/harbor-framework/harbor (Apache-2.0)
- Source path: `tests/golden/terminus_2/hello-world-context-summarization.trajectory.json`
- Source revision: `00c19fe2a9c1b9b7ed07efc270412007ac4cb3da`
- Vendored at: `backend/tests/fixtures/atif/harbor-golden/terminus_2/` in Pisama-AI/pisama,
  tracked with checksums in that directory's `PROVENANCE.toml`
- Schema version: `ATIF-v1.7`

It is a real "terminus-2" agent trajectory (task: create `hello.txt`, with a
context-summarization handoff partway through) — not synthetic or hand-authored
for this test. It is used here, unmodified, to prove `analyze-atif --local`
runs real `@pisama/detectors` output against a real Harbor trajectory rather
than a fabricated one. `session_id` was already normalized upstream by Harbor's
own golden-fixture tooling before import; nothing else was changed.

Licensed Apache-2.0 upstream; redistributed here as test fixture data under
that license, consistent with how it is already vendored in Pisama-AI/pisama.

The `continuation/` directory is the same golden run in Harbor's explicit
linear-history representation. Its two files were copied byte-for-byte from
the same upstream revision and Pisama vendor directory:

- `continuation/trajectory.json`: sha256
  `06b56ab49c627ae3410a0dcb8650a41bb1b30f113d601d10060e590a5018c2bb`
- `continuation/trajectory.cont-1.json`: sha256
  `054dfbe7e9835830dca2d7c58dc01a8c7129362538b49df4f50468a875d69082`

The root's `continued_trajectory_ref` points to the second file. These bytes
exercise safe continuation-chain discovery and keep Harbor summarization
helpers out of analysis.
