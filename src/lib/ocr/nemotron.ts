import "server-only";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError, requestJson } from "./http";
import { mergeWordsIntoLines } from "./merge-lines";
import {
  parseNemotronSegments,
  parsePageElements,
  type NemotronResponse,
  type PageElement,
  type PageElementsResponse,
} from "./parse-nemotron";

// NVIDIA's hosted Nemotron models (NIM, build.nvidia.com): OCR v1/v2 for text,
// and page-elements-v3, which finds tables, charts and infographics.
//   NVIDIA_API_KEY=nvapi-...
//   NVIDIA_OCR_BASE_URL=https://ai.api.nvidia.com/v1/cv/nvidia   (default)

export const NEMOTRON_MODELS = { "nemotron-v1": "nemotron-ocr-v1", "nemotron-v2": "nemotron-ocr-v2" } as const;
export type NemotronVersion = keyof typeof NEMOTRON_MODELS;

const PAGE_ELEMENTS_MODEL = "nemotron-page-elements-v3";
const DEFAULT_BASE_URL = "https://ai.api.nvidia.com/v1/cv/nvidia";

function getNemotronConfig() {
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, baseURL: (process.env.NVIDIA_OCR_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "") };
}

export async function readWithNemotron(
  image: Uint8Array,
  mediaType: string,
  version: NemotronVersion,
  signal?: AbortSignal,
): Promise<{ lines: TextLine[]; segments: TextLine[]; model: string }> {
  const model = NEMOTRON_MODELS[version];
  // "sentence" returns about one detection per line; "word" and "paragraph" also exist.
  const data = await callNvidia<NemotronResponse>(model, image, mediaType, { merge_levels: ["sentence"] }, signal);
  const segments = parseNemotronSegments(data);
  return { lines: mergeWordsIntoLines(segments), segments, model: `nvidia/${model}` };
}

/** Tables, charts, infographics, titles, … on the page. Printed documents only: it doesn't see hand drawings. */
export async function detectPageElements(image: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<PageElement[]> {
  return parsePageElements(await callNvidia<PageElementsResponse>(PAGE_ELEMENTS_MODEL, image, mediaType, {}, signal));
}

export const nemotronConfigured = () => getNemotronConfig() !== null;

async function callNvidia<T>(
  model: string,
  image: Uint8Array,
  mediaType: string,
  options: object,
  signal?: AbortSignal,
): Promise<T> {
  const config = getNemotronConfig();
  if (!config) throw new OcrServiceError("Nemotron is not configured. Set NVIDIA_API_KEY in .env.local.");

  const response = await requestJson(
    "POST",
    `${config.baseURL}/${model}`,
    { input: [{ type: "image_url", url: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` }], ...options },
    { apiKey: config.apiKey, signal, service: `NVIDIA ${model}`, unreachableHint: "Check the internet connection." },
  );

  let data: T & { detail?: unknown; title?: unknown };
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new OcrServiceError(`NVIDIA ${model} returned a response that isn't JSON (${response.status}).`);
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof data.detail === "string" ? data.detail : typeof data.title === "string" ? data.title : "";
    throw new OcrServiceError(
      response.status === 401 || response.status === 403
        ? "NVIDIA rejected the API key. Check NVIDIA_API_KEY."
        : response.status === 429
          ? `NVIDIA's rate limit was reached for ${model}. Wait a minute and retry.`
          : `NVIDIA ${model} failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : "."}`,
    );
  }
  return data;
}

/** For the /ocr page's engine list; doesn't call the API. */
export function nemotronStatus(version: NemotronVersion) {
  return getNemotronConfig()
    ? { configured: true, model: `nvidia/${NEMOTRON_MODELS[version]}` }
    : { configured: false, error: "NVIDIA_API_KEY is not set" };
}
