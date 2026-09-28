// Matches answer blocks to questions by the label the student wrote, in code.
// The model then only checks these proposals against the content (a student
// can write "3b" over an answer to 3(c)) and matches the blocks that have no
// usable label; see mapAnswers in pipeline.ts.

export type LabelledQuestion = { id: string; number: string; parts: string[] };
export type LabelledBlock = { id: string; studentLabel: string | null };

export type Proposal = {
  questionIds: string[];
  /** "label": the label names this question; "parent": it names a parent, so all its sub-parts;
   *  "inferred": a bare sub-label ("(b)", "ii.") read against the blocks before it. */
  source: "label" | "parent" | "inferred";
  /** Things the model should look at (e.g. two blocks with the same label). */
  flags: string[];
};

export type StudentLabel = {
  /** Label segments, e.g. ["3", "b", "ii"], or ["b"] when there is no question number. */
  path: string[];
  /** True when there is no question number ("(b)", "ii."). */
  bare: boolean;
};

// "Q", "Ques", "Question", "Ans", "Answer" before the number ("Q2", "Ans. 3").
const PREFIX = /^\s*(?:q(?:ues(?:tion)?)?|ans(?:wer)?)(?![a-z])\s*[.:)\-]?\s*/i;
const PART = String.raw`(?:[a-h]|[ivx]{1,4})`;
// A label with no free text after it, e.g. "8 b ii", "11-b", "1.a.ii", "3c", "2.".
const SHORT = new RegExp(String.raw`^\s*(?:\d{1,3}[a-h]?)?(?:[\s.\-:]*${PART})*[\s.:)]*$`, "i");
// One bracketed or closed part at the start of the rest: "(a)", "( ii )", "b)", "iv." before a space.
const CLOSED_PART = new RegExp(String.raw`^[\s.\-:]*(?:\(\s*(${PART}|\d{1,2})\s*\)|(${PART})\s*[.)](?=\s|$|\())`, "i");

/**
 * Reads the label at the start of a student's answer heading, ignoring the
 * words after it: "1. (a) (i) Multiprogramming vs …" -> ["1", "a", "i"];
 * "(b) A real time system is …" -> bare ["b"]; "Ans 2" -> ["2"]. Top-level
 * numbers are digits, or one of the paper's own (e.g. roman) numbers.
 */
export function parseStudentLabel(label: string | null | undefined, topNumbers: string[] = []): StudentLabel | null {
  if (!label?.trim()) return null;
  const text = label.replace(PREFIX, "");
  const lowerTop = new Set(topNumbers.map((number) => number.toLowerCase()));

  if (SHORT.test(text)) {
    const tokens = (text.match(/[a-z0-9]+/gi) ?? []).flatMap((token) => {
      const joined = token.match(/^(\d{1,3})([a-h])$/i); // "3c", "1a"
      return joined ? [joined[1], joined[2]] : [token];
    });
    if (!tokens.length) return null;
    const bare = !/^\d/.test(tokens[0]) && !lowerTop.has(tokens[0].toLowerCase());
    return { path: tokens.map((token) => token.toLowerCase()), bare };
  }

  const path: string[] = [];
  let rest = text;
  const head = rest.match(/^\s*(\d{1,3})([a-h])?(?=[\s.():\-]|$)/i) ?? rest.match(new RegExp(String.raw`^\s*(${PART})(?=[\s.):\-]|$)`, "i"));
  let bare = true;
  if (head && (/^\d/.test(head[1]) || lowerTop.has(head[1].toLowerCase()))) {
    path.push(head[1].toLowerCase());
    if (head[2]) path.push(head[2].toLowerCase());
    rest = rest.slice(head[0].length);
    bare = false;
  }
  for (let part = rest.match(CLOSED_PART); part; part = rest.match(CLOSED_PART)) {
    path.push((part[1] ?? part[2]).toLowerCase());
    rest = rest.slice(part[0].length);
  }
  return path.length ? { path, bare } : null;
}

