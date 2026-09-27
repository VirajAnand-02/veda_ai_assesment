import type { Box } from "./types";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Converts a `[ymin, xmin, ymax, xmax]` box on a 0–1000 scale (the convention
 * vision models are asked to use) into a page-fraction box. Returns null for
 * malformed or empty boxes.
 */
export function boxFrom1000(values: number[]): Box | null {
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null;
  const [y1, x1, y2, x2] = values.map((value) => clamp01(value / 1000));
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  return w > 0.002 && h > 0.002 ? { x, y, w, h } : null;
}

/**
 * How a model writes a box. Vision models are trained on different
 * conventions, and asking in their native one gives better boxes:
 * - "yxyx1000": [ymin, xmin, ymax, xmax] on 0–1000 (Gemini)
 * - "xyxy1000": [xmin, ymin, xmax, ymax] on 0–1000 (Qwen-VL, HunyuanOCR)
 * - "xyxy999":  [x1, y1, x2, y2] on 0–999 (DeepSeek vision)
 */
export type BoxFormat = "yxyx1000" | "xyxy1000" | "xyxy999";

export const BOX_FORMATS: BoxFormat[] = ["xyxy999", "yxyx1000", "xyxy1000"];

export function boxFromFormat(values: number[], format: BoxFormat): Box | null {
  if (values.length !== 4) return null;
  if (format === "yxyx1000") return boxFrom1000(values);
  const [x1, y1, x2, y2] = format === "xyxy999" ? values.map((value) => (value * 1000) / 999) : values;
  return boxFrom1000([y1, x1, y2, x2]);
}

/** Maps a box measured inside `frame` (itself a page-fraction box) back to the page. */
export function boxInFrame(box: Box, frame: Box): Box {
  return { x: frame.x + box.x * frame.w, y: frame.y + box.y * frame.h, w: box.w * frame.w, h: box.h * frame.h };
}

/** Intersection over union of two boxes (0 = disjoint, 1 = identical). */
export function iou(a: Box, b: Box): number {
  const inter = overlapArea(a, b);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function overlapArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/** The smallest box containing all of `boxes`, grown by `pad` on each side. */
export function unionBox(boxes: Box[], pad = 0): Box {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  const x = clamp01(left - pad);
  const y = clamp01(top - pad);
  return { x, y, w: clamp01(right + pad) - x, h: clamp01(bottom + pad) - y };
}
