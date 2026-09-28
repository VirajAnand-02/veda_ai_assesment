import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { deepseek } from "@ai-sdk/deepseek";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry, gateway } from "ai";

// Models are chosen in .env as "<provider>:<model id>", e.g.
//   AI_MODEL=deepseek:deepseek-v4-flash
//   AI_MODEL=openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
//   AI_VISION_MODEL=google:gemini-3.8-flash
// Only the first ":" separates provider and model, so model ids may contain ":".
// Each provider reads its own API key variable (DEEPSEEK_API_KEY, OPENROUTER_API_KEY,
// GROQ_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY,
// AI_GATEWAY_API_KEY).
// "compatible" is any OpenAI-compatible endpoint (NVIDIA NIM, OpenRouter,
// Together, a local server, ...) configured with OPENAI_COMPATIBLE_BASE_URL /
// _API_KEY, and OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS=off for one that rejects
// JSON schemas.

const compatibleBaseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;

const registry = createProviderRegistry({
  deepseek,
  openrouter,
  groq,
  openai,
  google,
  anthropic,
  gateway,
  ...(compatibleBaseURL && {
    compatible: createOpenAICompatible({
      name: "compatible",
      baseURL: compatibleBaseURL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
      // Send the JSON schema (response_format json_schema) so every pipeline
      // step gets the shape it asks for; without it the schema is dropped with
      // a warning. NVIDIA NIM, OpenRouter, vLLM and most others support it.
      supportsStructuredOutputs: process.env.OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS?.trim().toLowerCase() !== "off",
    }),
  }),
});

export type ModelRole = "text" | "vision";

const MODEL_ENV: Record<ModelRole, { variable: string; fallback: string }> = {
  // Extraction, mapping, grading and the chat demo.
  text: { variable: "AI_MODEL", fallback: "deepseek:deepseek-v4-flash" },
  // Reading scanned pages and photos. Must accept image input.
  vision: { variable: "AI_VISION_MODEL", fallback: "deepseek:deepseek-v4-flash-vision-exp" },
};

export function getModelId(role: ModelRole) {
  const { variable, fallback } = MODEL_ENV[role];
  return process.env[variable]?.trim() || fallback;
}

export function getModel(role: ModelRole) {
  return modelById(getModelId(role));
}

/** A model by "<provider>:<model id>". */
export function modelById(id: string) {
  // The id comes from .env, so it can't be checked against the registry's types.
  return registry.languageModel(id as Parameters<typeof registry.languageModel>[0]);
}
