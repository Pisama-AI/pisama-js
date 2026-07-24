// Next.js App Router reference route. This is what the install prompt asks
// AI builders to produce. The observe() wrap is one line; everything else is
// standard Vercel AI SDK Next.js boilerplate.

import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { observe } from '@pisama/sdk';

export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  const { messages } = (await req.json()) as { messages: UIMessage[] };

  const result = streamText({
    model: observe(openai('gpt-4o-mini'), { redact: 'metadata-only' }),
    messages: convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
