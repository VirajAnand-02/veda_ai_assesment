import { APICallError, LoadAPIKeyError } from "ai";
import { getModel, getModelId, modelById } from "@/lib/ai/models";
import { getGroqOcrSettings, getOcrEngine, getVisionSettings } from "@/lib/ai/vision-settings";
import { MAX_FILE_BYTES } from "@/lib/extraction/constants";
import { getHunyuanConfig, OcrServiceError } from "@/lib/ocr/hunyuan";
import { readPageHybrid } from "@/lib/ocr/hybrid";
import { mistralStatus, readWithMistral } from "@/lib/ocr/mistral";
import { nemotronConfigured, nemotronStatus, readWithNemotron } from "@/lib/ocr/nemotron";
import { paddleStatus, readWithPaddle } from "@/lib/ocr/paddle";
import { readWithHunyuan, readWithPaddleAndLlm, readWithVisionModel } from "@/lib/ocr/readers";
import { enhancePage } from "@/lib/ocr/image";
import { readWithStructure } from "@/lib/ocr/structure";

// Standalone OCR endpoint for the /ocr comparison page. It uses the same
// readers as the grading pipeline (/api/extract), so what you measure here is
// what grading gets.

export const maxDuration = 300;

const ENGINES = [
  "hunyuan",
  "llm",
  "hybrid",
  "paddle",
  "paddle-llm",
  "mistral",
  "groq",
  "nemotron-v1",
  "nemotron-v2",
] as const;
type Engine = (typeof ENGINES)[number];

/** Which engines are available and how they're set up, for the page's labels. */
export async function GET() {
  const hunyuan = getHunyuanConfig();
  const paddle = await paddleStatus();
  let vision: { boxFormat: string; tiles: number } | { error: string };
  try {
    const { boxFormat, tiles } = getVisionSettings();
    vision = { boxFormat, tiles };
  } catch (error) {
    vision = { error: error instanceof Error ? error.message : String(error) };
  }
  let gradingEngine: string;
  try {
    gradingEngine = getOcrEngine();
  } catch (error) {
    gradingEngine = error instanceof Error ? error.message : String(error);
  }
  return Response.json({
    hunyuan: hunyuan
      ? { configured: true, model: hunyuan.model, host: new URL(hunyuan.baseURL).host }
      : { configured: false },
    llm: { configured: true, model: getModelId("vision"), ...vision },
    hybrid: { configured: Boolean(hunyuan), model: `${hunyuan?.model ?? "HunyuanOCR"} + ${getModelId("vision")}` },
    paddle,
    "paddle-llm": {
      ...paddle,
      model: `${paddle.model ?? "PaddleOCR"} + ${nemotronConfigured() ? "page-elements + " : ""}${getModelId("vision")}`,
    },
    mistral: mistralStatus(),
    groq: groqStatus(),
    "nemotron-v1": nemotronStatus("nemotron-v1"),
    "nemotron-v2": nemotronStatus("nemotron-v2"),
    gradingEngine,
  });
}

