import { boxFrom1000 } from "@/lib/extraction/geometry";
import type { TextLine } from "@/lib/extraction/types";

// Parses HunyuanOCR "spotting_json" output: a JSON array of
//   { "box": [xmin, ymin, xmax, ymax], "text": "..." }
// with coordinates on a 0–1000 scale. Real output isn't always clean (code
// fences, a truncated last item when max_tokens is hit, stray prose), so this
// falls back to pulling out individual objects.

type RawItem = { box?: unknown; bbox?: unknown; text?: unknown };

export function parseSpottingOutput(output: string): { lines: TextLine[]; recovered: boolean } {
  const cleaned = output.replace(/```(?:json)?/gi, "").trim();

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return { lines: toLines(parsed as RawItem[]), recovered: false };
    } catch {
      // Fall through to per-object recovery.
    }
  }

  const items: RawItem[] = [];
  for (const match of cleaned.matchAll(/\{[^{}]*\}/g)) {
    try {
      items.push(JSON.parse(match[0]));
    } catch {
      // Skip objects that are themselves malformed.
    }
  }
  return { lines: toLines(items), recovered: true };
}

function toLines(items: RawItem[]): TextLine[] {
  return items.flatMap((item) => {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const box = toBox(item.box ?? item.bbox);
    return text && box ? [{ text, box }] : [];
  });
}

/** Accepts [xmin, ymin, xmax, ymax] or a 4-point polygon [x1, y1, ..., x4, y4]. */
function toBox(value: unknown) {
  if (!Array.isArray(value)) return null;
  const numbers = value.flat().map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  if (numbers.length === 4) {
    const [xmin, ymin, xmax, ymax] = numbers;
    return boxFrom1000([ymin, xmin, ymax, xmax]); // boxFrom1000 takes y-first
  }
  if (numbers.length === 8) {
    const xs = [numbers[0], numbers[2], numbers[4], numbers[6]];
    const ys = [numbers[1], numbers[3], numbers[5], numbers[7]];
    return boxFrom1000([Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)]);
  }
  return null;
}
