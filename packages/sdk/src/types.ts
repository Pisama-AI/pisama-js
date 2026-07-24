export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  startTime: number;
  endTime?: number;
}

export interface TraceEvent {
  projectId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  model: string;
  prompt?: string;
  completion?: string;
  /**
   * Reasoning / chain-of-thought content emitted by models that expose it
   * (o1, Claude extended thinking, Gemini thinking, etc.). Goes through the
   * same redact pipeline as `prompt` / `completion` — under `metadata-only`
   * mode this is `undefined`; under `standard` mode PII patterns are scrubbed.
   */
  reasoning?: string;
  toolCalls: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  finishReason?: string;
  error?: { message: string; name?: string };
  metadata: Record<string, unknown>;
}
