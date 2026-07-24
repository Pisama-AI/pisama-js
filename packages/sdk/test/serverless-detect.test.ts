// Tests for serverless runtime auto-detection in observe()'s eager mode.
// SDK 0.4.0 detected Workers + Vercel Edge. The 2026-05-10 v0 published-app
// test surfaced that Vercel Node Functions also need eager mode — their
// background event loop is killed after the response, just like Workers.
// 0.4.1 extends detection to Vercel, AWS Lambda, Netlify Functions, Cloud Run.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { streamText } from 'ai';
import { observe } from '../src/observe.js';
import { setupFetchCapture, mockTextModel } from './integration/_shared/observe-helpers.js';

beforeEach(() => {
  delete process.env.PISAMA_SILENT;
  delete process.env.VERCEL;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  delete process.env.NETLIFY;
  delete process.env.K_SERVICE;
});

async function runChat(captured: { length: number }, project: string) {
  process.env.PISAMA_PROJECT_ID = project;
  process.env.PISAMA_SILENT = '1';
  try {
    const model = observe(mockTextModel('hi', 'mock'));
    const result = await streamText({ model, prompt: 'hi' });
    for await (const _ of result.textStream) {
      // drain
    }
    // No setTimeout. If eager mode is on, capture happens before this returns.
    return captured.length;
  } finally {
    delete process.env.PISAMA_PROJECT_ID;
    delete process.env.PISAMA_SILENT;
  }
}

test('auto-detect: VERCEL=1 enables eager mode', async () => {
  process.env.VERCEL = '1';
  const { captured, restore } = setupFetchCapture();
  try {
    const count = await runChat(captured, 'ws_vercel_test');
    assert.ok(count > 0, 'VERCEL=1 should enable eager mode');
  } finally {
    restore();
  }
});

test('auto-detect: AWS_LAMBDA_FUNCTION_NAME enables eager mode', async () => {
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
  const { captured, restore } = setupFetchCapture();
  try {
    const count = await runChat(captured, 'ws_lambda_test');
    assert.ok(count > 0, 'AWS_LAMBDA_FUNCTION_NAME should enable eager mode');
  } finally {
    restore();
  }
});

test('auto-detect: NETLIFY=true enables eager mode', async () => {
  process.env.NETLIFY = 'true';
  const { captured, restore } = setupFetchCapture();
  try {
    const count = await runChat(captured, 'ws_netlify_test');
    assert.ok(count > 0, 'NETLIFY=true should enable eager mode');
  } finally {
    restore();
  }
});

test('auto-detect: K_SERVICE (Cloud Run) enables eager mode', async () => {
  process.env.K_SERVICE = 'my-service';
  const { captured, restore } = setupFetchCapture();
  try {
    const count = await runChat(captured, 'ws_cloudrun_test');
    assert.ok(count > 0, 'K_SERVICE should enable eager mode');
  } finally {
    restore();
  }
});

test('no serverless markers → lazy mode (no inline flush)', async () => {
  const { captured, restore } = setupFetchCapture();
  try {
    const count = await runChat(captured, 'ws_node_local');
    assert.equal(count, 0, 'without serverless markers, lazy mode should defer the flush');
  } finally {
    restore();
  }
});
