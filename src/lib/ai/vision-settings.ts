import "server-only";
import { BOX_FORMATS, type BoxFormat } from "@/lib/extraction/geometry";
import { getModelId } from "./models";

// How scanned pages are read. All of these come from .env:
//   AI_OCR_ENGINE=nemotron-v1|paddle-llm                   (default nemotron-v1)
//   AI_VISION_BOX_FORMAT=auto|xyxy999|yxyx1000|xyxy1000    (default auto; how the vision model boxes drawings)
//   AI_OCR_ENHANCE=on|off                                  (default off)
// Other readers tried during development are archived in /old_ocr (not in git).

export const OCR_ENGINES = ["nemotron-v1", "paddle-llm"] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];

export function getOcrEngine(): OcrEngine {
  const value = process.env.AI_OCR_ENGINE?.trim().toLowerCase() || "nemotron-v1";
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

export function getVisionSettings() {
  const modelId = getModelId("vision");
  return {
    modelId,
    boxFormat: resolveBoxFormat(modelId, process.env.AI_VISION_BOX_FORMAT),
    enhance: getOcrEnhance(),
  };
}

/** AI_OCR_ENHANCE=on raises contrast and brightness before a scanned page is read (default off). */
export function getOcrEnhance(): boolean {
  const value = process.env.AI_OCR_ENHANCE?.trim().toLowerCase() || "off";
  if (!["on", "off"].includes(value)) throw new Error(`AI_OCR_ENHANCE must be on or off (got "${value}").`);
  return value === "on";
}
