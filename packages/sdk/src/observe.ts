// One-call helper that wraps a model with the pisama middleware.
// The two-step pattern (wrapLanguageModel + pisamaMiddleware) is ambiguous
// enough that AI agents on multiple platforms (v0, Lovable, Replit) have been
// observed writing it incorrectly — e.g. calling pisamaMiddleware(opts) as
// if it returned a wrapper function. observe() collapses the pattern into
// one obvious call so there's nothing to misinterpret.

import { wrapLanguageModel } from 'ai';
import type { LanguageModelV2, LanguageModelV3, LanguageModelV4 } from '@ai-sdk/provider';
import { pisamaMiddleware } from './middleware.js';
import type { PisamaMiddlewareOptions } from './middleware.js';
import { isSilent } from './diagnostics.js';

// The union `ai@^7`'s own `wrapLanguageModel()` accepts for `model` — it
// stays type-level backward-compatible with providers that haven't moved
// past the v2/v3 language-model spec, upgrading whichever version is passed
// to v4 internally (matching our own middleware's
// `specificationVersion: 'v4'`).
type SupportedLanguageModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4;

// Peer-dep version guard. The SDK's middleware targets the v4 language-model
// contract shipped by `ai@^7` + `@ai-sdk/provider@^4`. Older `ai` / provider
// versions (4.x, 5.x) export `wrapLanguageModel` but consume a different
// middleware contract — our middleware could silently no-op. Replit's AI
// flagged this in the 2026-05-10 cross-platform test ("the peer dependency
// expects ai@^6 but the installed version is 4.x"); the silent-no-op we saw
// on Lovable is the same failure class.
//
// We detect the mismatch by inspecting `model.specificationVersion` at the
// first observe() call. Verified directly against ai@7.0.42: `v3` models are
// fully supported (wrapLanguageModel upgrades them transparently, no runtime
// warning from the AI SDK itself), so a provider that hasn't yet republished
// against `@ai-sdk/provider@^4` still traces correctly — v3 stays silent
// here too. `v2` and older, though, only run in the AI SDK's own degraded
// "compatibility mode" ("some features may not be available" — its own
// warning, also verified against ai@7.0.42), so that's still the threshold
// worth pisama's own directional warning pointing at the fix.
const _warnedProviders = new Set<string>();
function checkModelContract(model: SupportedLanguageModel): void {
  if (isSilent()) return;
  const v = (model as { specificationVersion?: unknown }).specificationVersion;
  const providerKey = String((model as { provider?: unknown; modelId?: unknown }).provider ?? '?');
  if (v !== 'v3' && v !== 'v4' && !_warnedProviders.has(providerKey)) {
    _warnedProviders.add(providerKey);
    console.warn(
      `[pisama] Model has specificationVersion=${JSON.stringify(v)} but ` +
        `@pisama/sdk targets v3/v4. Your AI SDK or provider package is older ` +
        `than the version pisama targets — observe() may run in a degraded ` +
        `compatibility mode or silently no-op. ` +
        `Run: npm install ai@^7 @ai-sdk/openai@^4 @ai-sdk/provider@^4 ` +
        `(adjust provider package as appropriate). ` +
        `See https://pisama.ai/install`,
    );
  }
}

export function observe<M extends SupportedLanguageModel>(
  model: M,
  options: PisamaMiddlewareOptions = {},
): M {
  checkModelContract(model);
  return wrapLanguageModel({
    model,
    middleware: pisamaMiddleware(options),
  }) as unknown as M;
}
