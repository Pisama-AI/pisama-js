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
round-trips to the Pisama backend, which owns the calibrated detector suite.
The client exposes only operations that the current endpoint can return
reliably.

| Operation | Backend category | Status |
|---|---|---|
| `coordination` | `coordination` | Available |
| `persona` | `persona_drift` | Available |

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

// Persona drift
await detectors.persona({
  agent: {
    id: "support-bot",
    persona_description: "polite customer-support agent",
    allowed_actions: ["respond_to_user", "lookup_order"],
  },
  output: "ugh fine, here's your refund or whatever.",
});
```

#### Capability boundary

The backend does NOT yet expose discrete `POST /api/v1/detect/{type}` routes
for these detectors. Today's clients POST to `/api/v1/diagnose/why-failed`
(the orchestrator entry point) and filter the returned `all_detections` by
category. The endpoint returns `coordination` and `persona_drift`, so those
are the only public client operations.

`delegation` and `consensus_collapse` are intentionally not exposed. The
current endpoint cannot return their categories, and representing an
unsupported operation as `detected: false` would be indistinguishable from a
clean detector result. These operations can be added when dedicated backend
routes exist.

### License

MIT
