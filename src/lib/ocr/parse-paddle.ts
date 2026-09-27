import { boxFromFormat } from "@/lib/extraction/geometry";
import type { TextLine } from "@/lib/extraction/types";
import { mergeWordsIntoLines } from "./merge-lines";

// The OCR server's /paddle/ocr route answers with
//   { model, lines: [{ text, box: [xmin, ymin, xmax, ymax] (0–1000), score }], width, height, durationMs }
// PaddleOCR's detector can split a widely spaced handwritten line into
// segments, so segments on one baseline are joined into lines.

export type PaddleResponse = {
  model?: string;
  lines?: { text?: unknown; box?: unknown; score?: unknown }[];
  durationMs?: number;
};

/** Below this recognition confidence a segment is usually a stray mark, not text. */
const MIN_SCORE = 0.5;

export function parsePaddleResponse(response: PaddleResponse): TextLine[] {
  return mergeWordsIntoLines(parsePaddleSegments(response));
}

/** The detector's own text boxes, before joining. In a table each is usually one cell. */
export function parsePaddleSegments(response: PaddleResponse): TextLine[] {
  return (response.lines ?? []).flatMap((line) => {
    const text = typeof line.text === "string" ? line.text.trim() : "";
    const score = typeof line.score === "number" ? line.score : 1;
    const box = Array.isArray(line.box) ? boxFromFormat(line.box.map(Number), "xyxy1000") : null;
    return text && box && score >= MIN_SCORE ? [{ text, box }] : [];
  });
}
