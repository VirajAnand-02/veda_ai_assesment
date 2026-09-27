// Papers often let students pick: "Answer any five questions", or a part with
// "Write short notes on the following (any two)". These helpers decide which
// graded questions count towards the total. Pure functions, so they're easy to
// test and never depend on the model's arithmetic.

/** "Answer any N" rule. `within` is the parent's label path; [] is the whole paper. */
export type ChoiceRule = { within: string[]; select: number };

export type ScoredLeaf = {
  id: string;
  /** [number, ...sub-part labels], e.g. ["8", "b", "ii"]. */
  path: string[];
  score: number;
  maxMarks: number;
  answered: boolean;
};

type Unit = { score: number; max: number; attempted: boolean; ids: string[]; order: number };

const segmentKey = (segment: string) => segment.trim().toLowerCase();
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((segment, index) => segmentKey(segment) === segmentKey(b[index]));

export function formatLabel(path: string[]) {
  const [number = "", ...parts] = path;
  return number + parts.map((part) => `(${part})`).join("");
}

/**
 * Parses labels such as "8(b)", "8 b", "8.b.ii", "Q1a" into a path. Returns
 * null for "whole paper" style values.
 */
export function parseLabel(label: string | null | undefined): string[] | null {
  if (!label) return null;
  const cleaned = label.trim().replace(/^(?:q(?:uestion)?|ques)\.?\s*/i, "");
  const tokens = cleaned.match(/[A-Za-z0-9]+/g);
  if (!tokens?.length || /^(?:paper|all|whole|questions?)$/i.test(tokens[0])) return null;
  // "1a" -> "1", "a"
  const split = tokens[0].match(/^(\d+)([a-z]+)$/i);
  return split ? [split[1], split[2], ...tokens.slice(1)] : tokens;
}

/**
 * Picks the questions that count: under each rule, the best `select` units by
 * score (ties go to attempted ones, then printed order). Units nest, so "any
 * two" inside a question is resolved before "any five questions".
 */
export function applyChoiceRules(leaves: ScoredLeaf[], rules: ChoiceRule[]) {
  const notes: string[] = [];

  function evaluate(prefix: string[], members: ScoredLeaf[], order: number): Unit {
    // Direct children in printed order: a leaf at this level, or a group of
    // leaves sharing the next label segment.
    const children: ({ leaf: ScoredLeaf } | { segment: string; leaves: ScoredLeaf[] })[] = [];
    const groups = new Map<string, ScoredLeaf[]>();
    for (const leaf of members) {
      if (leaf.path.length === prefix.length) {
        children.push({ leaf });
        continue;
      }
      const segment = leaf.path[prefix.length];
      const existing = groups.get(segmentKey(segment));
      if (existing) {
        existing.push(leaf);
      } else {
        const leaves = [leaf];
        groups.set(segmentKey(segment), leaves);
        children.push({ segment, leaves });
      }
    }

    const resolved: Unit[] = children.map((child, index) =>
      "leaf" in child
        ? { score: child.leaf.score, max: child.leaf.maxMarks, attempted: child.leaf.answered, ids: [child.leaf.id], order: index }
        : evaluate([...prefix, child.segment], child.leaves, index),
    );

    const rule = rules.find((candidate) => samePath(candidate.within, prefix));
    let chosen = resolved;
    if (rule && rule.select > 0 && rule.select < resolved.length) {
      chosen = [...resolved]
        .sort((a, b) => b.score - a.score || Number(b.attempted) - Number(a.attempted) || a.order - b.order)
        .slice(0, rule.select);
      const attempted = resolved.filter((unit) => unit.attempted).length;
      const scope = prefix.length ? `Q${formatLabel(prefix)} asks for any ${rule.select} of its ${resolved.length} parts` : `The paper asks for any ${rule.select} of ${resolved.length} questions`;
      notes.push(
        attempted > rule.select
          ? `${scope}: ${attempted} were attempted, so the best ${rule.select} are counted.`
          : `${scope}: ${attempted} attempted; questions left out are not counted against the student.`,
      );
    }

    return {
      score: chosen.reduce((sum, unit) => sum + unit.score, 0),
      max: chosen.reduce((sum, unit) => sum + unit.max, 0),
      attempted: chosen.some((unit) => unit.attempted),
      ids: chosen.flatMap((unit) => unit.ids),
      order,
    };
  }

  const total = evaluate([], leaves, 0);
  return { counted: new Set(total.ids), score: total.score, maxScore: total.max, notes };
}
