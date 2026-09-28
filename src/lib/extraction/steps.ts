import "server-only";
import {
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  NoSuchModelError,
  NoSuchProviderError,
} from "ai";
import { getModel, getModelId } from "@/lib/ai/models";
import { getOcrEngine, getVisionSettings } from "@/lib/ai/vision-settings";
import { OcrServiceError } from "@/lib/ocr/http";
import { createPageReader } from "@/lib/ocr/readers";
import { downloadExamFile } from "@/lib/supabase-admin";
import { deleteRunState, loadRunState, saveRunState, type JobWriter } from "./jobs";
import { advanceExtraction, UserFacingError, type RunState } from "./pipeline";
import type { TextLine } from "./types";

// Each step of an extraction is one request (POST /api/extract starts step 0,
// POST /api/extract/<id> the next ones), so each must end within the route's
// maxDuration (300 s, the Vercel Hobby limit). A step starts units of work only
// while they should still finish in time (pipeline.ts), and anything still
// running at the hard limit is cut off and redone in the next step.

/** No unit starts unless it should finish by now (from the start of the request). */
const STEP_DEADLINE_MS = 270_000;
/** Work still running now is stopped, leaving time to save before maxDuration. */
const STEP_HARD_LIMIT_MS = 285_000;
/** Steps in a row that may run out of time without finishing any unit. */
const MAX_STALLS = 2;

/** Runs one step of a job: loads its state, does what fits, saves it. */
export async function runStep(job: JobWriter, requestStarted: number) {
  const signal = AbortSignal.timeout(Math.max(1_000, requestStarted + STEP_HARD_LIMIT_MS - Date.now()));
  try {
    const state = await loadRunState<RunState>(job.id);
    if (!state) throw new UserFacingError("This extraction's saved progress is missing. Please try again.");
    const done = state.unitsDone;

    // Built on first use, so typed PDFs never need a vision model or the OCR server.
    let readPage: ((image: Uint8Array) => Promise<TextLine[]>) | undefined;
    const deps = {
      textModel: getModel("text"),
      readPage: (image: Uint8Array) => {
        readPage ??= createPageReader(getOcrEngine(), { model: getModel("vision"), ...getVisionSettings() });
        return readPage(image);
      },
      loadPageImage: downloadExamFile,
      onProgress: job.progress.bind(job),
      signal,
    };

    let result;
    try {
      result = await advanceExtraction(state, deps, requestStarted + STEP_DEADLINE_MS);
    } catch (error) {
      if (!signal.aborted) throw error;
      // Out of time mid-unit: the unit is redone next step, unless steps keep stalling.
      state.stalls = state.unitsDone > done ? 0 : state.stalls + 1;
      console.warn(`Extraction step ${job.step} ran out of time (${state.stalls} in a row without progress).`);
      if (state.stalls >= MAX_STALLS) {
        throw new UserFacingError("Part of the extraction takes longer than the server allows. Please try again.");
      }
    }

    if (result) {
      await job.finish(result);
      await deleteRunState(job.id).catch((error) => console.warn("Could not delete the run state.", error));
      return;
    }
    if (!signal.aborted) state.stalls = 0;
    await saveRunState(job.id, state);
    await job.pause();
  } catch (error) {
    console.error("Extraction failed", error);
    await job.fail(describeError(error)).catch((writeError) => console.error("Could not save the failure", writeError));
  }
}

// Configuration problems are spelled out, since whoever runs the app needs to
// fix them in .env; anything else gets a generic message.
export function describeError(error: unknown): string {
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
