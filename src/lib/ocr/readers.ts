import "server-only";
import type { LanguageModel } from "ai";
import type { BoxFormat } from "@/lib/extraction/geometry";
import { transcribePage } from "@/lib/extraction/pipeline";
import type { TextLine } from "@/lib/extraction/types";
import type { OcrEngine } from "@/lib/ai/vision-settings";
import { spotTextWithHunyuan } from "./hunyuan";
import { readPageHybrid } from "./hybrid";
import { cropStrips, enhancePage } from "./image";
import { OcrServiceError } from "./http";
import { mergeWordsIntoLines } from "./merge-lines";
import { readWithMistral } from "./mistral";
import { readWithNemotron } from "./nemotron";
import { readWithPaddle } from "./paddle";
import { readWithStructure, type StructuredRead } from "./structure";
import { mergeStripLines } from "./tiles";

// The ways to read a scanned page into positioned lines. Used by the
// grading pipeline (AI_OCR_ENGINE) and the /ocr comparison page.

export type VisionReadOptions = {
  model: LanguageModel;
  boxFormat: BoxFormat;
  /** Horizontal strips per page; each strip gets the model's full image budget. */
  tiles: number;
  signal?: AbortSignal;
};

/** Vision LLM, optionally strip by strip. */
export async function readWithVisionModel(image: Uint8Array, options: VisionReadOptions): Promise<TextLine[]> {
  if (options.tiles <= 1) return transcribePage(image, options);
  const strips = await cropStrips(image, options.tiles);
  const read = await Promise.all(
    strips.map(async (strip) => ({ frame: strip.frame, lines: await transcribePage(strip.image, options) })),
  );
  return mergeStripLines(read);
}

/** HunyuanOCR text spotting, with words joined into lines. */
export async function readWithHunyuan(image: Uint8Array, mediaType: string, signal?: AbortSignal) {
  const result = await spotTextWithHunyuan(image, mediaType, signal);
  return { ...result, lines: mergeWordsIntoLines(result.lines) };
}

/**
 * PaddleOCR text with tables and diagrams: tables are grids in PaddleOCR's
 * cells that page-elements (when NVIDIA_API_KEY is set) or the vision LLM also
 * calls a table; diagrams are found and described by the vision LLM.
 */
export function readWithPaddleAndLlm(
  image: Uint8Array,
  mediaType: string,
  options: Pick<VisionReadOptions, "model" | "boxFormat" | "signal">,
) {
  return readWithStructure(image, mediaType, readWithPaddle(image, mediaType, options.signal), options);
}

/** Grading goes on with what was read; a page read without tables or drawings shows up in the server log. */
function withWarnings(engine: OcrEngine, result: StructuredRead): TextLine[] {
  for (const warning of result.warnings) console.warn(`[${engine}] ${warning}`);
  return result.lines;
}

export function createPageReader(
  engine: OcrEngine,
  options: VisionReadOptions & { enhance?: boolean },
): (image: Uint8Array) => Promise<TextLine[]> {
  const read = pageReader(engine, options);
  // Contrast and brightness raised first (AI_OCR_ENHANCE).
  return options.enhance ? async (image) => read(await enhancePage(image)) : read;
}

function pageReader(engine: OcrEngine, options: VisionReadOptions): (image: Uint8Array) => Promise<TextLine[]> {
  switch (engine) {
    case "hunyuan":
      return async (image) => (await readWithHunyuan(image, "image/jpeg", options.signal)).lines;
    case "hybrid":
      return async (image) =>
        (await readPageHybrid(image, "image/jpeg", { describeModel: options.model, signal: options.signal })).lines;
    case "paddle":
      return async (image) => (await readWithPaddle(image, "image/jpeg", options.signal)).lines;
    case "paddle-llm":
      return async (image) => withWarnings(engine, await readWithPaddleAndLlm(image, "image/jpeg", options));
    case "nemotron-v1":
    case "nemotron-v2":
      // Nemotron reads text only; tables and drawings are found alongside it.
      return async (image) =>
        withWarnings(
          engine,
          await readWithStructure(image, "image/jpeg", readWithNemotron(image, "image/jpeg", engine, options.signal), options),
        );
    case "mistral":
      return async (image) => {
        const result = await readWithMistral(image, "image/jpeg", options.signal);
        if (!result.lines.length && result.markdown.trim()) {
          throw new OcrServiceError(result.warnings[0] ?? "Mistral OCR returned text without positions.");
        }
        return result.lines;
      };
    default:
      return (image) => readWithVisionModel(image, options);
  }
}
