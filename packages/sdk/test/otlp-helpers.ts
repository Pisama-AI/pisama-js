import type { TraceEvent } from '../src/types.js';

type OtlpValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
};

type OtlpAttribute = { key?: string; value?: OtlpValue };

type OtlpSpan = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number; message?: string };
};

type OtlpBody = {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
};

function decodeValue(value: OtlpValue | undefined): unknown {
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('boolValue' in value) return value.boolValue;
  return undefined;
}

function decodeAttributes(attributes: OtlpAttribute[] | undefined): Record<string, unknown> {
  return Object.fromEntries(
    (attributes ?? [])
      .filter((attribute): attribute is OtlpAttribute & { key: string } => Boolean(attribute.key))
      .map((attribute) => [attribute.key, decodeValue(attribute.value)]),
  );
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function decodeEvents(body: unknown): TraceEvent[] {
  const otlp = body as OtlpBody;
  const resource = otlp.resourceSpans?.[0];
  const resourceAttrs = decodeAttributes(resource?.resource?.attributes);
  const projectId = String(resourceAttrs['service.name'] ?? '@pisama/sdk');
  const spans = resource?.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? [];
  return spans.map((span) => {
    const attrs = decodeAttributes(span.attributes);
    const state = parseJson(attrs['gen_ai.state'], {}) as Record<string, unknown>;
    const toolCalls = parseJson(attrs['gen_ai.tool_calls'], []) as TraceEvent['toolCalls'];
    const error = state.error as TraceEvent['error'] | undefined;
    return {
      projectId,
      traceId: String(span.traceId ?? ''),
      spanId: String(span.spanId ?? ''),
      ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
      startTime: Number(BigInt(span.startTimeUnixNano ?? '0') / 1_000_000n),
      endTime: Number(BigInt(span.endTimeUnixNano ?? '0') / 1_000_000n),
      model: String(attrs['gen_ai.request.model'] ?? ''),
      ...(typeof attrs['gen_ai.prompt'] === 'string' ? { prompt: attrs['gen_ai.prompt'] } : {}),
      ...(typeof attrs['gen_ai.completion'] === 'string'
        ? { completion: attrs['gen_ai.completion'] }
        : {}),
      ...(typeof state.reasoning === 'string' ? { reasoning: state.reasoning } : {}),
      toolCalls,
      ...(typeof attrs['gen_ai.usage.input_tokens'] === 'number'
        ? { inputTokens: attrs['gen_ai.usage.input_tokens'] }
        : {}),
      ...(typeof attrs['gen_ai.usage.output_tokens'] === 'number'
        ? { outputTokens: attrs['gen_ai.usage.output_tokens'] }
        : {}),
      ...(typeof attrs['gen_ai.usage.cost_usd'] === 'number'
        ? { costUsd: attrs['gen_ai.usage.cost_usd'] }
        : {}),
      ...(typeof attrs['gen_ai.response.finish_reason'] === 'string'
        ? { finishReason: attrs['gen_ai.response.finish_reason'] }
        : {}),
      ...(error ? { error } : {}),
      metadata: Object.fromEntries(
        Object.entries(state).filter(
          ([key]) => !['reasoning', 'finish_reason', 'error'].includes(key),
        ),
      ),
    };
  });
}

export function scopedToken(scope = 'ingest', sequence = 1): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ scope })).toString('base64url');
  return `${header}.${payload}.test-${sequence}`;
}

export function tokenResponse(sequence = 1): Response {
  return Response.json({ access_token: scopedToken('ingest', sequence) });
}
