import "server-only";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError, requestJson } from "./http";
import { mergeWordsIntoLines } from "./merge-lines";
import { parsePaddleSegments, type PaddleResponse } from "./parse-paddle";

// Client for the OCR server's PaddleOCR route (OCR_server/gateway.py):
// PP-OCR detection + recognition on CPU, ~2–4 s per page.
//   PADDLE_OCR_URL=http://127.0.0.1:8090/paddle   (default: HUNYUAN_OCR_BASE_URL's server + /paddle)
//   PADDLE_OCR_API_KEY=...                          (default: HUNYUAN_OCR_API_KEY, same server)

export function getPaddleConfig(): { url: string; apiKey: string | undefined } | null {
  const explicit = process.env.PADDLE_OCR_URL?.trim().replace(/\/+$/, "");
  const hunyuan = process.env.HUNYUAN_OCR_BASE_URL?.trim();
  let url = explicit;
  if (!url && hunyuan) {
    try {
      url = `${new URL(hunyuan).origin}/paddle`;
    } catch {
      url = undefined;
    }
  }
  if (!url) return null;
  return { url, apiKey: process.env.PADDLE_OCR_API_KEY?.trim() || process.env.HUNYUAN_OCR_API_KEY?.trim() || undefined };
}

export async function readWithPaddle(
  image: Uint8Array,
  mediaType: string,
  signal?: AbortSignal,
): Promise<{ lines: TextLine[]; segments: TextLine[]; model: string; serverMs: number | null }> {
  const config = getPaddleConfig();
  if (!config) {
    throw new OcrServiceError(
      "PaddleOCR is not configured. Start OCR_server and set PADDLE_OCR_URL (or HUNYUAN_OCR_BASE_URL) in .env.local.",
    );
  }
  const response = await requestJson(
    "POST",
    `${config.url}/ocr`,
    { image: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` },
    { apiKey: config.apiKey, signal, service: "PaddleOCR" },
  );
  let data: PaddleResponse & { error?: string };
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new OcrServiceError(`PaddleOCR returned a response that isn't JSON (${response.status}).`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new OcrServiceError(
      response.status === 401
        ? "PaddleOCR rejected the API key. Check PADDLE_OCR_API_KEY / HUNYUAN_OCR_API_KEY."
        : response.status === 404
          ? "This OCR server has no /paddle route. Update OCR_server and restart it."
          : `PaddleOCR failed (${response.status}): ${data.error ?? "unknown error"}`,
    );
  }
  const segments = parsePaddleSegments(data);
  return { lines: mergeWordsIntoLines(segments), segments, model: data.model ?? "PaddleOCR", serverMs: data.durationMs ?? null };
}

/** Whether the route answers, for the /ocr page's engine list. */
export async function paddleStatus(): Promise<{ configured: boolean; model?: string; error?: string }> {
  const config = getPaddleConfig();
  if (!config) return { configured: false, error: "Not configured" };
  try {
    const response = await requestJson("GET", `${config.url}/health`, undefined, {
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(3000),
      service: "PaddleOCR",
    });
    const data = JSON.parse(response.body) as { ready?: boolean; model?: string; error?: string };
    return data.ready ? { configured: true, model: data.model } : { configured: false, error: data.error };
  } catch (error) {
    return { configured: false, error: error instanceof Error ? error.message : String(error) };
  }
}
