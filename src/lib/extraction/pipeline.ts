import {
  generateText,
  NoObjectGeneratedError,
  Output,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import { applyChoiceRules, formatLabel, parseLabel, type ChoiceRule } from "./choices";
import { boxFromFormat, unionBox, type BoxFormat } from "./geometry";
import type { ExtractionRequest, PageInput } from "./request-schema";
import type {
  Box,
  ExtractedAnswer,
  ExtractionEvent,
  ExtractionResult,
  GradedQuestion,
  GradingSummary,
  Region,
  ServerStage,
  TextLine,
  UnmatchedAnswer,
  Verdict,
} from "./types";

// Pipeline: read both documents into positioned lines, then
// question extraction → answer extraction → answer mapping → grading.
//
// The models never produce highlight coordinates themselves. Every line has an
// id ("p2-l14") and a box — from the PDF text layer, or from the vision model
// while transcribing a scan — and the text model refers to lines by id. The
// highlighted regions are built from those boxes.

export type PipelineDeps = {
  /** Used for extraction, mapping and grading. */
  textModel: LanguageModel;
  /**
   * Reads a scanned page or photo into positioned lines (vision LLM, HunyuanOCR
   * or both). Only called for pages without a text layer.
   */
  readPage: (image: Uint8Array) => Promise<TextLine[]>;
  loadPageImage: (path: string) => Promise<Uint8Array>;
  onProgress: (event: Extract<ExtractionEvent, { type: "progress" }>) => void;
  signal?: AbortSignal;
};

type Line = TextLine & { id: string; page: number; index: number };

type ExtractedQuestion = Omit<
  GradedQuestion,
  "maxMarks" | "marksEstimated" | "score" | "verdict" | "feedback" | "answer" | "counted"
> & { printedMarks: number | null };

type QuestionPaper = { questions: ExtractedQuestion[]; choices: ChoiceRule[] };

type AnswerSegment = ExtractedAnswer & { id: string };

// Small concurrency limit for per-page vision calls.
const PAGE_CONCURRENCY = 3;
const REGION_PADDING = 0.012;

export async function runExtraction(
  request: ExtractionRequest,
  deps: PipelineDeps,
): Promise<ExtractionResult> {
  const [questionLines, answerLines] = await Promise.all([
    readDocument("reading-question", request.question.pages, deps),
    readDocument("reading-answer", request.answer.pages, deps),
  ]);

  const [paper, segments] = await Promise.all([
    stage(deps, "questions", () => extractQuestions(questionLines, deps), (found) =>
      `${found.questions.length} found`,
    ),
    stage(deps, "answers", () => extractAnswers(answerLines, deps), (found) =>
      `${found.length} found`,
    ),
  ]);
  const { questions } = paper;

  const matches = await stage(deps, "mapping", () => mapAnswers(questions, segments, deps));

  // A block can answer several sub-parts at once (e.g. 1(a)(i) and (ii) written together).
  const answersByQuestion = new Map<string, AnswerSegment[]>();
  const unmatchedAnswers: UnmatchedAnswer[] = [];
  for (const segment of segments) {
    const questionIds = matches.get(segment.id) ?? [];
    for (const questionId of questionIds) {
      answersByQuestion.set(questionId, [...(answersByQuestion.get(questionId) ?? []), segment]);
    }
    if (questionIds.length === 0) unmatchedAnswers.push(segment);
  }

  const { questions: graded, summary } = await stage(deps, "grading", () =>
    gradeAnswers(paper, answersByQuestion, deps),
  );

  return { questions: graded, unmatchedAnswers, summary };
}

// ---------------------------------------------------------------------------
// Reading

async function readDocument(
  stageName: Extract<ServerStage, "reading-question" | "reading-answer">,
  pages: PageInput[],
  deps: PipelineDeps,
): Promise<Line[]> {
  let done = 0;
  const report = () =>
    deps.onProgress({ type: "progress", stage: stageName, status: "active", detail: `Page ${done} of ${pages.length}` });
  report();

  const perPage = await mapWithLimit(pages, PAGE_CONCURRENCY, async (page) => {
    const hasTextLayer = page.lines?.some((line) => line.text.trim());
    const lines = hasTextLayer
      ? page.lines!
      : await deps.readPage(await deps.loadPageImage(page.path));
    done++;
    report();
    return lines;
  });

  deps.onProgress({ type: "progress", stage: stageName, status: "done" });

  const lines: Line[] = [];
  perPage.forEach((pageLines, page) => {
    pageLines
      .filter((line) => line.text.trim())
      .forEach((line, index) => {
        lines.push({
          id: `p${page + 1}-l${index + 1}`,
          page,
          index: lines.length,
          text: line.text.trim(),
          box: line.box,
        });
      });
  });
  return lines;
}

// How each box format is described to the model.
export const BOX_WORDING: Record<BoxFormat, { field: string; description: string }> = {
  yxyx1000: { field: "box_2d", description: "[ymin, xmin, ymax, xmax], normalised to 0-1000" },
  xyxy1000: { field: "bbox_2d", description: "[x1, y1, x2, y2] (top-left, bottom-right), normalised to 0-1000" },
  xyxy999: { field: "box", description: "[x1, y1, x2, y2] (top-left, bottom-right), normalised to integers 0-999" },
};

function transcribeInstructions(format: BoxFormat) {
  const { field, description } = BOX_WORDING[format];
  return `You are an OCR engine for school exam documents (printed question papers and handwritten answer sheets).
Transcribe every line of writing on the page image, in reading order: top to bottom, and the left column before the right column.
For each line return:
- "text": the line exactly as written, including question labels such as "Q2.", "11 (b)" or "Ans 3". Keep the student's spelling. Write illegible words as [illegible]. Skip words that are struck through.
- "${field}": the line's bounding box as ${description}, relative to the whole image. The box must tightly enclose the ink of that line.
Return one entry per physical line; never merge lines.
For a drawing, diagram, graph or table, return a single entry whose box covers the whole drawing and whose text is "[diagram: short description, including its labels]".
Ignore ruled lines, margins, page numbers, headers, footers and watermarks.`;
}

function transcriptionSchema(format: BoxFormat) {
  const { field, description } = BOX_WORDING[format];
  return z.object({
    lines: z.array(
      z.object({ text: z.string(), [field]: z.array(z.number()).describe(description) }),
    ),
  });
}

export type TranscribeOptions = {
  model: LanguageModel;
  signal?: AbortSignal;
  /** The box convention to ask for; match the model's training. Default "yxyx1000". */
  boxFormat?: BoxFormat;
};

/** Reads one page image with a vision model into positioned lines. */
export async function transcribePage(image: Uint8Array, options: TranscribeOptions): Promise<TextLine[]> {
  const format = options.boxFormat ?? "yxyx1000";
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe this page." },
        {
          type: "file",
          data: image,
          mediaType: "image/jpeg",
          providerOptions: { deepseek: { imageDetail: "high" } },
        },
      ],
    },
  ];
  const output = (await ask(options, options.model, transcriptionSchema(format), transcribeInstructions(format), {
    messages,
  })) as { lines: Record<string, unknown>[] };
  const field = BOX_WORDING[format].field;
  return output.lines.flatMap((line) => {
    const text = typeof line.text === "string" ? line.text.trim() : "";
    const values = line[field];
    const box = Array.isArray(values) ? boxFromFormat(values.map(Number), format) : null;
    return text && box ? [{ text, box }] : [];
  });
}

