// TanStack Start API route — this is the file convention Lovable's AI should
// target when wiring pisama into a Lovable project.
//
// The integration is identical to Next.js: import `observe` from @pisama/sdk,
// wrap your model with one call. The middleware contract is on the AI SDK's
// LanguageModelV4 layer, which is framework-agnostic.

import { createServerFileRoute } from '@tanstack/react-start/server';
import { openai } from '@ai-sdk/openai';
import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { observe } from '@pisama/sdk';

export const ServerRoute = createServerFileRoute('/api/chat').methods({
  POST: async ({ request }) => {
    const { messages } = (await request.json()) as { messages: UIMessage[] };

    const result = streamText({
      // The pisama wrap. Single call, framework-agnostic.
      model: observe(openai('gpt-4o-mini'), { redact: 'metadata-only' }),
      messages: convertToModelMessages(messages),
    });

    return result.toUIMessageStreamResponse();
  },
});
