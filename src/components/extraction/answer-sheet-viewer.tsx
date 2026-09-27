"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { Region } from "@/lib/extraction/types";
import { HIGHLIGHT_STYLES, type HighlightTone } from "./verdict-styles";

export type SheetPage = { url: string; width: number; height: number };

export type Highlight = {
  /** Changes whenever a different answer is selected. */
  key: string;
  label: string;
  tone: HighlightTone;
  regions: Region[];
};

type AnswerSheetViewerProps = {
  pages: SheetPage[];
  highlight: Highlight | null;
  /** Shown over the sheet when the selected question has no answer. */
  notice: string | null;
  /** Changes when the viewer should bring the highlight into view. */
  focusSignal: string;
};

// 100% fits the page to the panel's width, so a wider panel (see the splitter
// in MappingStep) shows a bigger page.
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const DEFAULT_ZOOM_INDEX = 2;
// While a smooth scroll to another page runs, the observer would report the
// pages it passes through, so its updates are ignored for this long.
const SCROLL_ANIMATION_MS = 700;

const controlPill =
  "flex items-center gap-2 rounded-lg bg-white/10 px-2 py-1.5 text-[14px] leading-[1.4] font-bold tracking-[-0.56px] text-white";
const controlButton =
  "flex size-7 items-center justify-center rounded-md hover:bg-white/15 active:scale-90 disabled:opacity-40 disabled:hover:bg-transparent";

export function AnswerSheetViewer({ pages, highlight, notice, focusSignal }: AnswerSheetViewerProps) {
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [currentPage, setCurrentPage] = useState(1);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const firstRegionRef = useRef<HTMLDivElement | null>(null);
  // Mirrors currentPage so quick repeated clicks build on the latest target.
  const currentPageRef = useRef(1);
  const ignoreObserverUntil = useRef(0);

  const zoom = ZOOM_STEPS[zoomIndex];
  const totalPages = pages.length;

  // Keep "Page X of N" in sync with whichever page is most visible, whether the
  // viewer scrolls on its own (desktop) or the whole page does (phone).
  useEffect(() => {
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(Number((entry.target as HTMLElement).dataset.page), entry.intersectionRatio);
        }
        let best = 0;
        let bestRatio = -1;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio) {
            best = page;
            bestRatio = ratio;
          }
        }
        if (best && Date.now() >= ignoreObserverUntil.current) {
          currentPageRef.current = best;
          setCurrentPage(best);
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    pageRefs.current.forEach((element) => element && observer.observe(element));
    return () => observer.disconnect();
  }, [pages]);

  // Bring the selected answer into view. Skipped while the viewer is hidden
  // (the phone's Questions tab); the signal changes again when it's shown.
  useEffect(() => {
    const target = firstRegionRef.current;
    if (!target || target.offsetParent === null) return;
    const page = Number(target.closest<HTMLElement>("[data-page]")?.dataset.page ?? 1);
    currentPageRef.current = page;
    setCurrentPage(page);
    ignoreObserverUntil.current = Date.now() + SCROLL_ANIMATION_MS;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusSignal]);

  function goToPage(page: number) {
    const target = Math.min(Math.max(page, 1), totalPages);
    currentPageRef.current = target;
    setCurrentPage(target);
    ignoreObserverUntil.current = Date.now() + SCROLL_ANIMATION_MS;
    pageRefs.current[target - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const styles = highlight ? HIGHLIGHT_STYLES[highlight.tone] : null;
  let firstRegionAssigned = false;

  return (
    <section
      aria-label="Answer sheet"
      className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[20px] border-[1.25px] border-black/10 bg-white"
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-3 overflow-hidden border-b-[1.25px] border-black/10 bg-ink px-4 py-3 lg:px-6">
        <h2 className="hidden text-[16px] leading-[1.4] font-bold tracking-[-0.64px] whitespace-nowrap text-white/80 lg:block">
          Answer Sheet
        </h2>
        <div className="flex w-full items-center justify-between gap-3 lg:w-auto lg:justify-end">
          <div className={controlPill}>
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((index) => Math.max(index - 1, 0))}
              className={controlButton}
            >
              <Minus size={16} />
            </button>
            <span aria-live="polite" className="min-w-[3ch] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              onClick={() => setZoomIndex((index) => Math.min(index + 1, ZOOM_STEPS.length - 1))}
              className={controlButton}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className={controlPill}>
            <button
              type="button"
              aria-label="Previous page"
              disabled={currentPage === 1}
              onClick={() => goToPage(currentPageRef.current - 1)}
              className={controlButton}
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite" className="whitespace-nowrap">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              aria-label="Next page"
              disabled={currentPage === totalPages}
              onClick={() => goToPage(currentPageRef.current + 1)}
              className={controlButton}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {notice && (
        <p
          role="status"
          className="pointer-events-none absolute top-20 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink/90 px-4 py-2 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] whitespace-nowrap text-white shadow-lg"
        >
          {notice}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {pages.map((page, index) => {
          const regions = highlight?.regions.filter((region) => region.page === index) ?? [];
          return (
            <div
              key={page.url}
              data-page={index + 1}
              ref={(element) => {
                pageRefs.current[index] = element;
              }}
              className="px-2.5 pb-2.5 first:pt-2.5"
            >
              <div
                className="relative mx-auto"
                style={{ width: `${zoom * 100}%` }}
              >
                <Image
                  src={page.url}
                  alt={`Answer sheet, page ${index + 1}`}
                  width={page.width}
                  height={page.height}
                  unoptimized
                  priority={index === 0}
                  className="block h-auto w-full"
                />
                {highlight &&
                  styles &&
                  regions.map((region, regionIndex) => {
                    const isFirst = !firstRegionAssigned;
                    firstRegionAssigned = true;
                    // Tabs sit above the box, unless that would leave the page.
                    const tagInside = region.box.y < 0.03;
                    return (
                      <div
                        key={`${highlight.key}-${regionIndex}`}
                        ref={isFirst ? firstRegionRef : undefined}
                        className="pointer-events-none absolute rounded-2xl border-[1.5px] border-white"
                        style={{
                          left: `${region.box.x * 100}%`,
                          top: `${region.box.y * 100}%`,
                          width: `${region.box.w * 100}%`,
                          height: `${region.box.h * 100}%`,
                        }}
                      >
                        <div className={cn("absolute inset-0 rounded-2xl border-2", styles.box)} />
                        <span
                          className={cn(
                            "absolute left-3.5 px-3 py-1 text-[16px] leading-[1.4] font-bold tracking-[-0.64px] whitespace-nowrap text-white",
                            styles.tag,
                            tagInside ? "top-1 rounded-xl" : "-top-7 rounded-t-xl",
                          )}
                        >
                          {highlight.label}
                        </span>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
