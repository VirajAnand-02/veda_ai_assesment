"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { LoaderCircle, ScanText, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { cn } from "@/lib/cn";
import { ACCEPTED_TYPES, MAX_FILE_BYTES } from "@/lib/extraction/constants";
import { prepareDocument, PrepareError } from "@/lib/extraction/prepare-document";
import type { TextLine } from "@/lib/extraction/types";
import { scoreAgainstTruth } from "@/lib/ocr/score";

// Side-by-side OCR comparison of the page readers the grading pipeline can use
// (AI_OCR_ENGINE): the vision LLM, HunyuanOCR, the hybrid of both, PaddleOCR
// PaddleOCR with the vision LLM finding tables and diagrams, Mistral OCR and
// NVIDIA's Nemotron OCR v1/v2, plus a second vision LLM on Groq
// (GROQ_OCR_MODEL). For
// typed PDFs the PDF's own text layer gives exact line positions, so each
// engine's boxes get an accuracy score. Nothing is uploaded or graded.

type Engine =
  | "hunyuan"
  | "llm"
  | "hybrid"
  | "paddle"
  | "paddle-llm"
  | "mistral"
  | "groq"
  | "nemotron-v1"
  | "nemotron-v2";
type Queue = "server" | "llm" | "paddle" | "mistral" | "groq" | "nvidia";

const ENGINES: { id: Engine; label: string; box: string; tag: string; queue: Queue }[] = [
  { id: "hunyuan", label: "HunyuanOCR", box: "border-primary bg-primary/10", tag: "bg-primary", queue: "server" },
  { id: "paddle", label: "PaddleOCR", box: "border-[#8e44ad] bg-[#8e44ad]/10", tag: "bg-[#8e44ad]", queue: "paddle" },
  // Same local server as PaddleOCR, so the same queue.
  { id: "paddle-llm", label: "Paddle + LLM", box: "border-[#6c3483] bg-[#6c3483]/10", tag: "bg-[#6c3483]", queue: "paddle" },
  { id: "mistral", label: "Mistral OCR", box: "border-[#d6336c] bg-[#d6336c]/10", tag: "bg-[#d6336c]", queue: "mistral" },
  { id: "nemotron-v1", label: "Nemotron OCR v1", box: "border-[#5a8f00] bg-[#5a8f00]/10", tag: "bg-[#5a8f00]", queue: "nvidia" },
  { id: "nemotron-v2", label: "Nemotron OCR v2", box: "border-[#007a87] bg-[#007a87]/10", tag: "bg-[#007a87]", queue: "nvidia" },
  { id: "llm", label: "Vision LLM", box: "border-[#2f6fed] bg-[#2f6fed]/10", tag: "bg-[#2f6fed]", queue: "llm" },
  { id: "groq", label: "Groq", box: "border-[#b8860b] bg-[#b8860b]/10", tag: "bg-[#b8860b]", queue: "groq" },
  { id: "hybrid", label: "Hybrid", box: "border-[#0f9d76] bg-[#0f9d76]/10", tag: "bg-[#0f9d76]", queue: "server" },
];

const BOX_FORMAT_OPTIONS = [
  { value: "", label: "Box format: .env" },
  { value: "auto", label: "auto (per model)" },
  { value: "xyxy999", label: "[x1,y1,x2,y2] 0–999" },
  { value: "xyxy1000", label: "[x1,y1,x2,y2] 0–1000" },
  { value: "yxyx1000", label: "[y1,x1,y2,x2] 0–1000" },
];
const TILE_OPTIONS = ["", "1", "2", "3", "4"];

type EngineStatus = {
  configured: boolean;
  model?: string;
  host?: string;
  boxFormat?: string;
  tiles?: number;
  error?: string;
};
type Page = { url: string; image: Blob; width: number; height: number; truth: TextLine[] | null };
type OcrResult = {
  model: string;
  settings?: string;
  lines: TextLine[];
  raw: string | null;
  warnings: string[];
  durationMs: number;
};
type Cell = { status: "running" } | { status: "done"; result: OcrResult } | { status: "error"; error: string };

// Pages are sent to HunyuanOCR with this long edge at most. Its image tokens
// grow with area: on a test page, 2263px -> 3718 tokens and 1600px -> 1897
// tokens, with equal box accuracy, so this roughly halves the time per page.
// Boxes are relative, so they still line up on the full-size preview.
const HUNYUAN_MAX_EDGE = 1600;