// Scanned pages read by a structure-aware reader (AI_OCR_ENGINE=nemotron-v1,
// paddle-llm, …) include one line per table and per drawing.
const REGION_NOTE = `Some lines stand for a region of the page rather than a line of writing: "[diagram: …]" is a drawing described in words, with its labels, and "[table: …]" is a table whose rows are separated by " / " and cells by " | ".`;

// ---------------------------------------------------------------------------
// Question extraction

const QUESTION_INSTRUCTIONS = `You extract the gradeable questions from an exam question paper.
The paper is given as lines, each prefixed with its id, e.g. "[p1-l4] 3. (a) Define osmosis. [2]".
${REGION_NOTE} A table or drawing printed in a question is part of that question's text, or of the context of its sub-parts.

Questions are often nested: a numbered question has lettered parts, and a part can have its own sub-parts, e.g.
  1. (a) Distinguish between the following:
         i. Multiprogramming and Multiprocessing.
         ii. Network system and Distributed system.
     (b) What is a real time system?
Return one entry per leaf: the smallest labelled item a student answers, in printed order. For the example: 1(a)(i), 1(a)(ii), 1(b).
A parent that has labelled sub-parts is NEVER an entry of its own; its wording (here "Distinguish between the following:") goes into the "context" of each of its sub-parts.
Labelled items listed inline in a sentence ("... for i) FIFO and ii) LRU") are sub-parts too.

For each entry:
- "number": the top-level question number as printed, without decoration: "Q3." -> "3", "IV." -> "IV". Never renumber, even if the paper skips numbers.
- "parts": the sub-part labels from outermost to innermost, without brackets or dots: ["a", "i"] for 1(a)(i), ["b"] for 1(b), [] for a question without sub-parts.
- "text": the wording of this leaf only, including the options of a multiple-choice question and any "OR" alternative.
- "context": the wording of every parent it depends on (stems, scenarios, data tables), outermost first, without their labels; null if none.
- "maxMarks": the marks for this leaf. Marks may be printed per item ("[2]", "(3 marks)", "2M"), or as one formula after the whole question that lists the marks of its parts in order, with brackets grouping the marks of one part. For the example above, "(2 + 2) + 2 + 2 + (2 + 4)" means 1(a)(i)=2, 1(a)(ii)=2, 1(b)=2, 1(c)=2, 1(d)=6. "(2 × 3)" is 6 in total. If marks are printed only for a parent, split them evenly across its sub-parts; but if only some sub-parts must be answered ("any two"), each sub-part gets the marks of one answered item ("any two" with "(2 × 4)" gives each item 4). Use null if no marks are printed at all.

Also return "choices": every rule that lets the student answer only some items.
- "within": null for a rule about the paper's main questions ("Answer any five questions"), or the label of the parent whose sub-parts it applies to, e.g. "8(b)" for "(b) Write short notes on the following (any two)".
- "answerAny": how many must be answered.
Use an empty list when every question is compulsory.

Do not return general instructions, headings, the paper title, full marks, time allowed, or answer spaces as questions.`;