/**
 * multipart/form-data: `image` (JPEG/PNG page), `engine` ("hunyuan" | "llm" |
 * "hybrid" | "paddle" | "paddle-llm" | "mistral" | "groq" | "nemotron-v1" |
 * "nemotron-v2"), for
 * "llm" optionally `boxFormat` and `tiles` to override .env, and for Nemotron
 * `structure=0` to skip finding tables and diagrams. `enhance=1` raises the
 * page's contrast and brightness first.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const image = form?.get("image");
  const engine = form?.get("engine");

  if (!(image instanceof File) || !["image/jpeg", "image/png"].includes(image.type)) {
    return Response.json({ error: "Send a JPEG or PNG page image as `image`." }, { status: 400 });
  }
  if (image.size > MAX_FILE_BYTES) {
    return Response.json({ error: "The page image is larger than 10MB." }, { status: 400 });
  }
  if (!ENGINES.includes(engine as Engine)) {
    return Response.json({ error: `\`engine\` must be one of: ${ENGINES.join(", ")}.` }, { status: 400 });
  }

  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    // enhance=1: contrast and brightness raised before any engine reads the page.
    const enhance = optionalField(form, "enhance") === "1";
    const bytes = enhance ? await enhancePage(new Uint8Array(await image.arrayBuffer())) : new Uint8Array(await image.arrayBuffer());
    const mediaType = enhance ? "image/jpeg" : image.type;
    if (engine === "hunyuan") {
      const result = await readWithHunyuan(bytes, mediaType, req.signal);
      return Response.json({
        engine,
        model: result.model,
        settings: "spotting, words joined into lines",
        lines: result.lines,
        raw: result.raw,
        warnings: [
          ...(result.truncated ? ["Output hit the token limit, so the last lines may be missing."] : []),
          ...(result.recovered ? ["Output wasn't clean JSON; lines were recovered one by one."] : []),
        ],
        durationMs: elapsed(),
      });
    }

    if (engine === "paddle") {
      const result = await readWithPaddle(bytes, mediaType, req.signal);
      return Response.json({
        engine,
        model: result.model,
        settings: `CPU${result.serverMs !== null ? `, ${(result.serverMs / 1000).toFixed(1)}s in the model` : ""}`,
        lines: result.lines,
        raw: null,
        warnings: [],
        durationMs: elapsed(),
      });
    }

    if (engine === "paddle-llm") {
      const vision = getVisionSettings();
      const result = await readWithPaddleAndLlm(bytes, mediaType, {
        model: getModel("vision"),
        boxFormat: vision.boxFormat,
        signal: req.signal,
      });
      return Response.json({
        engine,
        model: `PaddleOCR + ${nemotronConfigured() ? "page-elements + " : ""}${vision.modelId}`,
        settings: `${count(result.tables, "table")}, ${count(result.diagrams, "diagram")}`,
        lines: result.lines,
        raw: null,
        warnings: result.warnings,
        durationMs: elapsed(),
      });
    }

    if (engine === "nemotron-v1" || engine === "nemotron-v2") {
      const text = readWithNemotron(bytes, mediaType, engine, req.signal);
      if (optionalField(form, "structure") === "0") {
        const result = await text;
        return Response.json({
          engine,
          model: result.model,
          settings: "text only",
          lines: result.lines,
          raw: null,
          warnings: [],
          durationMs: elapsed(),
        });
      }
      const vision = getVisionSettings();
      const result = await readWithStructure(
        bytes,
        mediaType,
        text,
        { model: getModel("vision"), boxFormat: vision.boxFormat, signal: req.signal },
      );
      return Response.json({
        engine,
        model: `${(await text).model} + page-elements + ${vision.modelId}`,
        settings: `${count(result.tables, "table")}, ${count(result.diagrams, "diagram")}`,
        lines: result.lines,
        raw: null,
        warnings: result.warnings,
        durationMs: elapsed(),
      });
    }

    if (engine === "mistral") {
      const result = await readWithMistral(bytes, mediaType, req.signal);
      return Response.json({
        engine,
        model: result.model,
        settings: "paragraph boxes",
        lines: result.lines,
        raw: result.markdown,
        warnings: result.warnings,
        durationMs: elapsed(),
      });
    }

    if (engine === "groq") {
      const groq = getGroqOcrSettings();
      if (!groq.configured) {
        return Response.json({ error: "Groq isn't configured. Set GROQ_API_KEY in .env.local." }, { status: 400 });
      }
      const lines = await readWithVisionModel(bytes, {
        model: modelById(groq.modelId),
        boxFormat: groq.boxFormat,
        tiles: groq.tiles,
        signal: req.signal,
      });
      return Response.json({
        engine,
        model: groq.modelId,
        settings: `${groq.boxFormat}, ${groq.tiles} ${groq.tiles === 1 ? "tile" : "tiles"}`,
        lines,
        raw: null,
        warnings: [],
        durationMs: elapsed(),
      });
    }

    if (engine === "hybrid") {
      const result = await readPageHybrid(bytes, mediaType, { describeModel: getModel("vision"), signal: req.signal });
      return Response.json({
        engine,
        model: `${getHunyuanConfig()?.model ?? "HunyuanOCR"} + ${getModelId("vision")}`,
        settings: `${result.diagrams} diagram${result.diagrams === 1 ? "" : "s"} found`,
        lines: result.lines,
        raw: null,
        warnings: result.warnings,
        durationMs: elapsed(),
      });
    }

    const settings = getVisionSettings({
      boxFormat: optionalField(form, "boxFormat"),
      tiles: optionalField(form, "tiles"),
    });
    const lines = await readWithVisionModel(bytes, {
      model: getModel("vision"),
      boxFormat: settings.boxFormat,
      tiles: settings.tiles,
      signal: req.signal,
    });
    return Response.json({
      engine,
      model: settings.modelId,
      settings: `${settings.boxFormat}, ${settings.tiles} ${settings.tiles === 1 ? "tile" : "tiles"}`,
      lines,
      raw: null,
      warnings: [],
      durationMs: elapsed(),
    });
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error(`OCR (${engine}) failed`, error);
    return Response.json(
      { error: describeError(error, engine === "groq" ? getGroqOcrSettings().modelId : getModelId("vision")) },
      { status: 502 },
    );
  }
}

function groqStatus() {
  try {
    const { configured, modelId, boxFormat, tiles } = getGroqOcrSettings();
    return configured
      ? { configured, model: modelId, boxFormat, tiles }
      : { configured, model: modelId, error: "GROQ_API_KEY is not set" };
  } catch (error) {
    return { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function optionalField(form: FormData | null, name: string) {
  const value = form?.get(name);
  return typeof value === "string" && value.trim() ? value : null;
}

function describeError(error: unknown, modelId: string) {
  if (error instanceof OcrServiceError) return error.message;
  if (LoadAPIKeyError.isInstance(error)) return `AI provider is not configured: ${error.message}`;
  if (APICallError.isInstance(error)) {
    const rateLimited =
      error.statusCode !== 429
        ? ""
        : modelId.startsWith("groq:")
          ? " Groq's rate limit was reached: its free tier allows about 1,000 output tokens per minute for this model, roughly one page. Wait a minute and retry."
          : " Rate limit reached; wait a minute and retry.";
    return `The vision model "${modelId}" returned an error${error.statusCode ? ` (${error.statusCode})` : ""}.${rateLimited}`;
  }
  if (error instanceof Error && /must be/.test(error.message)) return error.message;
  return "OCR failed. Please try again.";
}
