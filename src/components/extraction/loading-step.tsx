import Image from "next/image";
import {
  Check,
  CloudUpload,
  FileImage,
  FileSearch,
  FileText,
  GraduationCap,
  Link2,
  ListChecks,
  ScanText,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

// Sparkle positions are the design's inset percentages within a
// 128.154 × 134.492 box, so they scale with the box. Each twinkles on its own
// beat; the dot floats.
const SPARKLES = [
  { src: "/assets/loader/sparkle-large.svg", width: 95.6557, height: 95.9947, left: "25.36%", top: "0%", animation: "animate-twinkle", delay: "0s" },
  { src: "/assets/loader/sparkle-medium.svg", width: 71.7414, height: 71.996, left: "9.75%", top: "46.47%", animation: "animate-twinkle", delay: "0.55s" },
  { src: "/assets/loader/sparkle-small.svg", width: 28.6966, height: 28.7984, left: "70.22%", top: "62.27%", animation: "animate-twinkle", delay: "1.1s" },
  { src: "/assets/loader/dot.svg", width: 12.5, height: 12.5, left: "13.65%", top: "35.32%", animation: "animate-float", delay: "0.3s" },
];

// What each progress step is doing, as an icon.
const STEP_ICONS: Record<string, LucideIcon> = {
  prepare: FileImage,
  upload: CloudUpload,
  "reading-question": FileText,
  "reading-answer": ScanText,
  questions: FileSearch,
  answers: ListChecks,
  mapping: Link2,
  grading: GraduationCap,
};

export type StepStatus = "pending" | "active" | "done";

export type ProgressStep = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
};

function StepIcon({ id, status }: { id: string; status: StepStatus }) {
  if (status === "done") {
    // Keyed so the pop plays when the step finishes.
    return (
      <span key="done" className="flex size-7 shrink-0 animate-pop items-center justify-center rounded-full bg-success text-white">
        <Check size={14} strokeWidth={3} aria-hidden />
      </span>
    );
  }
  const Icon = STEP_ICONS[id] ?? FileText;
  if (status === "active") {
    return (
      <span className="flex size-7 shrink-0 animate-glow items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon size={16} aria-hidden className="animate-hop" />
      </span>
    );
  }
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full border-2 border-line text-disabled">
      <Icon size={13} />
    </span>
  );
}

export function LoadingStep({ steps }: { steps: ProgressStep[] }) {
  const current = steps.find((step) => step.status === "active");
  const finished = steps.filter((step) => step.status === "done").length;

  return (
    <section
      aria-label="Processing progress"
      className="flex min-h-[70dvh] flex-1 items-center justify-center rounded-3xl bg-white px-4 py-10"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-[15px]">
        <div aria-hidden className="relative h-[134.492px] w-[128.154px]">
          {SPARKLES.map((sparkle) => (
            <Image
              key={sparkle.src}
              src={sparkle.src}
              alt=""
              width={sparkle.width}
              height={sparkle.height}
              className={cn("absolute max-w-none motion-reduce:animate-none", sparkle.animation)}
              style={{ left: sparkle.left, top: sparkle.top, animationDelay: sparkle.delay }}
            />
          ))}
        </div>
        <div className="flex flex-col items-center">
          <p className="animate-shimmer bg-[linear-gradient(90deg,#303030_20%,#606060_40%,#808080_50%,#606060_60%,#303030_80%)] bg-size-[200%_100%] bg-clip-text text-[30px] leading-9 font-bold tracking-[-1.2px] whitespace-nowrap text-transparent motion-reduce:animate-none motion-reduce:bg-size-[100%_100%]">
            Extracting...
          </p>
          <p className="text-[20px] leading-9 tracking-[-1.2px] whitespace-nowrap text-[rgba(70,70,70,0.75)]">
            This may take a while
          </p>
        </div>

        <p role="status" aria-live="polite" className="sr-only">
          {current ? `${current.label}${current.detail ? `, ${current.detail}` : ""}` : ""}
        </p>
        <div className="mt-3 flex w-full flex-col gap-3 rounded-2xl bg-off-white p-4">
          {/* Overall progress. */}
          <div aria-hidden className="h-1 overflow-hidden rounded-full bg-line/60">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${(finished / steps.length) * 100}%` }}
            />
          </div>
          <ol className="flex flex-col gap-1">
            {steps.map((step) => (
              <li
                key={step.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-2 py-1 transition-colors duration-300",
                  step.status === "active" && "bg-white shadow-[0_2px_8px_rgba(0,0,0,0.06)]",
                )}
              >
                <StepIcon id={step.id} status={step.status} />
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[14px] leading-[1.4] tracking-[-0.56px]",
                    step.status === "pending" ? "text-muted/60" : "text-ink",
                    step.status === "active" && "font-semibold",
                  )}
                >
                  {step.label}
                </span>
                {step.detail && step.status !== "pending" && (
                  <span className="shrink-0 text-[12px] leading-[1.4] tracking-[-0.48px] text-muted/80">
                    {step.detail}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