async function downscale(image: Blob, maxEdge: number): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
  if (scale >= 1) {
    bitmap.close();
    return image;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? image), "image/jpeg", 0.9));
}

/** Diagram and table entries cover a region, not a line of text, so they're drawn dashed and not scored. */
const regionKind = (line: TextLine) => /^\[(diagram|table)\b/i.exec(line.text)?.[1].toLowerCase() ?? null;
const isDiagram = (line: TextLine) => regionKind(line) !== null;

export function OcrPlayground() {
  const router = useRouter();
  const inputId = useId();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [config, setConfig] = useState<Record<Engine, EngineStatus> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [engines, setEngines] = useState<Set<Engine>>(new Set<Engine>(["hunyuan", "paddle", "paddle-llm", "mistral", "nemotron-v1", "nemotron-v2", "llm", "groq", "hybrid"]));
  const [boxFormat, setBoxFormat] = useState("");
  const [tiles, setTiles] = useState("");
  const [structure, setStructure] = useState(true);
  const [enhance, setEnhance] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/ocr")
      .then((response) => response.json())
      .then(setConfig)
      .catch(() => setConfig(null));
    return () => abort.current?.abort();
  }, []);

  // Release page previews when they're replaced.
  useEffect(() => () => pages.forEach((page) => URL.revokeObjectURL(page.url)), [pages]);

  function pickFile(picked: File | undefined) {
    if (!picked) return;
    if (!ACCEPTED_TYPES.includes(picked.type)) return setError("Choose a PDF, PNG or JPG file.");
    if (picked.size > MAX_FILE_BYTES) return setError("That file is larger than 10MB.");
    setError(null);
    setFile(picked);
  }

  function toggleEngine(engine: Engine) {
    setEngines((current) => {
      const next = new Set(current);
      if (!next.delete(engine)) next.add(engine);
      return next;
    });
  }

  async function run() {
    if (!file || engines.size === 0) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setCells({});

    try {
      const prepared = await prepareDocument(file);
      if (controller.signal.aborted) return;
      const nextPages = prepared.map((page) => ({
        url: URL.createObjectURL(page.image),
        image: page.image,
        width: page.width,
        height: page.height,
        truth: page.lines,
      }));
      setPages(nextPages);

      const selectedEngines = ENGINES.filter(({ id }) => engines.has(id));
      const jobs = nextPages.flatMap((page, index) => selectedEngines.map((engine) => ({ page, index, engine })));
      setCells(Object.fromEntries(jobs.map((job) => [`${job.index}-${job.engine.id}`, { status: "running" } as Cell])));

      // HunyuanOCR and Hybrid share llama-server, which handles one request at
      // a time, so they go through one queue. PaddleOCR (CPU) and the cloud
      // services run alongside it.
      const llmOptions = { boxFormat, tiles, structure, enhance };
      await Promise.all(
        (["server", "paddle", "mistral", "nvidia", "llm", "groq"] as const).map(async (queue) => {
          for (const job of jobs.filter((candidate) => candidate.engine.queue === queue)) {
            if (controller.signal.aborted) return;
            const image = queue === "server" ? await downscale(job.page.image, HUNYUAN_MAX_EDGE) : job.page.image;
            const cell = await runOcr(image, job.index, job.engine.id, llmOptions, controller.signal);
            if (!controller.signal.aborted) {
              setCells((current) => ({ ...current, [`${job.index}-${job.engine.id}`]: cell }));
            }
          }
        }),
      );
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof PrepareError ? failure.message : "The file could not be prepared.");
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  const selected = ENGINES.filter(({ id }) => engines.has(id));
  const shownEngines = ENGINES.filter(({ id }) => pages.some((_, index) => cells[`${index}-${id}`]));
  const columns = (shownEngines.length ? shownEngines : selected).length;
  const selectClass =
    "rounded-full border border-line bg-off-white px-3 py-2 text-[13px] leading-[1.4] tracking-[-0.52px] text-ink disabled:opacity-40";

  return (
    <AppShell
      variant="loading"
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
      onBack={() => router.push("/")}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-y-auto">
        <section className="flex flex-col gap-4 rounded-3xl bg-white p-5 lg:p-6">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[rgba(255,147,80,0.15)] text-primary">
              <ScanText size={22} aria-hidden />
            </span>
            <div>
              <h1 className="text-[24px] leading-[1.2] font-bold tracking-[-0.96px] text-ink-strong">
                OCR comparison
              </h1>
              <p className="text-[14px] leading-[1.4] tracking-[-0.56px] text-muted">
                Compare the page readers the grading pipeline can use. Upload a typed PDF to get an accuracy score
                against its own text layer. Nothing here is saved or graded.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor={inputId}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-line bg-off-white px-4 py-2.5 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary"
            >
              <input
                id={inputId}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                className="sr-only"
                onChange={(event) => {
                  pickFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <Upload size={16} aria-hidden />
              <span className="max-w-[240px] truncate">{file ? file.name : "Choose a PDF or image"}</span>
            </label>

            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="sr-only">OCR engines</legend>
              {ENGINES.map(({ id, label, tag }) => {
                const status = config?.[id];
                return (
                  <label
                    key={id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-[14px] leading-[1.4] tracking-[-0.56px]",
                      engines.has(id) ? "border-ink bg-white text-ink" : "border-line bg-off-white text-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={engines.has(id)}
                      onChange={() => toggleEngine(id)}
                      className="accent-[#303030]"
                    />
                    <span aria-hidden className={cn("size-2.5 rounded-full", tag)} />
                    <span className="font-semibold">{label}</span>
                    {status?.model && <span className="text-[12px] text-muted/80">{status.model}</span>}
                  </label>
                );
              })}
            </fieldset>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Vision LLM box format"
                value={boxFormat}
                onChange={(event) => setBoxFormat(event.target.value)}
                disabled={!engines.has("llm")}
                className={selectClass}
              >
                {BOX_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === "" && config?.llm.boxFormat ? `Box format: .env (${config.llm.boxFormat})` : option.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Vision LLM strips per page"
                value={tiles}
                onChange={(event) => setTiles(event.target.value)}
                disabled={!engines.has("llm")}
                className={selectClass}
              >
                {TILE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === "" ? `Strips: .env (${config?.llm.tiles ?? 1})` : `${value} ${value === "1" ? "strip" : "strips"}`}
                  </option>
                ))}
              </select>
              <label
                className={cn(
                  "flex items-center gap-2 rounded-full border border-line bg-off-white px-3 py-2 text-[13px] leading-[1.4] tracking-[-0.52px] text-ink",
                  !(engines.has("nemotron-v1") || engines.has("nemotron-v2")) && "opacity-40",
                )}
                title="Find tables with NVIDIA page-elements and drawings with the vision LLM, alongside Nemotron's text."
              >
                <input
                  type="checkbox"
                  checked={structure}
                  onChange={(event) => setStructure(event.target.checked)}
                  disabled={!(engines.has("nemotron-v1") || engines.has("nemotron-v2"))}
                  className="accent-[#303030]"
                />
                Nemotron: diagrams &amp; tables
              </label>
              <label
                className="flex items-center gap-2 rounded-full border border-line bg-off-white px-3 py-2 text-[13px] leading-[1.4] tracking-[-0.52px] text-ink"
                title="Raise contrast (×1.3) and brightness (+15) before every engine reads the page."
              >
                <input
                  type="checkbox"
                  checked={enhance}
                  onChange={(event) => setEnhance(event.target.checked)}
                  className="accent-[#303030]"
                />
                Enhance page
              </label>
            </div>

            <button
              type="button"
              onClick={run}
              disabled={!file || engines.size === 0 || running}
              className="flex items-center gap-2 rounded-full border-2 border-white/15 bg-ink px-5 py-2.5 text-[14px] leading-[1.4] font-medium tracking-[-0.56px] text-white disabled:opacity-30 lg:ml-auto"
            >
              {running && <LoaderCircle size={16} aria-hidden className="animate-spin" />}
              {running ? "Running OCR…" : "Run OCR"}
            </button>
          </div>

          {config?.paddle && !config.paddle.configured && (engines.has("paddle") || engines.has("paddle-llm")) && (
            <p className="rounded-xl bg-[rgba(255,153,0,0.1)] px-4 py-3 text-[13px] leading-[1.5] tracking-[-0.52px] text-ink">
              PaddleOCR isn’t available{config.paddle.error ? ` (${config.paddle.error})` : ""}. It runs inside{" "}
              <code className="font-mono">OCR_server</code>: start it with{" "}
              <code className="font-mono">python OCR_server/ocr_server.py start</code> (it installs PaddleOCR on first run).
            </p>
          )}
          {config?.mistral && !config.mistral.configured && engines.has("mistral") && (
            <p className="rounded-xl bg-[rgba(255,153,0,0.1)] px-4 py-3 text-[13px] leading-[1.5] tracking-[-0.52px] text-ink">
              Mistral OCR needs <code className="font-mono">MISTRAL_API_KEY</code> in{" "}
              <code className="font-mono">.env.local</code> (restart the dev server after adding it).
            </p>
          )}
          {config?.["nemotron-v1"] &&
            !config["nemotron-v1"].configured &&
            (engines.has("nemotron-v1") || engines.has("nemotron-v2")) && (
              <p className="rounded-xl bg-[rgba(255,153,0,0.1)] px-4 py-3 text-[13px] leading-[1.5] tracking-[-0.52px] text-ink">
                Nemotron OCR needs <code className="font-mono">NVIDIA_API_KEY</code> in{" "}
                <code className="font-mono">.env.local</code> (a key from build.nvidia.com).
              </p>
            )}
          {config?.groq && !config.groq.configured && engines.has("groq") && (
            <p className="rounded-xl bg-[rgba(255,153,0,0.1)] px-4 py-3 text-[13px] leading-[1.5] tracking-[-0.52px] text-ink">
              Groq isn’t available{config.groq.error ? ` (${config.groq.error})` : ""}. Set{" "}
              <code className="font-mono">GROQ_API_KEY</code> in <code className="font-mono">.env.local</code>.
            </p>
          )}
          {config && !config.hunyuan.configured && (engines.has("hunyuan") || engines.has("hybrid")) && (
            <p className="rounded-xl bg-[rgba(255,153,0,0.1)] px-4 py-3 text-[13px] leading-[1.5] tracking-[-0.52px] text-ink">
              HunyuanOCR isn’t configured yet. Start <code className="font-mono">OCR_server</code> (
              <code className="font-mono">python OCR_server/ocr_server.py start</code>) and set{" "}
              <code className="font-mono">HUNYUAN_OCR_BASE_URL</code> in <code className="font-mono">.env.local</code>.
            </p>
          )}
          {error && (
            <p role="alert" className="text-[14px] leading-[1.4] tracking-[-0.56px] text-danger">
              {error}
            </p>
          )}
        </section>

        {pages.map((page, index) => (
          <section key={page.url} aria-label={`Page ${index + 1}`} className="flex flex-col gap-3 rounded-3xl bg-white/60 p-3 lg:p-4">
            <h2 className="px-1 text-[16px] leading-[1.4] font-bold tracking-[-0.64px] text-ink">
              Page {index + 1}
              <span className="font-normal text-muted/80">
                {" "}
                · {page.width}×{page.height}px
                {page.truth ? ` · text layer: ${page.truth.length} lines (used to score boxes)` : " · no text layer (no score)"}
              </span>
            </h2>
            <div
              className={cn(
                "grid gap-3",
                columns > 1 && "lg:grid-cols-2",
                (columns === 3 || columns === 6) && "2xl:grid-cols-3",
                (columns === 4 || columns > 6) && "2xl:grid-cols-4",
                columns === 5 && "2xl:grid-cols-5",
              )}
            >
              {(shownEngines.length ? shownEngines : selected).map((engine) => (
                <EngineColumn key={engine.id} page={page} engine={engine} cell={cells[`${index}-${engine.id}`]} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </AppShell>
  );
}

async function runOcr(
  image: Blob,
  index: number,
  engine: Engine,
  llmOptions: { boxFormat: string; tiles: string; structure: boolean; enhance: boolean },
  signal: AbortSignal,
): Promise<Cell> {
  const body = new FormData();
  body.append("image", new File([image], `page-${index + 1}.jpg`, { type: "image/jpeg" }));
  body.append("engine", engine);
  if (llmOptions.enhance) body.append("enhance", "1");
  if (engine.startsWith("nemotron") && !llmOptions.structure) body.append("structure", "0");
  if (engine === "llm") {
    if (llmOptions.boxFormat) body.append("boxFormat", llmOptions.boxFormat);
    if (llmOptions.tiles) body.append("tiles", llmOptions.tiles);
  }
  try {
    const response = await fetch("/api/ocr", { method: "POST", body, signal });
    const data = await response.json();
    return response.ok ? { status: "done", result: data } : { status: "error", error: data.error ?? `Failed (${response.status})` };
  } catch {
    return { status: "error", error: signal.aborted ? "Cancelled." : "Could not reach the server." };
  }
}

function EngineColumn({
  page,
  engine,
  cell,
}: {
  page: Page;
  engine: (typeof ENGINES)[number];
  cell: Cell | undefined;
}) {
  const [active, setActive] = useState<number | null>(null);
  const lines = cell?.status === "done" ? cell.result.lines : [];
  const score = cell?.status === "done" && page.truth ? scoreAgainstTruth(page.truth, lines.filter((line) => !isDiagram(line))) : null;

  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-[20px] border-[1.25px] border-black/10 bg-white">
      <header className="flex flex-col gap-1 bg-ink px-4 py-3 text-white">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden className={cn("size-2.5 rounded-full", engine.tag)} />
          <span className="text-[16px] leading-[1.4] font-bold tracking-[-0.64px]">{engine.label}</span>
          {cell?.status === "done" && (
            <span className="text-[13px] text-white/70">
              {(cell.result.durationMs / 1000).toFixed(1)}s · {lines.length} lines
              {cell.result.settings ? ` · ${cell.result.settings}` : ""}
            </span>
          )}
          {cell?.status === "running" && (
            <span className="flex items-center gap-1.5 text-[13px] text-white/70">
              <LoaderCircle size={14} aria-hidden className="animate-spin" /> Reading…
            </span>
          )}
        </div>
        {cell?.status === "done" && <span className="text-[12px] text-white/50">{cell.result.model}</span>}
        {score && (
          <span
            className="self-start rounded-full bg-white/10 px-2.5 py-0.5 text-[12px] font-semibold"
            title="Boxes compared with the PDF's text layer: mean intersection-over-union of matched lines, and lines overlapping at least 50%."
          >
            Box accuracy: IoU {score.meanIoU.toFixed(2)} · {score.goodBoxes}/{score.truthLines} lines ≥ 0.5
            {score.matched < score.truthLines ? ` · ${score.truthLines - score.matched} not read` : ""}
          </span>
        )}
      </header>

      {cell?.status === "error" && (
        <p role="alert" className="bg-[#ffe9e2] px-4 py-2 text-[13px] leading-[1.4] text-danger">
          {cell.error}
        </p>
      )}
      {cell?.status === "done" &&
        cell.result.warnings.map((warning) => (
          <p key={warning} className="bg-[rgba(255,153,0,0.1)] px-4 py-2 text-[13px] leading-[1.4] text-warning">
            {warning}
          </p>
        ))}

      <div className="relative">
        <Image
          src={page.url}
          alt=""
          width={page.width}
          height={page.height}
          unoptimized
          className="block h-auto w-full"
        />
        {lines.map((line, index) => (
          <div
            key={index}
            aria-hidden
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
            className={cn(
              "absolute rounded-[3px] border",
              engine.box,
              isDiagram(line) && "border-2 border-dashed",
              active === index ? "border-2 opacity-100" : "opacity-80",
            )}
            style={{
              left: `${line.box.x * 100}%`,
              top: `${line.box.y * 100}%`,
              width: `${line.box.w * 100}%`,
              height: `${line.box.h * 100}%`,
            }}
          >
            {(active === index || isDiagram(line)) && (
              <span className={cn("absolute -top-5 left-0 rounded px-1 text-[11px] font-bold whitespace-nowrap text-white", engine.tag)}>
                {isDiagram(line) ? `${index + 1} · ${regionKind(line)}` : index + 1}
              </span>
            )}
          </div>
        ))}
      </div>

      {lines.length > 0 && (
        <ol className="max-h-72 overflow-y-auto border-t border-black/5 py-1 text-[13px] leading-[1.4] tracking-[-0.52px]">
          {lines.map((line, index) => (
            <li
              key={index}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              className={cn("flex gap-2 px-4 py-1", active === index && "bg-off-white")}
            >
              <span className="w-6 shrink-0 text-right text-muted/60">{index + 1}</span>
              <span className={cn("min-w-0", isDiagram(line) ? "font-medium text-[#0f9d76]" : "text-ink")}>{line.text}</span>
            </li>
          ))}
        </ol>
      )}

      {cell?.status === "done" && cell.result.raw !== null && (
        <details className="border-t border-black/5 px-4 py-2 text-[13px]">
          <summary className="cursor-pointer font-semibold text-muted">Raw model output</summary>
          <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-off-white p-3 text-[12px] whitespace-pre-wrap text-ink">
            {cell.result.raw}
          </pre>
        </details>
      )}
    </article>
  );
}