const questionSchema = z.object({
  questions: z.array(
    z.object({
      number: z.string(),
      parts: z.array(z.string()),
      text: z.string(),
      context: z.string().nullable(),
      maxMarks: z.number().nullable(),
    }),
  ),
  choices: z.array(z.object({ within: z.string().nullable(), answerAny: z.number() })),
});

function cleanNumber(value: string) {
  return value.trim().replace(/^(?:q(?:uestion)?|ques)\.?\s*/i, "").replace(/[.):\s]+$/, "").trim();
}

/** "(a)" -> "a", "ii." -> "ii", "b)" -> "b". */
function cleanSegment(value: string) {
  return value.replace(/[()[\]\s.:]/g, "");
}

/**
 * [number, ...parts]. Some models pack the whole label into "number"
 * ("1.(a).i", "1(a)") instead of using "parts", so the number is parsed too.
 */
function questionPath(rawNumber: string, rawParts: string[], index: number): string[] {
  const parts = rawParts.map(cleanSegment).filter(Boolean);
  const numberPath = parseLabel(rawNumber) ?? [cleanNumber(rawNumber) || String(index + 1)];
  const [number, ...packed] = numberPath;
  // "1(a)" with parts ["a", "i"] repeats "a": keep the parts as given.
  const repeated = packed.every((segment, i) => parts[i]?.toLowerCase() === segment.toLowerCase());
  return [number, ...(repeated ? parts : [...packed, ...parts])];
}

const pathKey = (path: string[]) => path.map((segment) => segment.toLowerCase()).join("\u0000");
const isAncestor = (parent: string[], child: string[]) =>
  parent.length < child.length && pathKey(child.slice(0, parent.length)) === pathKey(parent);

