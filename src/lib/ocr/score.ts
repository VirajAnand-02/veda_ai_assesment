import { iou } from "@/lib/extraction/geometry";
import type { TextLine } from "@/lib/extraction/types";

// Scores OCR boxes against known-correct lines (a typed PDF's text layer).
// Each true line is matched to the predicted line with the most words in
// common; the score is how well the matched boxes overlap.

export type AccuracyScore = {
  truthLines: number;
  /** True lines with a predicted line sharing at least half their words. */
  matched: number;
  /** Mean intersection-over-union of matched boxes (1 = perfect). */
  meanIoU: number;
  /** Matched lines whose boxes overlap by at least 0.5 IoU. */
  goodBoxes: number;
};

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function textSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, left.size, right.size);
}

export function scoreAgainstTruth(truth: TextLine[], predicted: TextLine[]): AccuracyScore | null {
  if (truth.length === 0) return null;
  const overlaps: number[] = [];
  for (const line of truth) {
    let best: TextLine | null = null;
    let bestSimilarity = 0;
    for (const candidate of predicted) {
      const similarity = textSimilarity(line.text, candidate.text);
      if (similarity > bestSimilarity) {
        best = candidate;
        bestSimilarity = similarity;
      }
    }
    if (best && bestSimilarity >= 0.5) overlaps.push(iou(line.box, best.box));
  }
  return {
    truthLines: truth.length,
    matched: overlaps.length,
    meanIoU: overlaps.length ? overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length : 0,
    goodBoxes: overlaps.filter((value) => value >= 0.5).length,
  };
}
