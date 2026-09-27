"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import type { ExtractionResult } from "@/lib/extraction/types";
import { AnswerSheetViewer, type Highlight, type SheetPage } from "./answer-sheet-viewer";
import { GradingSummary } from "./grading-summary";
import { QuestionCard } from "./question-card";
import { UnmatchedAnswerCard } from "./unmatched-answer-card";

type Tab = "questions" | "answer";

const TABS: { id: Tab; label: string }[] = [
  { id: "questions", label: "Questions" },
  { id: "answer", label: "Answer Sheet" },
];

type Selection = { kind: "question" | "unmatched"; id: string } | null;

// Desktop split between the questions panel and the answer sheet: the
// questions panel's share of the width. A sheet with several pages starts
// with more room, so its pages are easier to read.
const SPLIT_MIN = 0.28;
const SPLIT_MAX = 0.72;
const SPLIT_STEP = 0.02;
const MANY_PAGES = 3;
const defaultSplit = (pageCount: number) => (pageCount >= MANY_PAGES ? 0.4 : 0.5);
const clampSplit = (value: number) => Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, value));

// Phone-only switch between the two panels, which sit side by side on desktop.
function PanelTabs({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <div role="tablist" className="flex items-center rounded-full bg-off-white p-1 lg:hidden">
      {TABS.map(({ id, label }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              "flex flex-1 items-center justify-center rounded-full px-4 py-3 text-[16px] leading-[1.4] font-medium tracking-[-0.64px]",
              active
                ? "border border-[#7b7b7b] bg-ink px-6 text-white shadow-[0_4px_4px_rgba(0,0,0,0.25),0_32px_48px_rgba(0,0,0,0.2)]"
                : "text-muted/80 hover:bg-white/70 hover:text-ink active:scale-[0.98]",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

type MappingStepProps = {
  result: ExtractionResult;
  pages: SheetPage[];
};

export function MappingStep({ result, pages }: MappingStepProps) {
  const { questions, unmatchedAnswers, summary } = result;
  const [tab, setTab] = useState<Tab>("questions");

  // Start on the first answered question so the sheet shows a highlight.
  const initial = questions.find((question) => question.answer) ?? questions[0];
  const [selection, setSelection] = useState<Selection>(
    initial ? { kind: "question", id: initial.id } : null,
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(initial ? [initial.id] : []),
  );
  const allExpanded = expanded.size === questions.length;

  const [split, setSplit] = useState(() => defaultSplit(pages.length));
  const [resizing, setResizing] = useState(false);
  const panelsRef = useRef<HTMLDivElement>(null);

  function splitAt(clientX: number) {
    const rect = panelsRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) setSplit(clampSplit((clientX - rect.left) / rect.width));
  }

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  }

  function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === "ArrowLeft" ? split - SPLIT_STEP
      : event.key === "ArrowRight" ? split + SPLIT_STEP
      : event.key === "Home" ? SPLIT_MIN
      : event.key === "End" ? SPLIT_MAX
      : event.key === "Enter" ? defaultSplit(pages.length)
      : null;
    if (next === null) return;
    event.preventDefault();
    setSplit(clampSplit(next));
  }

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function selectQuestion(id: string) {
    setSelection({ kind: "question", id });
    setExpanded((current) => new Set(current).add(id));
  }

  const selectedQuestion =
    selection?.kind === "question" ? questions.find((question) => question.id === selection.id) : undefined;
  const selectedUnmatched =
    selection?.kind === "unmatched"
      ? unmatchedAnswers.find((answer) => answer.id === selection.id)
      : undefined;

  let highlight: Highlight | null = null;
  let notice: string | null = null;
  if (selectedQuestion?.answer) {
    highlight = {
      key: selectedQuestion.id,
      label: `Q${selectedQuestion.label}`,
      tone: selectedQuestion.verdict,
      regions: selectedQuestion.answer.regions,
    };
  } else if (selectedQuestion) {
    notice = `No answer found for Q${selectedQuestion.label}`;
  } else if (selectedUnmatched) {
    highlight = {
      key: selectedUnmatched.id,
      label: "Unmatched",
      tone: "unmatched",
      regions: selectedUnmatched.regions,
    };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 lg:gap-0">
      <PanelTabs tab={tab} onChange={setTab} />
      <div
        ref={panelsRef}
        style={{ "--split": `${split * 100}%` } as CSSProperties}
        className={cn("flex min-h-0 flex-1 flex-col gap-3 lg:flex-row", resizing && "cursor-col-resize select-none")}
      >
        <section
          aria-label="Extracted questions"
          className={cn(
            "flex min-h-0 flex-col gap-3 overflow-hidden rounded-[20px] bg-white/50 px-2 pt-4 pb-2 lg:w-[var(--split)] lg:shrink-0 lg:gap-4 lg:p-4",
            tab !== "questions" && "hidden lg:flex",
          )}
        >
          <div className="flex items-center justify-center gap-3 lg:justify-between">
            {/* Truncates when the panel is dragged narrow; the full title is in `title`. */}
            <h2
              title="Extracted Questions (from question paper)"
              className="min-w-0 truncate text-[16px] leading-[1.4] font-bold tracking-[-0.64px] whitespace-nowrap text-ink"
            >
              Extracted Questions (from question paper)
            </h2>
            <button
              type="button"
              onClick={() =>
                setExpanded(allExpanded ? new Set() : new Set(questions.map((question) => question.id)))
              }
              className="hidden shrink-0 rounded-full bg-white py-3 pr-5 pl-4 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] whitespace-nowrap text-[#181818] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)] active:translate-y-0 active:scale-[0.98] lg:block"
            >
              {allExpanded ? "Collapse All" : "Expand All"}
            </button>
          </div>

          <div className="flex min-h-0 flex-col gap-3 lg:flex-1 lg:gap-4 lg:overflow-y-auto">
            <GradingSummary summary={summary} />

            {questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                selected={selectedQuestion?.id === question.id}
                expanded={expanded.has(question.id)}
                onSelect={() => selectQuestion(question.id)}
                onToggle={() => toggle(question.id)}
                onViewAnswer={() => setTab("answer")}
              />
            ))}

            {unmatchedAnswers.length > 0 && (
              <div className="flex flex-col gap-3 pt-2">
                <div className="px-1">
                  <h3 className="text-[16px] leading-[1.4] font-bold tracking-[-0.64px] text-ink">
                    Answers not matched to any question
                  </h3>
                  <p className="text-[14px] leading-[1.4] tracking-[-0.56px] text-muted/80">
                    These parts of the answer sheet don’t answer any question on the paper, so they
                    weren’t graded.
                  </p>
                </div>
                {unmatchedAnswers.map((answer) => (
                  <UnmatchedAnswerCard
                    key={answer.id}
                    answer={answer}
                    selected={selectedUnmatched?.id === answer.id}
                    onSelect={() => setSelection({ kind: "unmatched", id: answer.id })}
                    onViewAnswer={() => setTab("answer")}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        <div
          className={cn(
            "relative min-h-[70dvh] lg:min-h-0 lg:min-w-0 lg:flex-1",
            tab !== "answer" && "hidden lg:block",
          )}
        >
          {/* The viewer ignores the pointer while resizing, so the drag isn't lost to it. */}
          <div className={cn("h-full", resizing && "pointer-events-none")}>
            <AnswerSheetViewer
              pages={pages}
              highlight={highlight}
              notice={notice}
              focusSignal={`${highlight?.key ?? "none"}:${tab}`}
            />
          </div>
          {/* The splitter handle from the design: drag it, or focus it and use the arrow keys. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the questions and answer sheet panels"
            aria-valuemin={Math.round(SPLIT_MIN * 100)}
            aria-valuemax={Math.round(SPLIT_MAX * 100)}
            aria-valuenow={Math.round(split * 100)}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onPointerMove={(event) => resizing && splitAt(event.clientX)}
            onPointerUp={() => setResizing(false)}
            onPointerCancel={() => setResizing(false)}
            onDoubleClick={() => setSplit(defaultSplit(pages.length))}
            onKeyDown={resizeWithKeys}
            className={cn(
              "group absolute top-1/2 -left-[15px] z-20 hidden h-[71px] w-[18px] -translate-y-1/2 cursor-col-resize touch-none items-center justify-center rounded-full bg-white/80 shadow-[0_4px_22.5px_rgba(0,0,0,0.25)] lg:flex",
              "before:absolute before:-inset-x-3 before:-inset-y-6 before:content-['']",
              "hover:scale-110 hover:bg-white focus-visible:outline-2 focus-visible:outline-primary",
              resizing && "scale-110 bg-white",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "h-7 w-1 rounded-full bg-line transition-colors group-hover:bg-primary/70",
                resizing && "bg-primary",
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
