import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  tool,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/models";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Same model as the extraction pipeline, chosen with AI_MODEL in .env.
  const result = streamText({
    model: getModel("text"),
    system: "You are a helpful assistant.",
    messages: await convertToModelMessages(messages),
    stopWhen: isStepCount(5),
    tools: {
      // Example tool: replace the stubbed execute() with a real API call.
      weather: tool({
        description: "Get the current weather in a location (fahrenheit)",
        inputSchema: z.object({
          location: z.string().describe("The location to get the weather for"),
        }),
        execute: async ({ location }) => ({
          location,
          temperature: Math.round(Math.random() * (90 - 32) + 32),
        }),
      }),
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
