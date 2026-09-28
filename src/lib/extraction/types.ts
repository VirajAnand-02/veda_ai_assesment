// Types shared by the extraction API route and the UI.

/** A rectangle as fractions (0–1) of the page width and height. */
export type Box = { x: number; y: number; w: number; h: number };

/** A line of text on a page with its position. */
export type TextLine = { text: string; box: Box };

/** A rectangle on one page of the answer sheet (0-based page index). */
export type Region = { page: number; box: Box };

export type Verdict = "correct" | "partial" | "incorrect" | "unanswered";

export type ExtractedAnswer = {
  text: string;
  /** How the student labelled the answer, e.g. "Q2" or "11 b", if they did. */
  studentLabel: string | null;
  /** One or more rectangles, possibly on different pages. */
  regions: Region[];
};

export type GradedQuestion = {
  id: string;
  /** Printed question number, kept as printed (e.g. "11", "IV"). */
  number: string;
  /** Sub-part labels from outermost to innermost: ["a", "i"] for 1(a)(i); [] if none. */
  parts: string[];
  /** Display label such as "1(a)(i)". */
  label: string;
  text: string;
  /** Wording of the parent parts this depends on, e.g. "Distinguish between the following:". */
  context: string | null;
  /**
   * False when a choice rule ("answer any five") leaves this question out of
   * the total, e.g. an unattempted optional question.
   */
  counted: boolean;
  maxMarks: number;
  /** True when the paper doesn't print marks and they were estimated. */
  marksEstimated: boolean;
  score: number;
  verdict: Verdict;
  feedback: string;
  /** Null when no answer on the sheet was matched to this question. */
  answer: ExtractedAnswer | null;
};

/** An answer block on the sheet that doesn't answer any extracted question. */
export type UnmatchedAnswer = ExtractedAnswer & { id: string };

export type GradingSummary = {
  /** Totals over counted questions only. */
  score: number;
  maxScore: number;
  percentage: number;
  counts: Record<Verdict, number>;
  /** Questions left out of the total by choice rules. */
  notCounted: number;
  /** How choice rules were applied, in plain words. */
  notes: string[];
  overallFeedback: string;
  strengths: string[];
  improvements: string[];
};

export type ExtractionResult = {
  questions: GradedQuestion[];
  unmatchedAnswers: UnmatchedAnswer[];
  summary: GradingSummary;
};

export type ServerStage =
  | "reading-question"
  | "reading-answer"
  | "questions"
  | "answers"
  | "mapping"
  | "grading";

export type ExtractionEvent =
  | { type: "progress"; stage: ServerStage; status: "active" | "done"; detail?: string }
  | { type: "result"; result: ExtractionResult }
  | { type: "error"; message: string };

export type ProgressEvent = Extract<ExtractionEvent, { type: "progress" }>;

/**
 * An extraction, as polled by the page (GET /api/extract/<id>). It runs in
 * steps that each fit a request's time limit; between steps it is "waiting"
 * for the page to start step `step` (POST /api/extract/<id>).
 */
export type ExtractionJob = {
  id: string;
  status: "running" | "waiting" | "done" | "error";
  /** The step running, or the next one to start when waiting (from 0). */
  step: number;
  /** Progress so far, in order; the page replays the ones it hasn't seen. */
  events: ProgressEvent[];
  result?: ExtractionResult;
  /** Set when status is "error"; meant for the teacher. */
  error?: string;
  /** When the job was last written (ms); a running job refreshes it at least every ~20 s. */
  updatedAt: number;
};
