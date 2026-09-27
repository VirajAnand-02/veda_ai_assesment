import { ChevronDown, ChevronUp, ScanSearch } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "@/lib/cn";
import type { GradedQuestion } from "@/lib/extraction/types";
import { VERDICT_LABELS, VERDICT_PILL } from "./verdict-styles";

type QuestionCardProps = {
  question: GradedQuestion;
  selected: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** Phone only: jump to the answer sheet tab. */
  onViewAnswer: () => void;
};

const formatMarks = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

export function QuestionCard({
  question,
  selected,
  expanded,
  onSelect,
  onToggle,
  onViewAnswer,
}: QuestionCardProps) {
  const detailsId = `question-${question.id}-details`;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  const stop = (handler: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };

  return (
    // Clicking anywhere on the card selects it; the question text is the
    // keyboard-accessible button for the same action.
    <article
      onClick={onSelect}
      className={cn(
        "group/card flex cursor-pointer flex-col gap-3 rounded-2xl bg-white p-3 transition-[box-shadow,translate] duration-200",
        "hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]",
        selected && "ring-2 ring-primary-soft ring-inset",
      )}
    >
      {/* Phone: number and score on the first row, question text below.
          Desktop: everything on a single row. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 lg:flex-nowrap">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full border-2 border-white/25 px-1.5 text-[20px] font-extrabold tracking-[-0.8px] text-white transition-[background-color,scale] duration-200 group-hover/card:scale-105",
              selected
                ? "bg-primary shadow-[0_8px_4.4px_rgba(255,121,80,0.1)]"
                : "bg-ink-strong/80 shadow-[0_8px_8.8px_rgba(134,134,134,0.1),0_4px_16px_rgba(67,67,67,0.1)]",
            )}
          >
            {question.number}
          </span>
          {question.parts.length > 0 && (
            <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-off-white px-2 text-[16px] font-bold tracking-[-0.64px] whitespace-nowrap text-ink">
              {/* "a." as in the design; nested parts read "a(i)". */}
              {question.parts[0]}
              {question.parts.slice(1).map((part) => `(${part})`).join("")}
              {question.parts.length === 1 && "."}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={stop(onSelect)}
          aria-pressed={selected}
          aria-label={`Show answer to question ${question.label}: ${question.text}`}
          className="order-3 flex w-full flex-col gap-0.5 text-left lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
        >
          {/* A sub-part's own wording is often meaningless alone ("Network system
              and Distributed system."), so its parent's wording leads in. */}
          {question.context && (
            <span
              className={cn(
                "text-[12px] leading-[1.4] tracking-[-0.48px] whitespace-pre-line text-muted/80 lg:text-[14px] lg:tracking-[-0.56px]",
                !expanded && "line-clamp-2",
              )}
            >
              {question.context}
            </span>
          )}
          <span className="text-[14px] leading-[1.4] tracking-[-0.56px] text-ink lg:text-[16px] lg:tracking-[-0.64px]">
            {question.text}
          </span>
        </button>

        <div className="order-2 ml-auto flex items-center gap-4 lg:order-none">
          <span
            title={question.counted ? VERDICT_LABELS[question.verdict] : "Optional question, not counted in the total"}
            className={cn(
              "rounded-full px-3 py-1 text-[16px] leading-[1.4] font-bold tracking-[-0.64px] whitespace-nowrap",
              question.counted ? VERDICT_PILL[question.verdict] : "bg-off-white text-disabled",
            )}
          >
            {!question.counted && !question.answer
              ? "Skipped"
              : `${formatMarks(question.score)} / ${formatMarks(question.maxMarks)}`}
          </span>
          <button
            type="button"
            onClick={stop(onToggle)}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? "Collapse" : "Expand"} question ${question.label}`}
            className="flex items-center rounded-lg bg-off-white p-1 text-ink hover:bg-line/60 active:scale-90"
          >
            <Chevron size={24} aria-hidden />
          </button>
        </div>
      </div>

      {expanded && (
        <div
          id={detailsId}
          className="flex cursor-default flex-col gap-2.5 rounded-2xl bg-off-white p-4 text-ink lg:px-6"
          onClick={(event) => event.stopPropagation()}
        >
          {!question.counted && (
            <p className="rounded-xl bg-white px-3 py-2 text-[13px] leading-[1.4] tracking-[-0.52px] text-muted">
              {question.answer
                ? "Not counted: the paper lets the student choose, and their better answers to other questions were counted instead."
                : "Optional: the paper lets the student choose which questions to answer, so skipping this one doesn’t cost marks."}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[16px] leading-[1.4] font-bold tracking-[-0.64px]">AI Feedback</p>
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[12px] leading-[1.4] font-bold tracking-[-0.48px] whitespace-nowrap",
                VERDICT_PILL[question.verdict],
              )}
            >
              {VERDICT_LABELS[question.verdict]}
            </span>
          </div>
          <p className="text-[14px] leading-[1.4] tracking-[-0.56px]">{question.feedback}</p>

          <div className="mt-1 flex flex-col gap-1 border-t border-black/5 pt-3">
            <p className="text-[12px] leading-[1.4] font-bold tracking-[-0.48px] text-muted uppercase">
              Extracted answer
              {question.answer?.studentLabel && (
                <span className="font-normal normal-case"> · labelled “{question.answer.studentLabel}”</span>
              )}
            </p>
            <p className="line-clamp-6 text-[14px] leading-[1.4] tracking-[-0.56px] whitespace-pre-line text-muted">
              {question.answer?.text ?? "No answer to this question was found on the answer sheet."}
            </p>
          </div>

          {question.marksEstimated && (
            <p className="text-[12px] leading-[1.4] tracking-[-0.48px] text-muted/80">
              No marks are printed for this question, so the maximum was estimated.
            </p>
          )}

          {question.answer && (
            <button
              type="button"
              onClick={onViewAnswer}
              className="flex items-center gap-2 self-start rounded-full bg-ink px-4 py-2 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] text-white hover:bg-ink-strong active:scale-95 lg:hidden"
            >
              <ScanSearch size={16} aria-hidden />
              View on answer sheet
            </button>
          )}
        </div>
      )}
    </article>
  );
}
