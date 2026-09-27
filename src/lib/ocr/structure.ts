import "server-only";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { boxFromFormat, type BoxFormat } from "@/lib/extraction/geometry";
import { BOX_WORDING } from "@/lib/extraction/pipeline";
import type { Box, TextLine } from "@/lib/extraction/types";
import { detectPageElements, nemotronConfigured } from "./nemotron";
import { applyPageStructure, combineRegions } from "./page-structure";

// Adds tables and diagrams to a text-only OCR read (Nemotron, PaddleOCR; see
// page-structure.ts). Page-elements and the vision LLM run alongside the text
// OCR, so a page takes about as long as the slowest of them (usually the LLM, ~2–4 s).

export type StructureOptions = {
  /** Finds and describes drawings (and tables). Null = page-elements' tables and printed charts only. */
  model: LanguageModel | null;
  boxFormat: BoxFormat;
  /** Also ask NVIDIA page-elements where tables and charts are (when NVIDIA_API_KEY is set). Default true. */
  pageElements?: boolean;
  signal?: AbortSignal;
};

export type StructuredRead = { lines: TextLine[]; tables: number; diagrams: number; warnings: string[] };

/** The OCR's joined lines, and its boxes before joining (table cells). */
export type TextRead = { lines: TextLine[]; segments?: TextLine[] };

export async function readWithStructure(
  image: Uint8Array,
  mediaType: string,
  readText: Promise<TextRead>,
  options: StructureOptions,
): Promise<StructuredRead> {
  const warnings: string[] = [];
  const optional = <T,>(task: Promise<T[]>, warning: string) =>
    task.catch((error) => {
      if (options.signal?.aborted) throw error;
      console.error(warning, error);
      warnings.push(warning);
      return [] as T[];
    });

  const [text, elements, drawings] = await Promise.all([
    readText,
    options.pageElements !== false && nemotronConfigured()
      ? optional(detectPageElements(image, mediaType, options.signal), "Couldn't check for printed tables and charts (NVIDIA page-elements failed).")
      : Promise.resolve([]),
    options.model
      ? optional(findDrawings(image, mediaType, options), "The vision model couldn't check for drawings, so diagrams may be missing.")
      : Promise.resolve([]),
  ]);
  return { ...applyPageStructure(text.lines, combineRegions(elements, drawings), text.segments), warnings };
}

const instructions = (format: BoxFormat) => `Find every drawing on this exam page: diagrams, sketches, graphs, charts, figures and tables, printed or hand-drawn. Ignore plain text and equations.
For each return "kind" (diagram, graph, chart or table), "${BOX_WORDING[format].field}": its bounding box as ${BOX_WORDING[format].description}, relative to the whole image, enclosing the drawing and its labels, and "description": one sentence of at most 30 words saying what it shows, naming its labels exactly as written. Describe only what is drawn; don't judge it.
Return an empty list if there are none.`;

export async function findDrawings(
  image: Uint8Array,
  mediaType: string,
  { model, boxFormat, signal }: StructureOptions,
): Promise<{ kind: string; box: Box; description: string }[]> {
  const field = BOX_WORDING[boxFormat].field;
  const { output } = await generateText({
    model: model!,
    instructions: instructions(boxFormat),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Find the drawings." },
          { type: "file", data: image, mediaType, providerOptions: { deepseek: { imageDetail: "high" } } },
        ],
      },
    ],
    output: Output.object({
      schema: z.object({
        drawings: z.array(z.object({ kind: z.string(), [field]: z.array(z.number()), description: z.string() })),
      }),
    }),
    abortSignal: signal,
  });
  return (output.drawings as Record<string, unknown>[]).flatMap((drawing) => {
    const values = drawing[field];
    const box = Array.isArray(values) ? boxFromFormat(values.map(Number), boxFormat) : null;
    const description = typeof drawing.description === "string" ? drawing.description.replace(/\s+/g, " ").trim() : "";
    return box ? [{ kind: String(drawing.kind ?? "diagram"), box, description }] : [];
  });
}
