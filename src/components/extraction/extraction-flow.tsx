"use client";

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ExtractionError, requestExtraction } from "@/lib/extraction/client";
import { ACCEPTED_TYPES, MAX_FILE_BYTES, MAX_PAGES } from "@/lib/extraction/constants";
import { prepareDocument, PrepareError, type PreparedPage } from "@/lib/extraction/prepare-document";
import type { ExtractionRequest } from "@/lib/extraction/request-schema";
import type { ExtractionResult } from "@/lib/extraction/types";
import { createId, uploadExamFile, uploadPageImage, type UploadKind } from "@/lib/uploads";
import type { SheetPage } from "./answer-sheet-viewer";
import { LoadingStep, type ProgressStep, type StepStatus } from "./loading-step";
import { MappingStep } from "./mapping-step";
import { UploadStep, type SelectedFiles } from "./upload-step";

type Step = "upload" | "loading" | "mapping";
type UploadedDocument = ExtractionRequest["question"];

const STEPS: { id: string; label: string }[] = [
  { id: "prepare", label: "Preparing pages" },
  { id: "upload", label: "Uploading files" },
  { id: "reading-question", label: "Reading question paper" },
  { id: "reading-answer", label: "Reading answer sheet" },
  { id: "questions", label: "Extracting questions" },
  { id: "answers", label: "Extracting answers" },
  { id: "mapping", label: "Mapping answers to questions" },
  { id: "grading", label: "Grading and writing feedback" },
];

const initialSteps = (): ProgressStep[] => STEPS.map((step) => ({ ...step, status: "pending" }));

