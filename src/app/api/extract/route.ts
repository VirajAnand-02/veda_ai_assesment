import {
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoSuchModelError,
  NoSuchProviderError,
} from "ai";
import { getModel, getModelId } from "@/lib/ai/models";
import { getOcrEngine, getVisionSettings } from "@/lib/ai/vision-settings";
import { runExtraction, UserFacingError } from "@/lib/extraction/pipeline";
import { extractionRequestSchema } from "@/lib/extraction/request-schema";
import type { ExtractionEvent, TextLine } from "@/lib/extraction/types";
import { OcrServiceError } from "@/lib/ocr/http";
import { createPageReader } from "@/lib/ocr/readers";
import { downloadExamFile } from "@/lib/supabase-admin";

// Several model calls run in sequence, so allow long requests.
export const maxDuration = 300;

// Streams newline-delimited JSON events: progress updates, then one "result"
// or "error" event.
export async function POST(req: Request) {
  const parsed = extractionRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ExtractionEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away; the abort signal stops the remaining work.
        }
      };

      // Built on first use, so typed PDFs never need a vision model or the OCR server.
      let readPage: ((image: Uint8Array) => Promise<TextLine[]>) | undefined;

      try {
        const result = await runExtraction(parsed.data, {
          textModel: getModel("text"),
          readPage: (image) => {
            readPage ??= createPageReader(getOcrEngine(), {
              model: getModel("vision"),
              ...getVisionSettings(),
              signal: req.signal,
            });
            return readPage(image);
          },
          loadPageImage: downloadExamFile,
          onProgress: send,
          signal: req.signal,
        });
        send({ type: "result", result });
      } catch (error) {
        if (!req.signal.aborted) {
          console.error("Extraction failed", error);
          send({ type: "error", message: describeError(error) });
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Configuration problems are spelled out, since whoever runs the app needs to
// fix them in .env; anything else gets a generic message.
function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof OcrServiceError) return `Reading the scanned pages failed: ${error.message}`;
  if (error instanceof Error && /^(AI_OCR_ENGINE|AI_OCR_ENHANCE|Box format|Tiles) must/.test(error.message)) return error.message;
  if (LoadAPIKeyError.isInstance(error)) return `AI provider is not configured: ${error.message}`;
  if (NoSuchProviderError.isInstance(error) || NoSuchModelError.isInstance(error)) {
    return `Unknown model in AI_MODEL / AI_VISION_MODEL (text: "${getModelId("text")}", vision: "${getModelId("vision")}"). Use "<provider>:<model id>".`;
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? ` (${error.statusCode})` : "";
    if (error.statusCode === 401 || error.statusCode === 403) {
      return `The AI provider rejected the API key${status}. Check the key in .env.local.`;
    }
    if (/image|vision|multimodal|file/i.test(error.message)) {
      return `The vision model "${getModelId("vision")}" could not read the page images${status}. Set AI_VISION_MODEL to a model that accepts images.`;
    }
    return `The AI provider returned an error${status}. Please try again.`;
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    return "The AI model returned an unexpected response. Please try again.";
  }
  if (error instanceof Error && /SUPABASE_SECRET_KEY|from storage/.test(error.message)) {
    return error.message;
  }
  return "Something went wrong while processing the files. Please try again.";
}
