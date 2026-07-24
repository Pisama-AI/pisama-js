## @pisama/detectors

TypeScript-native failure detectors for AI agent traces. Pure functions, zero runtime dependencies, no LLM calls.

```ts
import { runDetectors, v1Detectors } from "@pisama/detectors";

const hits = runDetectors({
  traceId: "t1",
  startTime: 0,
  toolCalls: [
    { toolName: "search", startTime: 0 },
    { toolName: "search", startTime: 1 },
    { toolName: "search", startTime: 2 },
    { toolName: "search", startTime: 3 },
    { toolName: "search", startTime: 4 },
  ],
});
// hits[0]: { detector: "loop", detected: true, severity: 50, ... }
```

### Algorithms

The v1 pack ports a subset of the [Pisama](https://pisama.ai) detector library to TypeScript. Same algorithms, simplified to drop platform overrides and async.

- **loop**: consecutive repetition, cyclic patterns (A to B to A to B), low tool diversity
- (more shipping in v1)

### Adding a detector

```ts
import type { Detector } from "@pisama/detectors";

export const myDetector: Detector = {
  name: "my_detector",
  description: "what it catches",
  detect(trace) {
    // return { detector, detected, severity, summary, fix?, evidence? }
  },
};
```

### MultiAgentDetectors (0.10): typed backend clients

The `MultiAgentDetectors` namespace exposes typed TS clients for Pisama's
multi-agent failure detectors. **No detection runs in TS**: every call
round-trips to the Pisama backend, which owns the calibrated detector suite
(53 detectors as of Sprint 11; multi-agent F1: coordination 0.914, persona
0.828, consensus_collapse 0.967).

```ts
import { createMultiAgentDetectors } from "@pisama/detectors";

const detectors = createMultiAgentDetectors({
  endpoint: process.env.PISAMA_ENDPOINT, // defaults to https://api.pisama.ai
  apiKey: process.env.PISAMA_API_KEY,
  projectId: process.env.PISAMA_PROJECT_ID,
});

// Coordination: agent message stream
const coord = await detectors.coordination({
  agent_ids: ["planner", "executor"],
  messages: [
    { sender: "planner", recipient: "executor", content: "do X" },
    { sender: "executor", recipient: "planner", content: "doing Y instead" },
  ],
});
if (coord.detected) console.warn(coord.title, coord.suggestedFix);

// Delegation: handoff quality
await detectors.delegation({
  handoff_instruction: "Pls handle the user thing",
  context_completeness: 0.3,
  bounds: ["no destructive writes"],
  success_criteria: [],
});

// Persona drift
await detectors.persona({
  agent: {
    id: "support-bot",
    persona_description: "polite customer-support agent",
    allowed_actions: ["respond_to_user", "lookup_order"],
  },
  output: "ugh fine, here's your refund or whatever.",
});

// Consensus collapse in a multi-agent debate
await detectors.consensus_collapse({
  agent_outputs: [
    { agent_id: "a", output: "X is true" },
    { agent_id: "b", output: "X is true" },
  ],
  challenge_patterns: ["dropped_dissent"],
  agreement_ratio: 1.0,
  debate_trace: [
    { agent_id: "a", round: 1, content: "I think X" },
    { agent_id: "b", round: 1, content: "agreed, X" },
  ],
});
```

#### Backend coverage gap (honest disclosure)

The backend does NOT yet expose discrete `POST /api/v1/detect/{type}` routes
for these four detectors. Today's clients POST to `/api/v1/diagnose/why-failed`
(the orchestrator entry point) and filter the returned `all_detections` by
category. Consequences:

- `coordination` and `persona` map cleanly: the orchestrator returns
  `coordination` and `persona_drift` categories in `all_detections`.
- `delegation` and `consensus_collapse` are evaluated by the calibration
  runner but are NOT yet emitted as discrete categories from
  `/diagnose/why-failed`. The TS calls round-trip and validate end-to-end,
  but will return `detected: false` until the backend route lands. The B2
  multi-trace batch endpoint (`/api/v1/diagnose/batch`) is the natural home
  for `consensus_collapse`; this client will switch paths once shipped.

Follow-up tracked: add per-detector REST routes that accept the
golden_dataset input shapes directly, so the wrap-and-filter layer can be
removed.

### License

MIT
