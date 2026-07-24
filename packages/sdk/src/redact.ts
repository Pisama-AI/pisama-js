export type RedactMode = 'off' | 'standard' | 'aggressive' | 'metadata-only';

const STANDARD_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[anthropic-key]'],
  [/sk-[A-Za-z0-9]{20,}/g, '[openai-key]'],
  [/AKIA[0-9A-Z]{16}/g, '[aws-key]'],
  [/ghp_[A-Za-z0-9]{36}/g, '[github-pat]'],
  [/xox[bpars]-[A-Za-z0-9-]{10,}/g, '[slack-token]'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:\+?\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g, '[phone]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
];

const AGGRESSIVE_EXTRA: Array<[RegExp, string]> = [
  [/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '[ip]'],
  [/\bhttps?:\/\/[^\s)]+/g, '[url]'],
  [/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[name]'],
];

export function redactText(input: string, mode: RedactMode = 'standard'): string {
  if (mode === 'off') return input;
  if (mode === 'metadata-only') return '[redacted]';

  let out = input;
  for (const [re, replacement] of STANDARD_PATTERNS) {
    out = out.replace(re, replacement);
  }
  if (mode === 'aggressive') {
    for (const [re, replacement] of AGGRESSIVE_EXTRA) {
      out = out.replace(re, replacement);
    }
  }
  return out;
}

export function redactObject<T>(input: T, mode: RedactMode = 'standard'): T {
  if (mode === 'off') return input;
  if (mode === 'metadata-only') return undefined as unknown as T;

  if (typeof input === 'string') {
    return redactText(input, mode) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactObject(v, mode)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = redactObject(v, mode);
    }
    return out as T;
  }
  return input;
}
