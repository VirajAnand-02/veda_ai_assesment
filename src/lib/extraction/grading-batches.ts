// Splits the questions into grading batches, in code (no model): about one
// batch per 9 marks, small-mark questions together and big ones on their own,
// so each batch can get a reasoning effort to match (see lib/ai/reasoning.ts).

export type BatchItem = { id: string; marks: number };

export const MARKS_PER_BATCH = 9;

/**
 * k = ceil(total marks / 9) batches (at least 1, at most one per question).
 * Questions are sorted by marks (paper order breaks ties) and cut into k runs
 * whose largest total is as small as possible (ties: the most even split), so
 * small-mark questions share batches. E.g. marks [2,2,2,2,2,4,6] -> k = 3 ->
 * [2,2,2,2] [2,4] [6].
 */
export function planBatches(items: BatchItem[], marksPerBatch = MARKS_PER_BATCH): string[][] {
  if (!items.length) return [];
  const sorted = items
    .map((item, order) => ({ ...item, marks: Math.max(0, item.marks), order }))
    .sort((a, b) => a.marks - b.marks || a.order - b.order);
  const n = sorted.length;
  const total = sorted.reduce((sum, item) => sum + item.marks, 0);
  const k = Math.min(n, Math.max(1, Math.ceil(total / marksPerBatch)));

  const prefix = [0];
  for (const item of sorted) prefix.push(prefix[prefix.length - 1] + item.marks);
  const sum = (from: number, to: number) => prefix[to] - prefix[from]; // items [from, to)

  // best[j][i]: the first i items in j runs, compared by (1) the largest run
  // total, (2) the sum of squared totals (evenness), then (3) longer runs
  // first, so small-mark questions fill batches together.
  type Plan = { max: number; squares: number; lengths: number[] };
  const EPS = 1e-9;
  const better = (a: Plan, b: Plan | null) => {
    if (!b) return true;
    if (Math.abs(a.max - b.max) > EPS) return a.max < b.max;
    if (Math.abs(a.squares - b.squares) > EPS) return a.squares < b.squares;
    for (let index = 0; index < a.lengths.length; index++) {
      if (a.lengths[index] !== b.lengths[index]) return a.lengths[index] > b.lengths[index];
    }
    return false;
  };
  const best: (Plan | null)[][] = Array.from({ length: k + 1 }, () => Array<Plan | null>(n + 1).fill(null));
  best[0][0] = { max: 0, squares: 0, lengths: [] };
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n; i++) {
      for (let from = j - 1; from < i; from++) {
        const previous = best[j - 1][from];
        if (!previous) continue;
        const run = sum(from, i);
        const candidate = { max: Math.max(previous.max, run), squares: previous.squares + run * run, lengths: [...previous.lengths, i - from] };
        if (better(candidate, best[j][i])) best[j][i] = candidate;
      }
    }
  }

  const batches: string[][] = [];
  let start = 0;
  for (const length of best[k][n]!.lengths) {
    batches.push(sorted.slice(start, start + length).map((item) => item.id));
    start += length;
  }
  return batches;
}
