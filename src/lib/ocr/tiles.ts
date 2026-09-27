import { boxInFrame, unionBox } from "@/lib/extraction/geometry";
import type { Box, TextLine } from "@/lib/extraction/types";
import { sortReadingOrder } from "./merge-lines";
import { textSimilarity } from "./score";

// Combines lines read from overlapping horizontal strips of one page.
// Strips overlap so every line is whole in at least one strip. A line touching
// a strip edge that a neighbour continues past is a partial read and is
// dropped; lines read twice in an overlap keep the copy nearest its strip's
// middle. Diagrams can span strips, so their pieces are joined instead.

export type StripLines = { frame: Box; lines: TextLine[] };

const EDGE = 0.01; // within 1% of a strip edge counts as touching it

const isDiagram = (line: TextLine) => /^\[diagram/i.test(line.text);

/** Share of the shorter text's words found in the other (a partial read of a line counts as the same line). */
function containment(a: string, b: string) {
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function verticalOverlap(a: Box, b: Box) {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > 0 ? overlap / Math.min(a.h, b.h) : 0;
}

export function mergeStripLines(strips: StripLines[]): TextLine[] {
  type Candidate = TextLine & { strip: number; margin: number };
  const text: Candidate[] = [];
  const diagrams: Candidate[] = [];

  strips.forEach((strip, index) => {
    const top = strip.frame.y;
    const bottom = strip.frame.y + strip.frame.h;
    for (const line of strip.lines) {
      const box = boxInFrame(line.box, strip.frame);
      const center = box.y + box.h / 2;
      const candidate = { text: line.text, box, strip: index, margin: Math.min(center - top, bottom - center) };
      if (isDiagram(line)) {
        diagrams.push(candidate);
        continue;
      }
      const cutAtTop = index > 0 && line.box.y < EDGE;
      const cutAtBottom = index < strips.length - 1 && line.box.y + line.box.h > 1 - EDGE;
      if (!cutAtTop && !cutAtBottom) text.push(candidate);
    }
  });

  // Same line read in two strips: keep the most central copy. A shorter,
  // partial read of the same line counts as a duplicate too.
  const kept: Candidate[] = [];
  for (const candidate of [...text].sort((a, b) => b.margin - a.margin)) {
    const duplicate = kept.some(
      (other) =>
        other.strip !== candidate.strip &&
        verticalOverlap(other.box, candidate.box) > 0.5 &&
        (textSimilarity(other.text, candidate.text) >= 0.6 || containment(other.text, candidate.text) >= 0.8),
    );
    if (!duplicate) kept.push(candidate);
  }

  // Diagram pieces from different strips that touch or overlap become one.
  const joined: Candidate[] = [];
  for (const diagram of [...diagrams].sort((a, b) => a.box.y - b.box.y)) {
    const previous = joined.find(
      (other) =>
        other.strip !== diagram.strip &&
        diagram.box.y <= other.box.y + other.box.h + 0.02 &&
        Math.min(other.box.x + other.box.w, diagram.box.x + diagram.box.w) > Math.max(other.box.x, diagram.box.x),
    );
    if (previous) {
      previous.box = unionBox([previous.box, diagram.box]);
      if (diagram.text.length > previous.text.length) previous.text = diagram.text;
      previous.strip = diagram.strip;
    } else {
      joined.push({ ...diagram });
    }
  }

  return sortReadingOrder([...kept, ...joined].map(({ text, box }) => ({ text, box })));
}
