// Express reference. Common Replit shape — Replit Agent often defaults to
// Express for backend APIs. Same observe() wrap.

import express from 'express';
import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { observe } from '@pisama/sdk';

const app = express();
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body as { messages: UIMessage[] };

  const result = streamText({
    model: observe(openai('gpt-4o-mini'), { redact: 'metadata-only' }),
    messages: convertToModelMessages(messages),
  });

  // Pipe the AI SDK response into Express's response stream.
  const response = result.toUIMessageStreamResponse();
  res.status(response.status);
  response.headers.forEach((v, k) => res.setHeader(k, v));
  if (response.body) {
    const reader = response.body.getReader();
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(Buffer.from(value));
      await pump();
    };
    await pump();
  } else {
    res.end();
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Express + pisama listening on http://localhost:${port}`);
});
