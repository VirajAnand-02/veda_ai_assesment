import type { Box, TextLine } from "@/lib/extraction/types";

// Mistral OCR (POST /v1/ocr) answers with, per page, the text as markdown and
// — with include_blocks — paragraph-level blocks:
//   { pages: [{ markdown, dimensions: { width, height }, images: [...],
//               blocks: [{ type, content, top_left_x, top_left_y, bottom_right_x, bottom_right_y }] }] }
// Blocks are paragraphs, not lines, so each becomes one (multi-line) region.
// The docs don't say whether coordinates are pixels or page fractions, so both
// are accepted: values all ≤ 1 are fractions, anything else is pixels of
// `dimensions`.

type Corners = {
  top_left_x?: unknown;
  top_left_y?: unknown;
  bottom_right_x?: unknown;
  bottom_right_y?: unknown;
};

export type MistralBlock = Corners & {
  type?: unknown;
  content?: unknown;
  text?: unknown;
  bbox?: unknown;
};

export type MistralPage = {
  markdown?: unknown;
  dimensions?: { width?: unknown; height?: unknown } | null;
  images?: (Corners & { id?: unknown })[] | null;
  blocks?: MistralBlock[] | null;
};

export type MistralResponse = {
  model?: string;
  pages?: MistralPage[];
};

const FIGURE_TYPE = /\b(image|figure|picture|chart|diagram|graph|drawing|photo)s?\b/i;

export function parseMistralPage(page: MistralPage): { lines: TextLine[]; markdown: string; hadBlocks: boolean } {
  const markdown = typeof page.markdown === "string" ? page.markdown : "";
  const dimensions = {
    width: Number(page.dimensions?.width) || 0,
    height: Number(page.dimensions?.height) || 0,
  };
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];

  const lines = blocks.flatMap((block) => {
    const box = blockBox(block, dimensions);
    if (!box) return [];
    const text = flattenMarkdown(stringField(block.content) ?? stringField(block.text) ?? "");
    const figure = typeof block.type === "string" && FIGURE_TYPE.test(block.type);
    if (figure) return [{ text: text ? `[diagram: ${text}]` : "[diagram]", box }];
    return text ? [{ text, box }] : [];
  });

  // Without figure blocks, fall back to the extracted images' positions.
  if (!lines.some((line) => line.text.startsWith("[diagram"))) {
    for (const image of page.images ?? []) {
      const box = cornersBox(image, dimensions);
      if (box) lines.push({ text: "[diagram]", box });
    }
  }

  // Blocks come in Mistral's reading order (which handles columns), so keep it.
  return { lines, markdown, hadBlocks: blocks.length > 0 };
}

function blockBox(block: MistralBlock, dimensions: { width: number; height: number }): Box | null {
  if (Array.isArray(block.bbox)) return toBox(block.bbox.map(Number), dimensions);
  if (block.bbox && typeof block.bbox === "object") return cornersBox(block.bbox as Corners, dimensions);
  return cornersBox(block, dimensions);
}

function cornersBox(corners: Corners, dimensions: { width: number; height: number }): Box | null {
  return toBox(
    [corners.top_left_x, corners.top_left_y, corners.bottom_right_x, corners.bottom_right_y].map((value) =>
      value === null || value === undefined ? NaN : Number(value),
    ),
    dimensions,
  );
}

/** [x1, y1, x2, y2] in page fractions or pixels → a page-fraction box. */
function toBox(values: number[], { width, height }: { width: number; height: number }): Box | null {
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const fractional = values.every((value) => value <= 1.0001);
  const [scaleX, scaleY] = fractional ? [1, 1] : [width, height];
  if (!scaleX || !scaleY) return null;
  const [x1, y1, x2, y2] = values;
  const left = clamp(Math.min(x1, x2) / scaleX);
  const top = clamp(Math.min(y1, y2) / scaleY);
  const right = clamp(Math.max(x1, x2) / scaleX);
  const bottom = clamp(Math.max(y1, y2) / scaleY);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const stringField = (value: unknown) => (typeof value === "string" ? value : null);

/** Block content is markdown; keep the words, drop the markup. */
export function flattenMarkdown(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}