async function extractQuestions(lines: Line[], deps: PipelineDeps): Promise<QuestionPaper> {
  if (lines.length === 0) throw new UserFacingError("No text could be read from the question paper.");

  const output = await ask(deps, deps.textModel, questionSchema, QUESTION_INSTRUCTIONS, {
    prompt: formatLines(lines),
  });

  let entries = output.questions
    .filter((question) => question.text.trim())
    .map((question, index) => ({
      path: questionPath(question.number, question.parts, index),
      text: question.text.trim(),
      context: question.context?.trim() || null,
      printedMarks: question.maxMarks !== null && question.maxMarks > 0 ? question.maxMarks : null,
    }));

  // Safety net for nested questions: an entry that is the parent of other
  // entries (e.g. "1(a) Distinguish between the following:") is a stem, not
  // a question. Drop it and keep its wording as context for its sub-parts.
  const stems = entries.filter((entry) => entries.some((other) => isAncestor(entry.path, other.path)));
  entries = entries
    .filter((entry) => !stems.includes(entry))
    .map((entry) => {
      const missing = stems
        .filter((stem) => isAncestor(stem.path, entry.path))
        .map((stem) => stem.text)
        .filter((text) => !entry.context?.includes(text));
      return missing.length
        ? { ...entry, context: [...missing, entry.context].filter(Boolean).join("\n") }
        : entry;
    });

  if (entries.length === 0) {
    throw new UserFacingError("No questions were found in the question paper.");
  }

  const questions: ExtractedQuestion[] = entries.map((entry, index) => ({
    id: `q${index + 1}`,
    number: entry.path[0],
    parts: entry.path.slice(1),
    label: formatLabel(entry.path),
    text: entry.text,
    context: entry.context,
    printedMarks: entry.printedMarks,
  }));

  const choices: ChoiceRule[] = output.choices
    .filter((choice) => Number.isInteger(choice.answerAny) && choice.answerAny > 0)
    .map((choice) => ({ within: parseLabel(choice.within) ?? [], select: choice.answerAny }));

  return { questions, choices };
}

// ---------------------------------------------------------------------------
// Answer extraction

const ANSWER_INSTRUCTIONS = `You split a student's answer sheet into answer blocks.
The sheet is given as lines, each prefixed with its id, e.g. "[p2-l7] Q4. The heart has four chambers".
${REGION_NOTE}
An answer block is the contiguous run of lines where the student answers one question or one sub-part. Blocks may continue across pages.
Return the blocks in the order they appear on the sheet, as:
- "studentLabel": the label the student wrote for the block, exactly as written ("Q2", "2.", "Ans 11 b", "(iii)"), or null if there is none.
- "firstLineId" and "lastLineId": ids of the first and last line of the block (inclusive). Include the diagram and table lines that belong to the answer.
If the student labels separate sub-parts (e.g. "11 a" and "11 b", or "i." and "ii." under "1 (a)"), return each as its own block, and include the parent's label in "studentLabel" when it's written just above ("1 (a) i").
Students may answer questions in any order; keep the order of the sheet.
Leave out lines that are not answers: name, roll number, date, class, page headers and rough work marked as such.`;

const answerSchema = z.object({
  answers: z.array(
    z.object({
      studentLabel: z.string().nullable(),
      firstLineId: z.string(),
      lastLineId: z.string(),
    }),
  ),
});

async function extractAnswers(lines: Line[], deps: PipelineDeps): Promise<AnswerSegment[]> {
  if (lines.length === 0) return [];

  const output = await ask(deps, deps.textModel, answerSchema, ANSWER_INSTRUCTIONS, {
    prompt: formatLines(lines),
  });

  const indexById = new Map(lines.map((line) => [line.id, line.index]));
  const segments: AnswerSegment[] = [];
  for (const answer of output.answers) {
    const first = indexById.get(answer.firstLineId.trim());
    const last = indexById.get(answer.lastLineId.trim());
    if (first === undefined && last === undefined) continue;
    const start = Math.min(first ?? last!, last ?? first!);
    const end = Math.max(first ?? last!, last ?? first!);
    const blockLines = lines.slice(start, end + 1);
    segments.push({
      id: `a${segments.length + 1}`,
      studentLabel: answer.studentLabel?.trim() || null,
      text: blockLines.map((line) => line.text).join("\n"),
      regions: regionsFor(blockLines),
    });
  }
  return segments;
}

/** One rectangle per page covering a block's lines, so answers can span pages. */
function regionsFor(lines: Line[]): Region[] {
  const byPage = new Map<number, Box[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) ?? []), line.box]);
  return [...byPage].map(([page, boxes]) => ({ page, box: unionBox(boxes, REGION_PADDING) }));
}

// ---------------------------------------------------------------------------
// Mapping

const MAPPING_INSTRUCTIONS = `You match a student's answer blocks to the questions of an exam.
Questions are labelled with their full path, e.g. "1(a)(ii)" is sub-part ii of part a of question 1.
Match each answer block to the question(s) it answers:
1. First use the label the student wrote. Treat "Q2", "2.", "Ans 2" and "2)" as question 2; "11 b", "11(b)", "11-b" and "11.b" as 11(b); "1 a ii", "1.a.ii" and "1(a)(ii)" as 1(a)(ii). A bare label such as "(b)" or "ii." belongs to the question being answered around it on the sheet.
2. If there is no usable label, or the label contradicts the content, use the content of the answer.
3. If one block answers several sub-parts together (e.g. the student labelled it "1(a)" and answered both 1(a)(i) and 1(a)(ii) in it), list all of them.
Students may answer in any order. Several blocks can belong to the same question (for example an answer continued later on).
Use an empty list for a block that does not answer any of the listed questions. Do not force a match.
Return one entry per answer block.`;

