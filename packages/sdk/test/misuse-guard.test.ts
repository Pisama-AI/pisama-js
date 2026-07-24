import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pisamaMiddleware } from '../src/middleware.js';
import { observe } from '../src/observe.js';
import { mockTextModel } from './integration/_shared/observe-helpers.js';

test('pisamaMiddleware(opts)(model) throws a helpful error (v0 typo guardrail)', () => {
  const middleware = pisamaMiddleware({ redact: 'metadata-only' });
  // Cast to any so we can simulate the agent mistake of calling the
  // middleware as if it were a function. The Proxy should intercept and
  // throw a directional error.
  const callable = middleware as unknown as (...args: unknown[]) => unknown;
  let caught: unknown = null;
  try {
    callable(mockTextModel('hi'));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected the misuse to throw');
  const msg = (caught as Error).message;
  assert.match(msg, /\[pisama\]/);
  assert.match(msg, /observe\(model, opts\)/, 'error should point at observe()');
  assert.match(msg, /pisama\.ai\/install/);
});

test('pisamaMiddleware properties remain readable through the proxy (advanced composition)', () => {
  const middleware = pisamaMiddleware();
  // Users who go the explicit wrapLanguageModel route read these props.
  // The proxy must forward them transparently.
  // @ts-expect-error — these props exist on the inner middleware object
  assert.equal(middleware.specificationVersion, 'v3');
  // @ts-expect-error
  assert.equal(typeof middleware.wrapGenerate, 'function');
  // @ts-expect-error
  assert.equal(typeof middleware.wrapStream, 'function');
});

test('observe() still works (uses pisamaMiddleware internally through wrapLanguageModel)', async () => {
  process.env.PISAMA_PROJECT_ID = 'ws_misuse_guard_smoke';
  process.env.PISAMA_SILENT = '1';
  try {
    const wrapped = observe(mockTextModel('ok'), { redact: 'metadata-only' });
    // If the proxy broke wrapLanguageModel's property access, observe()
    // would throw at construction. Reaching here means the guard didn't
    // regress the happy path.
    assert.ok(wrapped);
    assert.equal((wrapped as { specificationVersion?: string }).specificationVersion, 'v3');
  } finally {
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
});
