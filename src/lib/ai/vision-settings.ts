import "server-only";
import { BOX_FORMATS, type BoxFormat } from "@/lib/extraction/geometry";
import { getModelId } from "./models";

// How scanned pages are read. All of these come from .env:
//   AI_OCR_ENGINE=llm|hunyuan|hybrid|paddle|paddle-llm|mistral|nemotron-v1|nemotron-v2   (default llm)
//   AI_VISION_BOX_FORMAT=auto|xyxy999|yxyx1000|xyxy1000   (default auto)
//   AI_VISION_TILES=1..4                 (default 1 = whole page in one call)

export const OCR_ENGINES = [
  "llm",
  "hunyuan",
  "hybrid",
  "paddle",
  "paddle-llm",
  "mistral",
  "nemotron-v1",
  "nemotron-v2",
] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export function getOcrEngine(): OcrEngine {
  const value = process.env.AI_OCR_ENGINE?.trim().toLowerCase() || "llm";
  if (!OCR_ENGINES.includes(value as OcrEngine)) {
    throw new Error(`AI_OCR_ENGINE must be one of: ${OCR_ENGINES.join(", ")} (got "${value}").`);
  }
  return value as OcrEngine;
}

/**
 * The box convention a vision model was trained on. "auto" picks by model:
 * Gemini uses [ymin, xmin, ymax, xmax] on 0–1000, DeepSeek [x1, y1, x2, y2]
 * on 0–999, and most others (Qwen-VL, GPT, Claude) x-first on 0–1000.
 */
export function resolveBoxFormat(modelId: string, setting?: string | null): BoxFormat {
  const value = setting?.trim().toLowerCase();
  if (value && value !== "auto") {
    if (!BOX_FORMATS.includes(value as BoxFormat)) {
      throw new Error(`Box format must be auto or one of: ${BOX_FORMATS.join(", ")} (got "${value}").`);
    }
    return value as BoxFormat;
  }
  if (/gemini/i.test(modelId)) return "yxyx1000";
  if (/deepseek/i.test(modelId)) return "xyxy999";
  return "xyxy1000";
}

export function resolveTiles(setting?: string | null): number {
  const tiles = Number(setting?.trim() || 1);
  if (!Number.isInteger(tiles) || tiles < 1 || tiles > 4) {
    throw new Error(`Tiles must be a whole number from 1 to 4 (got "${setting}").`);
  }
  return tiles;
}

/**
 * The /ocr page's Groq column: a second vision LLM served by Groq, read with
 * the same reader as AI_VISION_MODEL.
 *   GROQ_OCR_MODEL=qwen/qwen3.8-27b   (default; a Groq model id that accepts images)
 *   GROQ_OCR_TILES=1                  (default 1: Groq's free tier allows ~8k input and
 *                                      ~1k output tokens/min; a page is ~2k in per strip)
 *   GROQ_OCR_BOX_FORMAT=auto
 */
export function getGroqOcrSettings() {
  const modelId = `groq:${process.env.GROQ_OCR_MODEL?.trim() || "qwen/qwen3.8-27b"}`;
  return {
    modelId,
    configured: Boolean(process.env.GROQ_API_KEY?.trim()),
    boxFormat: resolveBoxFormat(modelId, process.env.GROQ_OCR_BOX_FORMAT),
    tiles: resolveTiles(process.env.GROQ_OCR_TILES),
  };
}

export function getVisionSettings(overrides: { boxFormat?: string | null; tiles?: string | null } = {}) {
  const modelId = getModelId("vision");
  return {
    modelId,
    boxFormat: resolveBoxFormat(modelId, overrides.boxFormat ?? process.env.AI_VISION_BOX_FORMAT),
    tiles: resolveTiles(overrides.tiles ?? process.env.AI_VISION_TILES),
    enhance: getOcrEnhance(),
  };
}

/** AI_OCR_ENHANCE=on raises contrast and brightness before a scanned page is read (default off). */
export function getOcrEnhance(): boolean {
  const value = process.env.AI_OCR_ENHANCE?.trim().toLowerCase() || "off";
  if (!["on", "off"].includes(value)) throw new Error(`AI_OCR_ENHANCE must be on or off (got "${value}").`);
  return value === "on";
}
