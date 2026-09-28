import {
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoSuchModelError,
  NoSuchProviderError,
} from "ai";
import { after } from "next/server";
import { getModel, getModelId } from "@/lib/ai/models";
import { getOcrEngine, getVisionSettings } from "@/lib/ai/vision-settings";
import { JobWriter, newJobId } from "@/lib/extraction/jobs";
import { runExtraction, UserFacingError } from "@/lib/extraction/pipeline";
import { extractionRequestSchema, type ExtractionRequest } from "@/lib/extraction/request-schema";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError } from "@/lib/ocr/http";
import { createPageReader } from "@/lib/ocr/readers";
import { downloadExamFile } from "@/lib/supabase-admin";

// A run takes minutes (page reading, then several model calls), so it runs
// after the response, for up to maxDuration. On Vercel, values above 300 need
// Fluid compute on a Pro plan; lower this on Hobby.
export const maxDuration = 800;

/**
 * Starts an extraction and returns its job id straight away (202). The page
 * polls GET /api/extract/<jobId> for progress and the result.
 */
export async function POST(req: Request) {
  const parsed = extractionRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const jobId = newJobId(parsed.data.submissionId);
  const job = new JobWriter(jobId);
  try {
    await job.start();
  } catch (error) {
    console.error("Could not start the extraction job", error);
    return Response.json({ error: describeError(error) }, { status: 500 });
  }
  after(() => runJob(parsed.data, job));
  return Response.json({ jobId }, { status: 202, headers: { "Cache-Control": "no-store" } });
}

async function runJob(request: ExtractionRequest, job: JobWriter) {
  // Built on first use, so typed PDFs never need a vision model or the OCR server.
  let readPage: ((image: Uint8Array) => Promise<TextLine[]>) | undefined;
  try {
    const result = await runExtraction(request, {
      textModel: getModel("text"),
      readPage: (image) => {
        readPage ??= createPageReader(getOcrEngine(), { model: getModel("vision"), ...getVisionSettings() });
        return readPage(image);
      },
      loadPageImage: downloadExamFile,
      onProgress: (event) => {
        if (event.type === "progress") job.progress(event);
      },
    });
    await job.finish(result);
  } catch (error) {
    console.error("Extraction failed", error);
    await job.fail(describeError(error)).catch((writeError) => console.error("Could not save the failure", writeError));
  }
}

// Configuration problems are spelled out, since whoever runs the app needs to
// fix them in .env; anything else gets a generic message.
function describeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;
  if (error instanceof OcrServiceError) return `Reading the scanned pages failed: ${error.message}`;
  if (error instanceof Error && /^(AI_OCR_ENGINE|AI_OCR_ENHANCE|AI_REASONING|Box format) must/.test(error.message)) return error.message;
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
  if (error instanceof Error && /SUPABASE_SECRET_KEY|from storage|storage bucket|extraction progress/.test(error.message)) {
    return error.message;
  }
  return "Something went wrong while processing the files. Please try again.";
}
