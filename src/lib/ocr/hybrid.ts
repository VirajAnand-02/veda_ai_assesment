import "server-only";
import { generateText, type LanguageModel } from "ai";
import { overlapArea, unionBox } from "@/lib/extraction/geometry";
import type { Box, TextLine } from "@/lib/extraction/types";
import { detectLayoutWithHunyuan, spotTextWithHunyuan } from "./hunyuan";
import { cropRegion } from "./image";
import { joinStackedLabels, mergeWordsIntoLines, sortReadingOrder } from "./merge-lines";
import { DIAGRAM_CATEGORY } from "./parse-layout";

// Hybrid page reader: HunyuanOCR for precise text boxes, HunyuanOCR layout to
// find diagrams, and a vision LLM to say what each diagram shows.
//
// Spotting only returns text, so a drawing shows up as scattered labels
// ("Sunlight", "Oxygen"). Layout returns a "figure" region, but only around
// the drawing itself, so labels written around it are pulled in: they join the
// diagram's box and its description instead of standing as separate lines.

export type HybridOptions = {
  /** Describes each diagram crop. Null = describe with its labels only. */
  describeModel: LanguageModel | null;
  signal?: AbortSignal;
};

export type HybridResult = { lines: TextLine[]; diagrams: number; warnings: string[] };

// A short line level with a diagram and this close to it is one of its labels.
const LABEL_MAX_WORDS = 4;
const LABEL_MAX_DISTANCE = 0.3; // page widths
const REGION_PAD = 0.02;

const DESCRIBE_INSTRUCTIONS = `You are looking at a drawing from a student's handwritten exam answer.
In one sentence of at most 30 words, say what the drawing shows, mentioning its labels and arrows, so a teacher can grade it.
Describe only what is drawn. Do not judge it.`;

export async function readPageHybrid(image: Uint8Array, mediaType: string, options: HybridOptions): Promise<HybridResult> {
  const warnings: string[] = [];
  // Sequential on purpose: the local OCR server handles one request at a time.
  const spotting = await spotTextWithHunyuan(image, mediaType, options.signal);
  const layout = await detectLayoutWithHunyuan(image, mediaType, options.signal);
  if (spotting.truncated || layout.truncated) warnings.push("HunyuanOCR hit its token limit; some text may be missing.");

  let lines = mergeWordsIntoLines(spotting.lines);
  const regions = layout.regions.filter((region) => DIAGRAM_CATEGORY.test(region.category)).map((region) => region.box);

  const diagrams: TextLine[] = [];
  for (const region of regions) {
    const labels = joinStackedLabels(sortReadingOrder(lines.filter((line) => isLabelOf(line, region))));
    lines = lines.filter((line) => !isLabelOf(line, region));
    const box = unionBox([region, ...labels.map((label) => label.box)]);

    let description = "";
    if (options.describeModel) {
      try {
        description = await describeDiagram(image, box, options.describeModel, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        warnings.push("A diagram couldn't be described by the vision model; only its labels are listed.");
      }
    }
    const labelText = labels.map((label) => label.text).join(", ");
    const parts = [description.replace(/\.$/, ""), labelText && `Labels: ${labelText}`].filter(Boolean);
    diagrams.push({ text: `[diagram: ${parts.join(". ") || "drawing"}]`, box });
  }

  return { lines: sortReadingOrder([...lines, ...diagrams]), diagrams: diagrams.length, warnings };
}

function isLabelOf(line: TextLine, region: Box): boolean {
  if (/^(q(ues(tion)?)?|ans(wer)?)\.?\s*\d/i.test(line.text)) return false; // question labels stay text
  const area = line.box.w * line.box.h;
  const grown = { x: region.x - REGION_PAD, y: region.y - REGION_PAD, w: region.w + 2 * REGION_PAD, h: region.h + 2 * REGION_PAD };
  if (area > 0 && overlapArea(line.box, grown) >= 0.5 * area) return true;

  // Short text beside the drawing, level with it.
  const words = line.text.trim().split(/\s+/).length;
  const center = line.box.y + line.box.h / 2;
  const level = center >= grown.y && center <= grown.y + grown.h;
  const gap = Math.max(0, region.x - (line.box.x + line.box.w), line.box.x - (region.x + region.w));
  return words <= LABEL_MAX_WORDS && level && gap <= LABEL_MAX_DISTANCE;
}

async function describeDiagram(
  image: Uint8Array,
  box: Box,
  model: LanguageModel,
  signal?: AbortSignal,
): Promise<string> {
  const crop = await cropRegion(image, box, REGION_PAD);
  const { text } = await generateText({
    model,
    instructions: DESCRIBE_INSTRUCTIONS,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this drawing." },
          { type: "file", data: crop, mediaType: "image/jpeg", providerOptions: { deepseek: { imageDetail: "high" } } },
        ],
      },
    ],
    abortSignal: signal,
  });
  return text.replace(/\s+/g, " ").trim();
}
