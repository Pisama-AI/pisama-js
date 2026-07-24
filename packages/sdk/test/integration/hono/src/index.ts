// Hono reference. Common in Cloudflare Workers + vibe-coder Bun setups.
// Same observe() wrap, different route handler signature.

import { Hono } from 'hono';
import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { observe } from '@pisama/sdk';

const app = new Hono();

app.post('/api/chat', async (c) => {
  const { messages } = (await c.req.json()) as { messages: UIMessage[] };

  const result = streamText({
    model: observe(openai('gpt-4o-mini'), { redact: 'metadata-only' }),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
});

export default app;