/** A code-side match for each answer block that has a usable label (null otherwise). */
export function proposeMatches(questions: LabelledQuestion[], blocks: LabelledBlock[]): Map<string, Proposal | null> {
  const leaves = questions.map((question) => ({
    id: question.id,
    path: [question.number, ...question.parts].map((segment) => segment.trim().toLowerCase()),
  }));
  const topNumbers = [...new Set(questions.map((question) => question.number))];
  const startsWith = (path: string[], prefix: string[]) => prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

  /**
   * Leaves this path names: itself, or everything under it. With `allowExtra`,
   * also the one leaf a longer label runs past (the student wrote "1(a)" for
   * question 1, which has no parts).
   */
  const resolve = (path: string[], allowExtra: boolean): { ids: string[]; source: "label" | "parent" } | null => {
    const exact = leaves.filter((leaf) => leaf.path.length === path.length && startsWith(leaf.path, path));
    if (exact.length) return { ids: exact.map((leaf) => leaf.id), source: "label" };
    const under = leaves.filter((leaf) => startsWith(leaf.path, path));
    if (under.length) return { ids: under.map((leaf) => leaf.id), source: under.length === 1 ? "label" : "parent" };
    if (!allowExtra) return null;
    const above = leaves.filter((leaf) => startsWith(path, leaf.path));
    return above.length === 1 ? { ids: [above[0].id], source: "label" } : null;
  };

  /** A bare sub-label read against the path before it: "ii" after 1(a)(i) is 1(a)(ii); "(b)" after 1(a)(ii) is 1(b). */
  const resolveBare = (tail: string[], context: string[] | null) => {
    if (!context || !tail.length) return null;
    for (let keep = context.length; keep >= 1; keep--) {
      const path = [...context.slice(0, keep), ...tail];
      const found = resolve(path, false);
      if (found) return { ...found, path };
    }
    return null;
  };

  const proposals = new Map<string, Proposal | null>();
  let context: string[] | null = null;
  let contextBlock: string | null = null;
  // Which block each bare label was read against, to pass on doubts about that block.
  const readAgainst = new Map<string, string>();
  // The label each directly labelled block wrote, e.g. "3.a".
  const labelledPath = new Map<string, string>();
  for (const block of blocks) {
    const label = parseStudentLabel(block.studentLabel, topNumbers);
    let found: { ids: string[]; source: Proposal["source"]; path: string[] } | null = null;
    const flags: string[] = [];
    if (label && !label.bare) {
      const direct = resolve(label.path, true);
      if (direct) found = { ...direct, path: label.path };
      else {
        // "2. (ii)" when the paper has 2(b)(ii): the number is right, a level is missing.
        const sameQuestion = context && context[0] === label.path[0] ? context : [label.path[0]];
        const inferred = resolveBare(label.path.slice(1), sameQuestion);
        if (inferred) found = { ...inferred, source: "inferred" };
        else flags.push(`the label "${block.studentLabel}" matches no question on the paper`);
      }
    } else if (label) {
      const inferred = resolveBare(label.path, context);
      if (inferred) found = { ...inferred, source: "inferred" };
    }

    if (found) {
      proposals.set(block.id, { questionIds: found.ids, source: found.source, flags });
      if (found.source !== "inferred") labelledPath.set(block.id, found.path.join("."));
      if (found.source === "inferred" && contextBlock) readAgainst.set(block.id, contextBlock);
      context = found.path;
      contextBlock = block.id;
    } else {
      proposals.set(block.id, flags.length ? { questionIds: [], source: "label", flags } : null);
    }
  }

  // Two blocks with the same written label: one of them may be mislabelled
  // (or the answer was continued later), so the model should look at both.
  const byLabel = new Map<string, string[]>();
  for (const [blockId, path] of labelledPath) byLabel.set(path, [...(byLabel.get(path) ?? []), blockId]);
  for (const blockIds of byLabel.values()) {
    if (blockIds.length < 2) continue;
    for (const blockId of blockIds) {
      const others = blockIds.filter((other) => other !== blockId).join(", ");
      proposals.get(blockId)!.flags.push(`${others} ${blockIds.length > 2 ? "have" : "has"} the same label`);
    }
  }

  // A bare "(b)" read against a doubtful label is doubtful too ("3(a)" written
  // over 3(b), then "(b)" over 3(c)). Blocks are in sheet order, so doubts
  // pass along a chain.
  for (const block of blocks) {
    const from = readAgainst.get(block.id);
    const proposal = proposals.get(block.id);
    if (from && proposal && proposals.get(from)?.flags.length) {
      proposal.flags.push(`its label was read against ${from}, whose label is in doubt`);
    }
  }
  return proposals;
}
