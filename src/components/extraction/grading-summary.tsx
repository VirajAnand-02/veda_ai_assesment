import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GradingSummary as Summary, Verdict } from "@/lib/extraction/types";

const COUNT_ITEMS: { verdict: Verdict; label: string; dot: string }[] = [
  { verdict: "correct", label: "Correct", dot: "bg-success" },
  { verdict: "partial", label: "Partial", dot: "bg-warning" },
  { verdict: "incorrect", label: "Incorrect", dot: "bg-danger" },
  { verdict: "unanswered", label: "Unanswered", dot: "bg-disabled" },
];

const formatMarks = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

function percentageTone(percentage: number) {
  if (percentage >= 80) return { pill: "bg-[rgba(69,181,41,0.1)] text-success", bar: "bg-success" };
  if (percentage >= 40) return { pill: "bg-[rgba(255,153,0,0.1)] text-warning", bar: "bg-warning" };
  return { pill: "bg-[#ffe9e2] text-danger", bar: "bg-danger" };
}

export function GradingSummary({ summary }: { summary: Summary }) {
  const tone = percentageTone(summary.percentage);

  return (
    <section aria-label="Grading summary" className="flex flex-col gap-3 rounded-2xl bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[14px] leading-[1.4] tracking-[-0.56px] text-muted/80">Total score</p>
          <p className="text-[28px] leading-[1.2] font-bold tracking-[-1.12px] text-ink">
            {formatMarks(summary.score)}
            <span className="text-[18px] font-semibold tracking-[-0.72px] text-muted/80">
              {" "}/ {formatMarks(summary.maxScore)}
            </span>
          </p>
        </div>
        <span className={cn("rounded-full px-3 py-1 text-[16px] leading-[1.4] font-bold tracking-[-0.64px]", tone.pill)}>
          {summary.percentage}%
        </span>
      </div>

      <div
        role="progressbar"
        aria-label="Score"
        aria-valuenow={summary.percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-off-white"
      >
        <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${summary.percentage}%` }} />
      </div>

      <dl className="grid grid-cols-4 gap-2">
        {COUNT_ITEMS.map(({ verdict, label, dot }) => (
          <div key={verdict} className="flex flex-col items-center rounded-xl bg-off-white px-1 py-2">
            <dd className="text-[18px] leading-[1.4] font-bold tracking-[-0.72px] text-ink">
              {summary.counts[verdict]}
            </dd>
            <dt className="flex items-center gap-1 text-[12px] leading-[1.4] tracking-[-0.48px] text-muted">
              <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
              {label}
            </dt>
          </div>
        ))}
      </dl>

      {summary.notes.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl bg-off-white px-3 py-2 text-[13px] leading-[1.4] tracking-[-0.52px] text-muted">
          {summary.notes.map((note) => (
            <li key={note} className="flex gap-2">
              <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
              {note}
            </li>
          ))}
        </ul>
      )}

      {summary.overallFeedback && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[16px] leading-[1.4] font-bold tracking-[-0.64px] text-ink">Overall feedback</p>
          <p className="text-[14px] leading-[1.4] tracking-[-0.56px] text-ink">{summary.overallFeedback}</p>
        </div>
      )}

      {(summary.strengths.length > 0 || summary.improvements.length > 0) && (
        <details className="group rounded-xl bg-off-white px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-[14px] leading-[1.4] font-semibold tracking-[-0.56px] text-ink [&::-webkit-details-marker]:hidden">
            Strengths and areas to improve
            <ChevronDown size={18} aria-hidden className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 grid gap-3 text-[14px] leading-[1.4] tracking-[-0.56px] text-ink sm:grid-cols-2">
            {summary.strengths.length > 0 && (
              <div>
                <p className="mb-1 font-semibold text-success">Strengths</p>
                <ul className="list-disc space-y-1 pl-4">
                  {summary.strengths.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {summary.improvements.length > 0 && (
              <div>
                <p className="mb-1 font-semibold text-warning">To improve</p>
                <ul className="list-disc space-y-1 pl-4">
                  {summary.improvements.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