const mappingSchema = z.object({
  matches: z.array(z.object({ answerId: z.string(), questionIds: z.array(z.string()) })),
});

async function mapAnswers(
  questions: ExtractedQuestion[],
  segments: AnswerSegment[],
  deps: PipelineDeps,
): Promise<Map<string, string[]>> {
  const matches = new Map<string, string[]>();
  if (segments.length === 0) return matches;

  const prompt = [
    "QUESTIONS (id | label | text):",
    ...questions.map(
      (q) =>
        `${q.id} | ${q.label} | ${q.context ? `${truncate(oneLine(q.context), 150)} → ` : ""}${truncate(oneLine(q.text), 300)}`,
    ),
    "",
    "ANSWER BLOCKS (id | student's label | text):",
    ...segments.map(
      (a) => `${a.id} | ${a.studentLabel ?? "none"} | ${truncate(oneLine(a.text), 600)}`,
    ),
  ].join("\n");

  const output = await ask(deps, deps.textModel, mappingSchema, MAPPING_INSTRUCTIONS, { prompt });

  const questionIds = new Set(questions.map((question) => question.id));
  const answerIds = new Set(segments.map((segment) => segment.id));
  for (const match of output.matches) {
    const answerId = match.answerId.trim();
    if (!answerIds.has(answerId) || matches.has(answerId)) continue;
    const ids = [...new Set(match.questionIds.map((id) => id.trim()))].filter((id) => questionIds.has(id));
    matches.set(answerId, ids);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Grading

const GRADING_INSTRUCTIONS = `You are an experienced teacher grading a student's exam.
There is no answer key: judge each answer using correct subject knowledge for the level of the paper.
Answers were read from the student's sheet. ${REGION_NOTE} A correct table or drawing is part of the answer and earns credit like written text.
For every question return:
- "maxMarks": the printed marks when given; otherwise choose a fair maximum for that kind of question (usually 1-5, at most 10).
- "score": the marks earned, between 0 and maxMarks, in steps of 0.5. Award partial credit for partially correct answers. An answer marked NO ANSWER scores 0. When several sub-parts share the same answer text (the student answered them together), grade only the portion relevant to each sub-part.
- "feedback": 1-3 sentences addressed to the student: what was right, what was missing or wrong, and how to improve. For NO ANSWER, briefly state what a good answer should contain.
Then give overall feedback: a short paragraph on the whole paper, plus up to 3 strengths and up to 3 things to improve.`;

const gradingSchema = z.object({
  grades: z.array(
    z.object({
      questionId: z.string(),
      maxMarks: z.number(),
      score: z.number(),
      feedback: z.string(),
    }),
  ),
  overall: z.object({
    feedback: z.string(),
    strengths: z.array(z.string()),
    improvements: z.array(z.string()),
  }),
});

async function gradeAnswers(
  { questions, choices }: QuestionPaper,
  answersByQuestion: Map<string, AnswerSegment[]>,
  deps: PipelineDeps,
): Promise<{ questions: GradedQuestion[]; summary: GradingSummary }> {
  const answers = new Map(
    questions.map((question) => [question.id, mergeAnswers(answersByQuestion.get(question.id))]),
  );

  const prompt = questions
    .map((question) => {
      const answer = answers.get(question.id);
      return [
        `### ${question.id} — Question ${question.label}`,
        `Marks: ${question.printedMarks ?? "not printed"}`,
        question.context ? `Context: ${question.context}` : null,
        `Question: ${question.text}`,
        // Answers with tables run long (two comparison tables are ~2,000 characters).
        `Student's answer: ${answer ? truncate(answer.text, 5000) : "NO ANSWER"}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const output = await ask(deps, deps.textModel, gradingSchema, GRADING_INSTRUCTIONS, { prompt });
  const grades = new Map(output.grades.map((grade) => [grade.questionId.trim(), grade]));

  const scored = questions.map(({ printedMarks, ...question }) => {
    const grade = grades.get(question.id);
    const answer = answers.get(question.id) ?? null;
    const maxMarks = printedMarks ?? clamp(Math.round(grade?.maxMarks ?? 1), 1, 10);
    const score = answer && grade ? clamp(Math.round(grade.score * 2) / 2, 0, maxMarks) : 0;
    const verdict: Verdict = !answer
      ? "unanswered"
      : score >= maxMarks
        ? "correct"
        : score <= 0
          ? "incorrect"
          : "partial";
    return {
      ...question,
      maxMarks,
      marksEstimated: printedMarks === null,
      score,
      verdict,
      feedback:
        grade?.feedback.trim() || "This answer could not be graded automatically. Please review it.",
      answer,
    };
  });

  // "Answer any N" rules decide which questions count towards the total.
  const { counted, score, maxScore, notes } = applyChoiceRules(
    scored.map((question) => ({
      id: question.id,
      path: [question.number, ...question.parts],
      score: question.score,
      maxMarks: question.maxMarks,
      answered: question.answer !== null,
    })),
    choices,
  );
  const graded: GradedQuestion[] = scored.map((question) => ({
    ...question,
    counted: counted.has(question.id),
  }));

  const counts: Record<Verdict, number> = { correct: 0, partial: 0, incorrect: 0, unanswered: 0 };
  for (const question of graded) if (question.counted) counts[question.verdict]++;

  return {
    questions: graded,
    summary: {
      score,
      maxScore,
      percentage: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
      counts,
      notCounted: graded.filter((question) => !question.counted).length,
      notes,
      overallFeedback: output.overall.feedback.trim(),
      strengths: output.overall.strengths.map((item) => item.trim()).filter(Boolean).slice(0, 3),
      improvements: output.overall.improvements.map((item) => item.trim()).filter(Boolean).slice(0, 3),
    },
  };
}

function mergeAnswers(segments: AnswerSegment[] | undefined): ExtractedAnswer | null {
  if (!segments?.length) return null;
  return {
    text: segments.map((segment) => segment.text).join("\n\n"),
    studentLabel: segments.find((segment) => segment.studentLabel)?.studentLabel ?? null,
    regions: segments.flatMap((segment) => segment.regions),
  };
}

// ---------------------------------------------------------------------------
// Helpers

/** Errors whose message is safe and useful to show to the teacher. */
export class UserFacingError extends Error {}

async function stage<T>(
  deps: PipelineDeps,
  name: ServerStage,
  run: () => Promise<T>,
  detail?: (result: T) => string,
): Promise<T> {
  deps.onProgress({ type: "progress", stage: name, status: "active" });
  const result = await run();
  deps.onProgress({ type: "progress", stage: name, status: "done", detail: detail?.(result) });
  return result;
}

/**
 * Models without enforced JSON schemas (DeepSeek, …) occasionally return
 * almost-valid JSON: a missing closing bracket, a trailing comma, a code
 * fence. Repairing it saves a whole retry (minutes for a long grading call).
 * The repaired object must still match the schema.
 */
export function repairStructuredOutput<T>(text: string | undefined, schema: z.ZodType<T>): T | null {
  if (!text?.trim()) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(jsonrepair(text)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Structured call; broken JSON is repaired, and one retry covers a reply that can't be. */
async function ask<T>(
  deps: Pick<PipelineDeps, "signal">,
  model: LanguageModel,
  schema: z.ZodType<T>,
  instructions: string,
  input: { prompt: string } | { messages: ModelMessage[] },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { output } = await generateText({
        model,
        instructions,
        ...input,
        output: Output.object({ schema }),
        abortSignal: deps.signal,
      });
      return output as T;
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      const repaired = repairStructuredOutput(error.text, schema);
      if (repaired !== null) {
        const modelId = typeof model === "string" ? model : model.modelId;
        const reason = error.cause instanceof Error ? /Error message: (.*)/.exec(error.cause.message)?.[1] : undefined;
        console.warn(`Repaired malformed JSON from ${modelId}${reason ? ` (${reason.slice(0, 100)})` : ""}.`);
        return repaired;
      }
      if (attempt >= 2) throw error;
    }
  }
}

function formatLines(lines: Line[]) {
  const out: string[] = [];
  let page = -1;
  for (const line of lines) {
    if (line.page !== page) {
      page = line.page;
      out.push(`--- Page ${page + 1} ---`);
    }
    out.push(`[${line.id}] ${line.text}`);
  }
  return out.join("\n");
}

async function mapWithLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