export function ExtractionFlow() {
  const [step, setStep] = useState<Step>("upload");
  // Several answer files are allowed (e.g. one photo per sheet); their pages
  // are combined in this order.
  const [files, setFiles] = useState<SelectedFiles>({ question: null, answers: [] });
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [progress, setProgress] = useState<ProgressStep[]>(initialSteps);
  const [result, setResult] = useState<{ data: ExtractionResult; pages: SheetPage[] } | null>(null);

  // All uploads of this session share one storage folder.
  const submissionId = useRef<string | null>(null);
  // Work already done per file, so a retry only redoes what failed.
  const prepared = useRef(new WeakMap<File, PreparedPage[]>());
  const uploaded = useRef(new WeakMap<File, UploadedDocument>());
  const abort = useRef<AbortController | null>(null);

  // Object URLs for the answer sheet pages, released when replaced.
  useEffect(() => {
    const urls = result?.pages.map((page) => page.url) ?? [];
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [result]);

  useEffect(() => () => abort.current?.abort(), []);

  function updateStep(id: string, status: StepStatus, detail?: string) {
    setProgress((steps) =>
      steps.map((item) => (item.id === id ? { ...item, status, detail: detail ?? item.detail } : item)),
    );
  }

  function handleSelect(kind: UploadKind, picked: File[]) {
    const problems: string[] = [];
    const valid = picked.filter((file) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        problems.push(`“${file.name}” isn’t a PDF, PNG or JPG file.`);
        return false;
      }
      if (file.size > MAX_FILE_BYTES) {
        problems.push(`“${file.name}” is larger than 10MB.`);
        return false;
      }
      return true;
    });

    if (kind === "question") {
      if (valid[0]) setFiles((current) => ({ ...current, question: valid[0] }));
    } else {
      const room = MAX_PAGES - files.answers.length;
      if (valid.length > room) problems.push(`You can add up to ${MAX_PAGES} answer sheets.`);
      const added = valid.slice(0, Math.max(room, 0));
      setFiles((current) => ({ ...current, answers: [...current.answers, ...added] }));
    }
    setError(problems.length ? problems.join(" ") : null);
  }

  function handleRemove(kind: UploadKind, index = 0) {
    setError(null);
    setFiles((current) =>
      kind === "question"
        ? { ...current, question: null }
        : { ...current, answers: current.answers.filter((_, i) => i !== index) },
    );
  }

  // The answer sheets' order is the page order of the combined answer sheet.
  function handleReorderAnswer(from: number, to: number) {
    setFiles((current) => {
      if (from === to || to < 0 || to >= current.answers.length) return current;
      const answers = [...current.answers];
      const [moved] = answers.splice(from, 1);
      answers.splice(to, 0, moved);
      return { ...current, answers };
    });
  }

  function handleMoveAnswer(index: number, delta: -1 | 1) {
    handleReorderAnswer(index, index + delta);
  }

  async function prepareOnce(file: File) {
    const cached = prepared.current.get(file);
    if (cached) return cached;
    const pages = await prepareDocument(file);
    prepared.current.set(file, pages);
    return pages;
  }

  async function uploadOnce(file: File, kind: UploadKind, pages: PreparedPage[], id: string) {
    const cached = uploaded.current.get(file);
    if (cached) return cached;
    const [, ...paths] = await Promise.all([
      uploadExamFile(file, kind, id),
      ...pages.map((page, index) => uploadPageImage(page.image, kind, id, index)),
    ]);
    const document: UploadedDocument = {
      pages: pages.map((page, index) => ({
        path: paths[index],
        width: page.width,
        height: page.height,
        lines: page.lines,
      })),
    };
    uploaded.current.set(file, document);
    return document;
  }

  async function handleStart() {
    const { question, answers } = files;
    if (!question || answers.length === 0) return;

    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    submissionId.current ??= createId();
    const id = submissionId.current;

    setError(null);
    setProgress(initialSteps());
    setStep("loading");
    setSidebarCollapsed(true); // The design collapses the sidebar once extraction starts.

    try {
      updateStep("prepare", "active");
      const [questionPages, ...answerPagesPerFile] = await Promise.all(
        [question, ...answers].map(prepareOnce),
      );
      const answerPages = answerPagesPerFile.flat();
      if (answerPages.length > MAX_PAGES) {
        throw new PrepareError(
          `The answer sheets have ${answerPages.length} pages in total; the limit is ${MAX_PAGES}.`,
        );
      }
      updateStep("prepare", "done", `${questionPages.length + answerPages.length} pages`);

      updateStep("upload", "active");
      const [questionDoc, ...answerDocs] = await Promise.all([
        uploadOnce(question, "question", questionPages, id),
        ...answers.map((file, index) => uploadOnce(file, "answer", answerPagesPerFile[index], id)),
      ]);
      const answerDoc: UploadedDocument = { pages: answerDocs.flatMap((doc) => doc.pages) };
      updateStep("upload", "done");
      if (controller.signal.aborted) return;

      const data = await requestExtraction(
        { submissionId: id, question: questionDoc, answer: answerDoc },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "progress") updateStep(event.stage, event.status, event.detail);
          },
        },
      );
      if (controller.signal.aborted) return;

      setResult({
        data,
        pages: answerPages.map((page) => ({
          url: URL.createObjectURL(page.image),
          width: page.width,
          height: page.height,
        })),
      });
      setStep("mapping");
    } catch (failure) {
      if (controller.signal.aborted) return;
      console.error("Processing the exam files failed", failure);
      setError(describeFailure(failure));
      setStep("upload");
      setSidebarCollapsed(false);
    }
  }

  function handleBack() {
    abort.current?.abort();
    setStep("upload");
    setSidebarCollapsed(false);
  }

  return (
    <AppShell
      variant={step}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
      onBack={step === "upload" ? undefined : handleBack}
    >
      {step === "upload" && (
        <UploadStep
          files={files}
          error={error}
          onSelect={handleSelect}
          onRemove={handleRemove}
          onMoveAnswer={handleMoveAnswer}
          onReorderAnswer={handleReorderAnswer}
          onStart={handleStart}
        />
      )}
      {step === "loading" && <LoadingStep steps={progress} />}
      {step === "mapping" && result && <MappingStep result={result.data} pages={result.pages} />}
    </AppShell>
  );
}

function describeFailure(failure: unknown) {
  if (failure instanceof PrepareError || failure instanceof ExtractionError) return failure.message;
  // Supabase storage errors carry this marker (the class isn't re-exported).
  if (typeof failure === "object" && failure !== null && "__isStorageError" in failure) {
    return "We couldn’t upload your files. Please check your connection and try again.";
  }
  return "Something went wrong while processing the files. Please try again.";
}
