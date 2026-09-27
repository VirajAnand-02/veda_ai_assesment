import "server-only";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError, requestJson } from "./http";
import { parseMistralPage, type MistralResponse } from "./parse-mistral";

// Mistral's hosted OCR API (https://docs.mistral.ai/api/endpoint/ocr).
//   MISTRAL_API_KEY=...
//   MISTRAL_OCR_MODEL=mistral-ocr-latest      (default)
//   MISTRAL_BASE_URL=https://api.mistral.ai/v1 (default)

export function getMistralConfig(): { apiKey: string; model: string; baseURL: string } | null {
  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.MISTRAL_OCR_MODEL?.trim() || "mistral-ocr-latest",
    baseURL: (process.env.MISTRAL_BASE_URL?.trim() || "https://api.mistral.ai/v1").replace(/\/+$/, ""),
  };
}

export async function readWithMistral(
  image: Uint8Array,
  mediaType: string,
  signal?: AbortSignal,
): Promise<{ lines: TextLine[]; model: string; markdown: string; warnings: string[] }> {
  const config = getMistralConfig();
  if (!config) throw new OcrServiceError("Mistral OCR is not configured. Set MISTRAL_API_KEY in .env.local.");

  const document = { type: "image_url", image_url: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` };
  const send = (withBlocks: boolean) =>
    requestJson(
      "POST",
      `${config.baseURL}/ocr`,
      { model: config.model, document, ...(withBlocks && { include_blocks: true }) },
      { apiKey: config.apiKey, signal, service: "Mistral OCR", unreachableHint: "Check the internet connection." },
    );

  // Block positions need a model that supports them; an older pinned model
  // rejects the option, so retry without it and return the text alone.
  let response = await send(true);
  let blocksRejected = false;
  if (response.status === 400 || response.status === 422) {
    const retry = await send(false);
    if (retry.status >= 200 && retry.status < 300) {
      response = retry;
      blocksRejected = true;
    }
  }

  let data: MistralResponse & { message?: unknown; detail?: unknown };
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new OcrServiceError(`Mistral OCR returned a response that isn't JSON (${response.status}).`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new OcrServiceError(describeFailure(response.status, data, config.model));
  }

  const page = parseMistralPage(data.pages?.[0] ?? {});
  const warnings: string[] = [];
  if (!page.hadBlocks) {
    warnings.push(
      blocksRejected
        ? `${config.model} doesn't return block positions, so only its text is shown (raw output). Use mistral-ocr-latest.`
        : "Mistral returned no block positions, so only its text is shown (raw output).",
    );
  }
  return { lines: page.lines, model: data.model ?? config.model, markdown: page.markdown, warnings };
}

function describeFailure(status: number, data: { message?: unknown; detail?: unknown }, model: string) {
  if (status === 401) return "Mistral rejected the API key. Check MISTRAL_API_KEY.";
  if (status === 429) {
    return "Mistral OCR rate limit reached (429). Wait a minute and retry; if it persists, the key's plan may not include OCR (check console.mistral.ai).";
  }
  const detail = typeof data.message === "string" ? data.message : data.detail ? JSON.stringify(data.detail) : "";
  return `Mistral OCR (${model}) failed (${status})${detail ? `: ${detail.slice(0, 300)}` : "."}`;
}

/** For the /ocr page's engine list; doesn't call the API (it's billed per page). */
export function mistralStatus(): { configured: boolean; model?: string; error?: string } {
  const config = getMistralConfig();
  return config ? { configured: true, model: config.model } : { configured: false, error: "MISTRAL_API_KEY is not set" };
}
