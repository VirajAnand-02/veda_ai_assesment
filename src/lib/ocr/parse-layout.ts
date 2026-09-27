import { boxFrom1000 } from "@/lib/extraction/geometry";
import type { Box } from "@/lib/extraction/types";

// Parses HunyuanOCR "layout" output: regions with a category and a box on a
// 0–1000 scale. Seen from the model (llama.cpp, v1.5):
//   [{"layout_type":"figure","bbox":"(450,347),(698,347),(698,631),(450,631)"}, …]
// Tencent's scorer also accepts bbox as [[x,y]×4] and a tagged form:
//   text<hy-meta><layout>figure</layout><quad>(x,y),…</quad></hy-meta>

export type LayoutRegion = { category: string; box: Box; text: string };

/** Layout categories that are drawings rather than text (whole words, so "paragraph" isn't a graph). */
export const DIAGRAM_CATEGORY = /\b(figure|image|picture|chart|diagram|graph|illustration|drawing|photo)s?\b/i;

export function parseLayoutOutput(output: string): LayoutRegion[] {
  const cleaned = output.replace(/```(?:json)?/gi, "").trim();

  if (cleaned.includes("<hy-meta>")) {
    const regions: LayoutRegion[] = [];
    const pattern = /([^<]*?)<hy-meta><layout>([^<]+)<\/layout><(?:quad|poly)>([^<]+)<\/(?:quad|poly)><\/hy-meta>/g;
    for (const [, text, category, coordinates] of cleaned.matchAll(pattern)) {
      const box = boxFromPoints(coordinates);
      if (box) regions.push({ category: category.trim(), box, text: text.trim() });
    }
    return regions;
  }

  let items: unknown[] = [];
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    // Truncated output: recover complete objects one by one.
    items = [...cleaned.matchAll(/\{[^{}]*\}/g)].flatMap((match) => {
      try {
        return [JSON.parse(match[0])];
      } catch {
        return [];
      }
    });
  }

  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const category = String(record.layout_type ?? record.category ?? record.type ?? "").trim();
    const box = boxFromPoints(record.bbox ?? record.box ?? record.quad);
    return category && box ? [{ category, box, text: typeof record.text === "string" ? record.text.trim() : "" }] : [];
  });
}

/** Accepts "(x,y),(x,y),…", [[x,y],…], or [x1, y1, x2, y2] (all 0–1000). */
function boxFromPoints(value: unknown): Box | null {
  let numbers: number[];
  if (typeof value === "string") {
    numbers = (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  } else if (Array.isArray(value)) {
    numbers = value.flat().map(Number);
  } else {
    return null;
  }
  if (numbers.length < 4 || numbers.length % 2 !== 0 || numbers.some((n) => !Number.isFinite(n))) return null;
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  return boxFrom1000([Math.min(...ys), Math.min(...xs), Math.max(...ys), Math.max(...xs)]);
}
