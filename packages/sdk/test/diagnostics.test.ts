import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  logEnabled,
  maybeStartSilenceWarning,
  noteEventEnqueued,
  _resetDiagnostics,
} from '../src/diagnostics.js';

interface ConsoleSpy {
  logs: string[];
  warns: string[];
  restore: () => void;
}

function spyConsole(): ConsoleSpy {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const spy: ConsoleSpy = {
    logs: [],
    warns: [],
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
  console.log = (...args: unknown[]) => {
    spy.logs.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    spy.warns.push(args.map(String).join(' '));
  };
  return spy;
}

beforeEach(() => {
  _resetDiagnostics();
  delete process.env.PISAMA_SILENT;
  delete process.env.PISAMA_DEBUG;
});

test('logEnabled logs once per project, includes redact mode', () => {
  const c = spyConsole();
  try {
    logEnabled('ws_abc123def456', 'metadata-only');
    logEnabled('ws_abc123def456', 'metadata-only'); // dedup
    logEnabled('ws_other999', 'standard');
    assert.equal(c.logs.length, 2);
    assert.match(c.logs[0]!, /\[pisama\] enabled/);
    assert.match(c.logs[0]!, /ws_abc123def/);
    assert.match(c.logs[0]!, /redact=metadata-only/);
    assert.match(c.logs[1]!, /ws_other999/);
  } finally {
    c.restore();
  }
});

test('logEnabled is silent when PISAMA_SILENT=1', () => {
  process.env.PISAMA_SILENT = '1';
  const c = spyConsole();
  try {
    logEnabled('ws_quiet1234567', 'standard');
    assert.equal(c.logs.length, 0);
  } finally {
    c.restore();
  }
});

test('silence warning fires when no events fire within delay', async () => {
  const c = spyConsole();
  try {
    maybeStartSilenceWarning('ws_lonely12345', 25);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.warns.length, 1, 'expected one warning');
    assert.match(c.warns[0]!, /No events fired/);
    assert.match(c.warns[0]!, /ws_lonely12345/);
    assert.match(c.warns[0]!, /observe\(model, opts\)/);
  } finally {
    c.restore();
  }
});

test('silence warning does NOT fire when events arrive in time', async () => {
  const c = spyConsole();
  try {
    maybeStartSilenceWarning('ws_chatty12345', 25);
    noteEventEnqueued();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.warns.length, 0, 'expected no warnings when events fired');
  } finally {
    c.restore();
  }
});

test('silence warning timer runs once per process (subsequent calls are no-ops)', async () => {
  const c = spyConsole();
  try {
    maybeStartSilenceWarning('ws_proj_a12345', 25);
    maybeStartSilenceWarning('ws_proj_b12345', 25);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.warns.length, 1);
  } finally {
    c.restore();
  }
});

test('PISAMA_SILENT=1 also suppresses the silence warning', async () => {
  process.env.PISAMA_SILENT = '1';
  const c = spyConsole();
  try {
    maybeStartSilenceWarning('ws_silenced12345', 25);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.warns.length, 0);
  } finally {
    c.restore();
  }
});
