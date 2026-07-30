// Tests for the observe() peer-dep version guard. Covers the Replit-identified
// failure mode where an older `ai` / `@ai-sdk/provider` version produces
// models with specificationVersion outside {"v3", "v4"}, which run in the AI
// SDK's own degraded compatibility mode or silently no-op our middleware.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { observe } from '../src/observe.js';
import { mockTextModel } from './integration/_shared/observe-helpers.js';

interface ConsoleSpy {
  warns: string[];
  restore: () => void;
}

function spy(): ConsoleSpy {
  const w = console.warn;
  const s: ConsoleSpy = {
    warns: [],
    restore: () => {
      console.warn = w;
    },
  };
  console.warn = (...a: unknown[]) => {
    s.warns.push(a.map(String).join(' '));
  };
  return s;
}

beforeEach(() => {
  delete process.env.PISAMA_SILENT;
});

test('observe() warns when model has specificationVersion v2 (old provider)', () => {
  const c = spy();
  try {
    const oldModel = {
      ...mockTextModel('hi'),
      specificationVersion: 'v2' as unknown as 'v3',
      provider: 'mock-old-provider',
    };
    observe(oldModel);
    assert.ok(
      c.warns.some(
        (l) => /specificationVersion=/i.test(l) && /v2/i.test(l) && /observe\(\)/.test(l),
      ),
      `expected directional warning about specificationVersion mismatch, got: ${JSON.stringify(c.warns)}`,
    );
    assert.ok(
      c.warns.some((l) => /ai@\^7/.test(l)),
      'warning should include the fix command',
    );
  } finally {
    c.restore();
  }
});

test('observe() does NOT warn when model is v3 (correct contract)', () => {
  const c = spy();
  try {
    observe(mockTextModel('hi', 'happy-path-model'));
    assert.equal(c.warns.length, 0, 'v3 model should not produce a warning');
  } finally {
    c.restore();
  }
});

test('observe() warns only once per provider (no log spam)', () => {
  const c = spy();
  try {
    const oldModel = {
      ...mockTextModel('hi'),
      specificationVersion: 'v2' as unknown as 'v3',
      provider: 'spam-test-provider',
    };
    observe(oldModel);
    observe(oldModel);
    observe(oldModel);
    assert.equal(c.warns.length, 1, 'should dedupe by provider key');
  } finally {
    c.restore();
  }
});

test('PISAMA_SILENT=1 suppresses the version-guard warning', () => {
  process.env.PISAMA_SILENT = '1';
  const c = spy();
  try {
    const oldModel = {
      ...mockTextModel('hi'),
      specificationVersion: 'v2' as unknown as 'v3',
      provider: 'silent-test-provider',
    };
    observe(oldModel);
    assert.equal(c.warns.length, 0);
  } finally {
    c.restore();
    delete process.env.PISAMA_SILENT;
  }
});
