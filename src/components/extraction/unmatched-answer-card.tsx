import { ScanSearch } from "lucide-react";
import { cn } from "@/lib/cn";
import type { UnmatchedAnswer } from "@/lib/extraction/types";

type UnmatchedAnswerCardProps = {
  answer: UnmatchedAnswer;
  selected: boolean;
  onSelect: () => void;
  onViewAnswer: () => void;
};

export function UnmatchedAnswerCard({ answer, selected, onSelect, onViewAnswer }: UnmatchedAnswerCardProps) {
  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-2xl bg-white p-3 transition-[box-shadow,translate] duration-200",
        "hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(0,0,0,0.08)]",
        selected && "ring-2 ring-primary-soft ring-inset",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex items-start gap-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-white/25 text-[18px] font-extrabold text-white",
            selected ? "bg-primary" : "bg-muted/70",
          )}
        >
          ?
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] leading-[1.4] font-semibold tracking-[-0.56px] text-ink">
            {answer.studentLabel ? `Labelled “${answer.studentLabel}”` : "Unlabelled answer"}
          </span>
          <span className="line-clamp-3 text-[14px] leading-[1.4] tracking-[-0.56px] whitespace-pre-line text-muted">
            {answer.text}
          </span>
        </span>
      </button>
      {selected && (
        <button
          type="button"
          onClick={onViewAnswer}
          className="ml-11 flex items-center gap-2 self-start rounded-full bg-ink px-4 py-2 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] text-white hover:bg-ink-strong active:scale-95 lg:hidden"
        >
          <ScanSearch size={16} aria-hidden />
          View on answer sheet
        </button>
      )}
    </article>
  );
}
