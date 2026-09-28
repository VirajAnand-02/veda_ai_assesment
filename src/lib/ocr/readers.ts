import "server-only";
import type { LanguageModel } from "ai";
import type { BoxFormat } from "@/lib/extraction/geometry";
import type { TextLine } from "@/lib/extraction/types";
import type { OcrEngine } from "@/lib/ai/vision-settings";
import { enhancePage } from "./image";
import { readWithNemotron } from "./nemotron";
import { readWithPaddle } from "./paddle";
import { readWithStructure, type StructuredRead } from "./structure";

// Reads a scanned page into positioned lines, plus one line per table and per
// drawing. Used by the grading pipeline (AI_OCR_ENGINE):
//   nemotron-v1 - NVIDIA Nemotron OCR v1 (hosted) for the text
//   paddle-llm  - PaddleOCR (OCR_server) for the text
// In both, tables come from grids in the OCR's cells that NVIDIA page-elements
// or the vision model also calls a table, and drawings are found and described
// by the vision model (see structure.ts).

export type PageReadOptions = {
  /** Finds and describes drawings (AI_VISION_MODEL). */
  model: LanguageModel;
  boxFormat: BoxFormat;
  /** Raise contrast and brightness first (AI_OCR_ENHANCE). */
  enhance?: boolean;
  signal?: AbortSignal;
};

/** Grading goes on with what was read; a page read without tables or drawings shows up in the server log. */
function withWarnings(engine: OcrEngine, result: StructuredRead): TextLine[] {
  for (const warning of result.warnings) console.warn(`[${engine}] ${warning}`);
  return result.lines;
}

export function createPageReader(engine: OcrEngine, options: PageReadOptions): (image: Uint8Array) => Promise<TextLine[]> {
  const readText =
    engine === "paddle-llm"
      ? (image: Uint8Array) => readWithPaddle(image, "image/jpeg", options.signal)
      : (image: Uint8Array) => readWithNemotron(image, "image/jpeg", options.signal);
  const read = async (image: Uint8Array) =>
    withWarnings(engine, await readWithStructure(image, "image/jpeg", readText(image), options));
  return options.enhance ? async (image) => read(await enhancePage(image)) : read;
}
