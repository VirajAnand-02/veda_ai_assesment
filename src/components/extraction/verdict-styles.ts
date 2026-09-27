import type { Verdict } from "@/lib/extraction/types";

export type HighlightTone = Verdict | "unmatched";

export const VERDICT_LABELS: Record<Verdict, string> = {
  correct: "Correct",
  partial: "Partially correct",
  incorrect: "Incorrect",
  unanswered: "Not answered",
};

/** Score pills and verdict chips, as in the design (green 2/2, orange 3/5, red 0/2). */
export const VERDICT_PILL: Record<Verdict, string> = {
  correct: "bg-[rgba(69,181,41,0.1)] text-success",
  partial: "bg-[rgba(255,153,0,0.1)] text-warning",
  incorrect: "bg-[#ffe9e2] text-danger",
  unanswered: "bg-off-white text-muted",
};

/** Answer-sheet highlight: outline + tint, and the tab showing the label. */
export const HIGHLIGHT_STYLES: Record<HighlightTone, { box: string; tag: string }> = {
  correct: { box: "border-[#3dd218] bg-[rgba(94,255,53,0.1)]", tag: "bg-success" },
  partial: { box: "border-[#ff9900] bg-[rgba(255,153,0,0.1)]", tag: "bg-warning" },
  incorrect: { box: "border-[#e5484d] bg-[rgba(229,72,77,0.08)]", tag: "bg-danger" },
  unanswered: { box: "border-line bg-transparent", tag: "bg-muted" },
  unmatched: { box: "border-[#7b7b7b] bg-[rgba(48,48,48,0.06)]", tag: "bg-ink" },
};
