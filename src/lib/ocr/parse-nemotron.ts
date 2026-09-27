import { overlapArea } from "@/lib/extraction/geometry";
import type { Box, TextLine } from "@/lib/extraction/types";
import { mergeWordsIntoLines } from "./merge-lines";

// NVIDIA's Nemotron OCR (NIM) answers with
//   { data: [{ index, text_detections: [{ text_prediction: { text, confidence },
//     bounding_box: { points: [{ x, y } × 4] } }] }] }
// with points as page fractions (0–1). At merge level "sentence" a detection
// is usually one physical line; a question label in the margin ("Q1.") comes
// separately and is joined with its line. v2 sometimes also returns a piece of
// a line ("i.") inside that line's box, which is dropped.

export type NemotronResponse = {
  model?: string;
  data?: {
    text_detections?: {
      text_prediction?: { text?: unknown; confidence?: unknown };
      bounding_box?: { points?: { x?: unknown; y?: unknown }[] };
    }[];
  }[];
};

/** Below this recognition confidence a detection is usually a stray mark. */
const MIN_CONFIDENCE = 0.3;
/** A detection this much inside another is a fragment of it. */
const NESTED = 0.8;

export function parseNemotronResponse(response: NemotronResponse): TextLine[] {
  return mergeWordsIntoLines(parseNemotronSegments(response));
}

/** Detections before joining (fragments inside another detection dropped). */
export function parseNemotronSegments(response: NemotronResponse): TextLine[] {
  const detections = (response.data?.[0]?.text_detections ?? []).flatMap((detection) => {
    const text = typeof detection.text_prediction?.text === "string" ? detection.text_prediction.text.trim() : "";
    const confidence = Number(detection.text_prediction?.confidence ?? 1);
    const box = pointsBox(detection.bounding_box?.points);
    return text && box && !(confidence < MIN_CONFIDENCE) ? [{ text, box }] : [];
  });

  return detections.filter(
    (detection) =>
      !detections.some(
        (other) =>
          other !== detection &&
          area(other.box) > area(detection.box) &&
          overlapArea(other.box, detection.box) >= NESTED * area(detection.box),
      ),
  );
}

function pointsBox(points: { x?: unknown; y?: unknown }[] | undefined): Box | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
  if ([...xs, ...ys].some((value) => !Number.isFinite(value))) return null;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const left = clamp(Math.min(...xs));
  const top = clamp(Math.min(...ys));
  const right = clamp(Math.max(...xs));
  const bottom = clamp(Math.max(...ys));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

const area = (box: Box) => box.w * box.h;

// nemotron-page-elements-v3 answers with regions per class, as page fractions:
//   { data: [{ bounding_boxes: { table: [{ x_min, y_min, x_max, y_max, confidence }], chart: [...],
//     infographic: [...], title: [...], paragraph: [...], header_footer: [...] } }] }

export type PageElementsResponse = {
  data?: { bounding_boxes?: Record<string, { x_min?: unknown; y_min?: unknown; x_max?: unknown; y_max?: unknown; confidence?: unknown }[]> }[];
};

export type PageElement = { kind: string; box: Box; confidence: number };

export function parsePageElements(response: PageElementsResponse): PageElement[] {
  const classes = response.data?.[0]?.bounding_boxes ?? {};
  return Object.entries(classes).flatMap(([kind, regions]) =>
    (Array.isArray(regions) ? regions : []).flatMap((region) => {
      const box = pointsBox([
        { x: region.x_min, y: region.y_min },
        { x: region.x_max, y: region.y_max },
      ]);
      const confidence = Number(region.confidence ?? 0);
      return box ? [{ kind, box, confidence: Number.isFinite(confidence) ? confidence : 0 }] : [];
    }),
  );
}
