import { unionBox } from "@/lib/extraction/geometry";
import type { TextLine } from "@/lib/extraction/types";

// HunyuanOCR returns widely spaced handwriting word by word. The grading
// pipeline works in lines, so words that sit on the same baseline and close
// together are joined. Typed pages come back as whole lines and pass through
// unchanged. Same rules as groupTextLines in extraction/prepare-document.ts.

/**
 * Joining stops at gaps wider than this many line heights (columns, diagram
 * labels). Handwriting spaces words widely: a real line measured 2.55.
 */
const MAX_GAP_IN_HEIGHTS = 3;

export function mergeWordsIntoLines(items: TextLine[]): TextLine[] {
  type Row = { items: TextLine[]; top: number; bottom: number };
  const rows: Row[] = [];

  const byCenter = [...items].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x);
  for (const item of byCenter) {
    const top = item.box.y;
    const bottom = item.box.y + item.box.h;
    // A row's band is the average extent of its items, so a slanted line doesn't drift.
    const row = rows.find((candidate) => {
      const overlap = Math.min(bottom, candidate.bottom) - Math.max(top, candidate.top);
      return overlap >= 0.5 * Math.min(item.box.h, candidate.bottom - candidate.top);
    });
    if (row) {
      row.items.push(item);
      row.top = row.items.reduce((sum, i) => sum + i.box.y, 0) / row.items.length;
      row.bottom = row.items.reduce((sum, i) => sum + i.box.y + i.box.h, 0) / row.items.length;
    } else {
      rows.push({ items: [item], top, bottom });
    }
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    const sorted = row.items.sort((a, b) => a.box.x - b.box.x);
    const height = row.bottom - row.top;
    let group: TextLine[] = [];
    const flush = () => {
      if (group.length) {
        lines.push({
          text: group.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim(),
          box: unionBox(group.map((item) => item.box)),
        });
      }
      group = [];
    };
    for (const item of sorted) {
      const previous = group.at(-1);
      if (previous && item.box.x - (previous.box.x + previous.box.w) > MAX_GAP_IN_HEIGHTS * height) flush();
      group.push(item);
    }
    flush();
  }

  return sortReadingOrder(lines);
}

/** "Carbon" written above "dioxide" is one label: join short texts stacked in a column. */
export function joinStackedLabels(labels: TextLine[]): TextLine[] {
  const joined: TextLine[] = [];
  for (const label of labels) {
    const above = joined.find((other) => {
      const overlapX =
        Math.min(other.box.x + other.box.w, label.box.x + label.box.w) - Math.max(other.box.x, label.box.x);
      const gap = label.box.y - (other.box.y + other.box.h);
      return overlapX > 0.5 * Math.min(other.box.w, label.box.w) && gap >= -0.5 * label.box.h && gap < label.box.h;
    });
    if (above) {
      above.text = `${above.text} ${label.text}`;
      above.box = unionBox([above.box, label.box]);
    } else {
      joined.push({ ...label, box: { ...label.box } });
    }
  }
  return joined;
}

/**
 * Top to bottom, then left to right within a row. Sorting by top edge alone
 * puts a margin label like "Q2." (a few pixels lower than its line) after the
 * line it starts, so items that overlap vertically are treated as one row.
 * Tall items (diagrams) are placed by their top edge.
 */
export function sortReadingOrder<T extends TextLine>(items: T[]): T[] {
  const heights = items.map((item) => item.box.h).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const rows: { top: number; bottom: number; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => a.box.y - b.box.y)) {
    const top = item.box.y;
    const bottom = item.box.y + item.box.h;
    const tall = typical > 0 && item.box.h > 3 * typical;
    const row = tall
      ? undefined
      : rows.find(
          (candidate) =>
            candidate.items.length > 0 &&
            !(typical > 0 && candidate.bottom - candidate.top > 3 * typical) &&
            Math.min(bottom, candidate.bottom) - Math.max(top, candidate.top) >=
              0.5 * Math.min(item.box.h, candidate.bottom - candidate.top),
        );
    if (row) {
      row.items.push(item);
    } else {
      rows.push({ top, bottom, items: [item] });
    }
  }
  // Tall items side by side (two tables, three diagrams) start at about the
  // same height; read them left to right rather than by a few pixels of top edge.
  const isTall = (row: { top: number; bottom: number }) => typical > 0 && row.bottom - row.top > 3 * typical;
  return rows
    .sort((a, b) =>
      isTall(a) && isTall(b) && Math.abs(a.top - b.top) < 2 * typical ? a.items[0].box.x - b.items[0].box.x : a.top - b.top,
    )
    .flatMap((row) => row.items.sort((a, b) => a.box.x - b.box.x));
}
