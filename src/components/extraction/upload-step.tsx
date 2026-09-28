"use client";

import Image from "next/image";
import { ChevronDown, ChevronUp, GripVertical, Plus, Upload, X } from "lucide-react";
import { Fragment, useId, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { ACCEPTED_TYPES } from "@/lib/extraction/constants";
import type { UploadKind } from "@/lib/uploads";
import { TeacherOrbit } from "./teacher-orbit";

export type SelectedFiles = { question: File | null; answers: File[] };

function formatSize(bytes: number) {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${Number(mb.toFixed(1))}MB`;
}

function fileTypeLabel(file: File) {
  const ext = file.name.split(".").pop();
  return (ext && ext.length <= 4 ? ext : "FILE").toUpperCase();
}

// Thumbnails live as long as the page, which is fine for a handful of files.
const thumbnailUrls = new WeakMap<File, string>();
function thumbnailUrl(file: File) {
  let url = thumbnailUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    thumbnailUrls.set(file, url);
  }
  return url;
}

/** PDF icon from the design, or a preview for photos of answer sheets. */
function FileThumb({ file, className }: { file: File; className: string }) {
  if (file.type.startsWith("image/")) {
    return (
      <Image
        src={thumbnailUrl(file)}
        alt=""
        width={40}
        height={40}
        unoptimized
        className={cn("shrink-0 rounded-md bg-white object-cover", className)}
      />
    );
  }
  // The design zooms into the PDF icon, so it is cropped inside a fixed box.
  return (
    <div className={cn("relative shrink-0 overflow-hidden", className)}>
      <Image
        src="/assets/images/pdf-icon.png"
        alt=""
        width={500}
        height={500}
        className="absolute max-w-none"
        style={{ left: "-21.43%", top: "-12.38%", width: "142.86%", height: "125%" }}
      />
    </div>
  );
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="relative flex max-w-full min-w-0 animate-pop items-center gap-[9.6px] rounded-[9.6px] bg-off-white py-[9.6px] pr-4 pl-[9.6px] lg:gap-3 lg:rounded-xl lg:py-3 lg:pr-5 lg:pl-3">
      <FileThumb file={file} className="h-8 w-7 lg:h-10 lg:w-[35px]" />
      <div className="flex min-w-0 flex-col items-center">
        <p className="max-w-full truncate text-[12.8px] leading-[1.4] font-bold tracking-[-0.512px] text-ink-strong lg:text-[16px] lg:tracking-[-0.64px]">
          {file.name}
        </p>
        <div className="flex items-center justify-center gap-[6.4px] text-[11.2px] leading-[1.4] tracking-[-0.448px] whitespace-nowrap text-muted/80 lg:gap-2 lg:text-[14px] lg:tracking-[-0.56px]">
          <span>{formatSize(file.size)}</span>
          <Image src="/assets/icons/dot-mobile.svg" alt="" width={4} height={4} className="lg:hidden" />
          <Image src="/assets/icons/dot.svg" alt="" width={5} height={5} className="hidden lg:block" />
          <span>{fileTypeLabel(file)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute -top-2.5 -right-2.5 flex size-[25.6px] items-center justify-center rounded-full bg-ink-strong/80 p-[3.2px] text-white shadow-[0_4px_11.4px_rgba(0,0,0,0.25)] hover:scale-110 hover:rotate-90 hover:bg-danger active:scale-95"
      >
        <X size={19.2} />
      </button>
    </div>
  );
}

const iconButton =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-ink hover:scale-110 hover:bg-white active:scale-95 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:bg-transparent";

/** Where a dragged sheet would land, shown as a line between rows. */
function DropLine() {
  return <li aria-hidden className="h-0.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_2px_rgba(255,86,35,0.15)]" />;
}

/**
 * Row used once there are several answer sheets. Drag it (or use the arrows)
 * to set the order the pages are read in: with a mouse by the whole row, on a
 * touch screen by the grip, so swiping the list still scrolls it.
 */
function SheetRow({
  file,
  index,
  count,
  dragOffset,
  rowRef,
  onRemove,
  onMove,
  onDragStart,
}: {
  file: File;
  index: number;
  count: number;
  /** How far this row has been dragged (px), or null when it isn't being dragged. */
  dragOffset: number | null;
  rowRef: (element: HTMLLIElement | null) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  onDragStart: (event: PointerEvent<HTMLElement>) => void;
}) {
  const dragging = dragOffset !== null;
  return (
    <li
      ref={rowRef}
      onPointerDown={(event) => {
        // Mouse: anywhere but the buttons. Touch: the grip only (below).
        if (event.pointerType !== "mouse" || (event.target as HTMLElement).closest("button")) return;
        onDragStart(event);
      }}
      // Stops the browser's own image drag from taking over.
      onDragStart={(event) => event.preventDefault()}
      style={dragging ? { transform: `translateY(${dragOffset}px) scale(1.02)` } : undefined}
      className={cn(
        "group/row relative flex shrink-0 animate-pop items-center gap-2 rounded-xl py-1.5 pr-1.5 pl-1 select-none",
        dragging
          ? "z-20 cursor-grabbing bg-white shadow-[0_10px_24px_rgba(0,0,0,0.18)] ring-1 ring-primary/40"
          : "bg-off-white transition-[box-shadow,transform] duration-150 hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] [@media(pointer:fine)]:cursor-grab",
      )}
    >
      <span
        aria-hidden
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") onDragStart(event);
        }}
        className="flex h-10 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-disabled transition-colors group-hover/row:text-muted active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </span>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ink-strong/80 text-[12px] font-bold text-white">
        {index + 1}
      </span>
      {/* Hover the thumbnail for a closer look at the page. */}
      <FileThumb
        file={file}
        className="relative z-10 h-12 w-10 origin-left shadow-sm transition-transform duration-200 hover:scale-[2.6] hover:shadow-lg"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] leading-[1.4] font-bold tracking-[-0.56px] text-ink-strong">
          {file.name}
        </p>
        <p className="text-[12px] leading-[1.4] tracking-[-0.48px] text-muted/80">
          {formatSize(file.size)} · {fileTypeLabel(file)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={index === 0}
        aria-label={`Move ${file.name} up`}
        className={iconButton}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={index === count - 1}
        aria-label={`Move ${file.name} down`}
        className={iconButton}
      >
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className={iconButton}
      >
        <X size={16} />
      </button>
    </li>
  );
}

const cardBase =
  "overflow-clip rounded-[20px] border-[1.5px] border-dashed border-line bg-white transition-colors";

/** Hidden file input plus drag-and-drop handling for a slot. */
function useFilePicker(multiple: boolean, onSelect: (files: File[]) => void) {
  const inputId = useId();
  const [dragging, setDragging] = useState(false);

  const input = (
    <input
      id={inputId}
      type="file"
      multiple={multiple}
      accept={ACCEPTED_TYPES.join(",")}
      className="sr-only"
      onChange={(event) => {
        const picked = [...(event.target.files ?? [])];
        if (picked.length) onSelect(multiple ? picked : picked.slice(0, 1));
        event.target.value = "";
      }}
    />
  );

  // Only files dragged in from the computer; a sheet being reordered within
  // the list is ignored here.
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const dropHandlers = {
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      const dropped = [...event.dataTransfer.files];
      if (dropped.length) onSelect(multiple ? dropped : dropped.slice(0, 1));
    },
  };

  return { inputId, input, dragging, dropHandlers };
}

function EmptySlot({ label, hint, picker }: { label: string; hint: string; picker: ReturnType<typeof useFilePicker> }) {
  return (
    <label
      htmlFor={picker.inputId}
      {...picker.dropHandlers}
      className={cn(
        cardBase,
        "group flex cursor-pointer items-center justify-center px-2.5 py-4 lg:h-full lg:flex-1 lg:p-2.5",
        "hover:border-primary/60 hover:bg-primary/[0.02] hover:shadow-[0_8px_20px_rgba(0,0,0,0.06)]",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
        picker.dragging && "border-primary bg-primary/5",
      )}
    >
      {picker.input}
      <div className="flex flex-col items-center gap-2 lg:gap-4">
        <div
          className={cn(
            "flex size-10 items-center justify-center rounded-md bg-[#f3f3f3] p-[3.333px] text-ink transition-[transform,background-color,color] duration-200 lg:size-12 lg:rounded-lg lg:p-1",
            "group-hover:-translate-y-1 group-hover:bg-primary/10 group-hover:text-primary",
            picker.dragging && "animate-hop bg-primary/10 text-primary",
          )}
        >
          <Upload size={24} aria-hidden />
        </div>
        <div className="flex flex-col items-center gap-0.5 whitespace-nowrap">
          <p className="text-[18px] leading-[1.4] font-bold tracking-[-0.72px] text-ink lg:text-[20px] lg:leading-[22px] lg:font-semibold lg:tracking-[-1.2px]">
            Upload <span className="text-primary">{label}</span>
          </p>
          <p className="text-[12px] leading-[1.4] tracking-[-0.48px] text-muted/55 lg:text-[14px] lg:leading-[22px] lg:tracking-[-0.84px]">
            {hint}
          </p>
        </div>
      </div>
    </label>
  );
}

function FilledSlot({ picker, children }: { picker: ReturnType<typeof useFilePicker>; children: ReactNode }) {
  return (
    <div
      {...picker.dropHandlers}
      className={cn(
        cardBase,
        "flex flex-col lg:h-full lg:min-w-0 lg:flex-1",
        picker.dragging && "border-primary bg-primary/5",
      )}
    >
      {children}
    </div>
  );
}

function QuestionSlot({
  file,
  onSelect,
  onRemove,
}: {
  file: File | null;
  onSelect: (files: File[]) => void;
  onRemove: () => void;
}) {
  const picker = useFilePicker(false, onSelect);
  if (!file) return <EmptySlot label="Question Paper" hint="Max 10MB" picker={picker} />;
  return (
    <FilledSlot picker={picker}>
      <div className="flex h-[127px] items-center justify-center px-2.5 py-4 lg:h-full lg:p-2.5">
        <FileChip file={file} onRemove={onRemove} />
      </div>
    </FilledSlot>
  );
}

/** Scroll the list when a drag comes this close to its top or bottom edge (px). */
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_STEP = 12;

/**
 * Pointer-based reordering (mouse, touch and pen alike): the dragged row
 * follows the pointer, a line shows where it will land, and the list scrolls
 * near its edges.
 */
function useSheetSorting(count: number, onReorder: (from: number, to: number) => void) {
  // `gap`: where the sheet would land, 0 = before the first row, count = after the last.
  const [drag, setDrag] = useState<{ from: number; offset: number; gap: number } | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const listRef = useRef<HTMLOListElement | null>(null);

  function startDrag(from: number, event: PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const list = listRef.current;
    const startY = event.clientY;
    const startScroll = list?.scrollTop ?? 0;
    // Row midpoints in list coordinates, measured once before anything moves.
    const middles = rows.current.map((row) => (row ? row.offsetTop + row.offsetHeight / 2 : 0));
    let gap = from;

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (list) {
        const rect = list.getBoundingClientRect();
        if (moveEvent.clientY < rect.top + AUTOSCROLL_EDGE) list.scrollTop -= AUTOSCROLL_STEP;
        else if (moveEvent.clientY > rect.bottom - AUTOSCROLL_EDGE) list.scrollTop += AUTOSCROLL_STEP;
      }
      const scrolled = (list?.scrollTop ?? 0) - startScroll;
      const offset = moveEvent.clientY - startY + scrolled;
      const draggedMiddle = middles[from] + offset;
      gap = middles.filter((middle, index) => index !== from && middle < draggedMiddle).length;
      if (gap >= from) gap += 1; // counts skipped the dragged row itself
      setDrag({ from, offset, gap });
    };
    const end = (endEvent: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(null);
      if (endEvent.type === "pointerup" && gap !== from && gap !== from + 1) onReorder(from, gap > from ? gap - 1 : gap);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    setDrag({ from, offset: 0, gap: from });
  }

  return {
    drag,
    listRef,
    rowRef: (index: number) => (element: HTMLLIElement | null) => {
      rows.current[index] = element;
      rows.current.length = count;
    },
    startDrag,
    // Dropping a sheet just above or below itself changes nothing, so no line there.
    showLineAt: (gap: number) => drag !== null && drag.gap === gap && gap !== drag.from && gap !== drag.from + 1,
  };
}

function AnswerSlot({
  files,
  onSelect,
  onRemove,
  onMove,
  onReorder,
}: {
  files: File[];
  onSelect: (files: File[]) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  /** Moves the sheet at `from` so it ends up at position `to`. */
  onReorder: (from: number, to: number) => void;
}) {
  const picker = useFilePicker(true, onSelect);
  const { drag, rowRef, listRef, startDrag, showLineAt } = useSheetSorting(files.length, onReorder);

  if (files.length === 0) {
    return <EmptySlot label="Answer Sheet" hint="Max 10MB each · add one file per sheet" picker={picker} />;
  }

  const addMore = (
    <label
      htmlFor={picker.inputId}
      className="group flex cursor-pointer items-center gap-1.5 self-center rounded-full px-3 py-1.5 text-[14px] leading-[1.4] font-semibold tracking-[-0.56px] text-primary hover:bg-primary/10 active:scale-95 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary"
    >
      {picker.input}
      <Plus size={16} aria-hidden className="transition-transform duration-200 group-hover:rotate-90" />
      Add another sheet
    </label>
  );

  return (
    <FilledSlot picker={picker}>
      {files.length === 1 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-2.5 pt-6 pb-3 lg:h-full lg:pt-5 lg:pb-2">
          <FileChip file={files[0]} onRemove={() => onRemove(0)} />
          {addMore}
        </div>
      ) : (
        <div className="flex min-h-0 flex-col gap-1.5 p-2.5 lg:h-full">
          <p className="px-1 text-[12px] leading-[1.4] tracking-[-0.48px] text-muted/80">
            Drag to set the page order
          </p>
          <ol
            ref={listRef}
            aria-label="Answer sheets, in page order"
            className="flex max-h-[360px] min-h-0 flex-col gap-1.5 overflow-y-auto lg:max-h-none lg:flex-1"
          >
            {files.map((file, index) => (
              <Fragment key={`${file.name}-${file.lastModified}-${file.size}`}>
                {showLineAt(index) && <DropLine />}
                <SheetRow
                  file={file}
                  index={index}
                  count={files.length}
                  dragOffset={drag?.from === index ? drag.offset : null}
                  rowRef={rowRef(index)}
                  onRemove={() => onRemove(index)}
                  onMove={(delta) => onMove(index, delta)}
                  onDragStart={(event) => startDrag(index, event)}
                />
              </Fragment>
            ))}
            {showLineAt(files.length) && <DropLine />}
          </ol>
          {addMore}
        </div>
      )}
    </FilledSlot>
  );
}

type UploadStepProps = {
  files: SelectedFiles;
  error: string | null;
  onSelect: (kind: UploadKind, files: File[]) => void;
  onRemove: (kind: UploadKind, index?: number) => void;
  onMoveAnswer: (index: number, delta: -1 | 1) => void;
  /** Moves the answer sheet at `from` to position `to` (drag and drop). */
  onReorderAnswer: (from: number, to: number) => void;
  onStart: () => void;
};

// From this many answer sheets the upload box grows, so the list (and its
// page thumbnails) is easy to read and reorder.
const MANY_SHEETS = 3;

export function UploadStep({ files, error, onSelect, onRemove, onMoveAnswer, onReorderAnswer, onStart }: UploadStepProps) {
  const canStart = files.question !== null && files.answers.length > 0;
  const manySheets = files.answers.length >= MANY_SHEETS;

  return (
    <section className="mx-auto flex w-full max-w-[1103px] flex-1 flex-col items-center gap-6 pt-6 pb-6 lg:justify-center lg:gap-9 lg:py-0">
      <div className="flex w-full flex-col items-center gap-3 lg:gap-5">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-center text-[24px] leading-[1.2] font-bold tracking-[-0.96px] text-ink-strong lg:flex lg:flex-wrap lg:items-center lg:justify-center lg:gap-x-3 lg:text-[32px] lg:tracking-[-1.28px] xl:text-[40px] xl:tracking-[-1.6px]">
            <span>Upload </span>
            <span className="lg:rounded-lg lg:bg-[rgba(255,147,80,0.15)] lg:px-2 lg:py-1 lg:whitespace-nowrap lg:text-primary">
              Question Paper
              <br className="lg:hidden" /> &amp; Answer Sheets
            </span>
          </h1>
          <p className="hidden text-[20px] leading-[1.4] tracking-[-0.8px] text-ink lg:block">
            Upload both files to get started
          </p>
        </div>

        <TeacherOrbit />

        <div
          className={cn(
            "w-full rounded-3xl bg-white/50 p-3 transition-[height,max-width] duration-300 ease-out",
            manySheets ? "max-w-[900px] lg:h-[400px]" : "max-w-[789px] lg:h-[205px]",
          )}
        >
          <div className="flex flex-col gap-3 lg:h-full lg:flex-row lg:gap-4">
            <QuestionSlot
              file={files.question}
              onSelect={(picked) => onSelect("question", picked)}
              onRemove={() => onRemove("question")}
            />
            <AnswerSlot
              files={files.answers}
              onSelect={(picked) => onSelect("answer", picked)}
              onRemove={(index) => onRemove("answer", index)}
              onMove={onMoveAnswer}
              onReorder={onReorderAnswer}
            />
          </div>
        </div>
        {error && (
          <p role="alert" className="max-w-[789px] text-center text-[14px] leading-[22px] tracking-[-0.56px] text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          disabled={!canStart}
          onClick={onStart}
          className="group flex items-center gap-2 rounded-full border-2 border-white/15 bg-ink py-3 pr-5 pl-6 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] text-white enabled:shadow-[0_4px_5px_rgba(0,0,0,0.12)] enabled:hover:-translate-y-0.5 enabled:hover:bg-ink-strong enabled:hover:shadow-[0_10px_22px_rgba(0,0,0,0.22)] enabled:active:translate-y-0 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-25"
        >
          Start Mapping
          <Image
            src="/assets/icons/arrow-right.svg"
            alt=""
            width={20}
            height={20}
            className="transition-transform duration-200 group-enabled:group-hover:translate-x-1"
          />
        </button>
        <p className="w-[285px] text-center text-[14px] leading-[22px] tracking-[-0.56px] text-muted/80 lg:w-auto lg:tracking-[-0.84px]">
          Once both files are uploaded, you’ll able to map answers with questions
        </p>
      </div>
    </section>
  );
}
