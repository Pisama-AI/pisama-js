# @pisama/detectors

[![npm version](https://img.shields.io/npm/v/%40pisama%2Fdetectors)](https://www.npmjs.com/package/@pisama/detectors)
[![npm downloads](https://img.shields.io/npm/dm/%40pisama%2Fdetectors)](https://www.npmjs.com/package/@pisama/detectors)
[![CI](https://github.com/Pisama-AI/pisama-js/actions/workflows/ci.yml/badge.svg)](https://github.com/Pisama-AI/pisama-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40pisama%2Fdetectors)](../../LICENSE)

Run deterministic failure detectors over AI agent traces. The local detector
pack has zero runtime dependencies and makes no network calls.

## Requirements

- Node.js 20 or newer
- An ESM project or an ESM-aware build tool

## Choose a release channel

```bash
# Stable local detector pack
pnpm add @pisama/detectors

# Current prerelease, including typed hosted-detector clients
pnpm add @pisama/detectors@alpha
```

Prereleases are published only under the npm `alpha` dist-tag. Stable versions
are published under `latest`. Pin an exact version in production if you need
fully repeatable installs.

## Run the local detector pack

```ts
import { runDetectors } from "@pisama/detectors";

const detections = runDetectors(trace);

for (const detection of detections) {
  console.warn(
    `${detection.detector}: ${detection.summary} (${detection.severity}/100)`,
  );
}
```

`runDetectors()` returns only detected issues. Each result includes a detector
key, severity from 0 to 100, summary, and optional fix and evidence fields.
Individual detector functions are exported when you need a narrower policy.

## Local algorithms

| Detector | Signal |
| --- | --- |
| `loop` | Consecutive calls, cyclic tool patterns, and low tool diversity. |
| `repetition` | Repeated or looping completion text. |
| `cost` | Token or cost spikes and missing model attribution. |
| `completion` | Premature stops and runaway completions. |
| `hallucination` | Claims unsupported by a supplied sources block. This is heuristic. |
| `context` | Completions that ignore key tokens from a supplied context block. |
| `derailment` | Tool sequences that do not align with task verbs in the prompt. |

These detectors are deterministic heuristics. A detection is evidence for
review, not proof that an agent failed. Calibrate thresholds on representative
production traces before using results for automated enforcement.

## Add a local detector

```ts
import type { Detector } from "@pisama/detectors";

export const policyDetector: Detector = {
  name: "policy_check",
  description: "Describe the signal this detector evaluates",
  detect(trace) {
    return evaluatePolicy(trace);
  },
};
```

Pass custom detectors as the second argument to `runDetectors(trace,
detectors)`.

## Hosted multi-agent clients

The `alpha` channel also exposes typed clients for backend-owned multi-agent
detectors. Detection runs on the Pisama backend, so these calls require network
access and may require an API key. They are separate from the zero-dependency
local pack.

```ts
import { createMultiAgentDetectors } from "@pisama/detectors";

const detectors = createMultiAgentDetectors({
  endpoint: process.env.PISAMA_ENDPOINT,
  apiKey: process.env.PISAMA_API_KEY,
  projectId: process.env.PISAMA_PROJECT_ID,
});

const result = await detectors.coordination({
  agent_ids: agentIds,
  messages: messageStream,
});
```

Currently supported operations:

| Operation | Backend category |
| --- | --- |
| `coordination` | `coordination` |
| `persona` | `persona_drift` |

The clients call `POST /api/v1/diagnose/why-failed` and select the matching
category from the response. Discrete per-detector routes do not exist today.
`delegation` and `consensus_collapse` are intentionally absent because this
endpoint cannot return those categories reliably.

## Compatibility evidence

The release gate exercises packed artifacts on Node.js 20, 22, and 24. It
checks the exact public export surface, generated declarations, package
contents, canonical metadata, zero runtime dependencies, and production audit
health.

## Support and security

- [Open a bug or feature request](https://github.com/Pisama-AI/pisama-js/issues)
- [Read the security policy](https://github.com/Pisama-AI/pisama-js/security/policy)
- [Review the source](https://github.com/Pisama-AI/pisama-js/tree/main/packages/detectors)

## License

[MIT](../../LICENSE)
