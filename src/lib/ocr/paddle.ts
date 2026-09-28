import "server-only";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError, requestJson } from "./http";
import { mergeWordsIntoLines } from "./merge-lines";
import { parsePaddleSegments, type PaddleResponse } from "./parse-paddle";

// Client for the PaddleOCR server in ./OCR_server (python OCR_server/ocr_server.py start):
// PP-OCR detection + recognition on CPU, ~2–5 s per page.
//   PADDLE_OCR_URL=http://127.0.0.1:8090/paddle   (default)
//   PADDLE_OCR_API_KEY=...                          (only if OCR_API_KEY is set in OCR_server/.env)

const DEFAULT_URL = "http://127.0.0.1:8090/paddle";

export function getPaddleConfig(): { url: string; apiKey: string | undefined } {
  return {
    url: (process.env.PADDLE_OCR_URL?.trim() || DEFAULT_URL).replace(/\/+$/, ""),
    apiKey: process.env.PADDLE_OCR_API_KEY?.trim() || undefined,
  };
}

export async function readWithPaddle(
  image: Uint8Array,
  mediaType: string,
  signal?: AbortSignal,
): Promise<{ lines: TextLine[]; segments: TextLine[]; model: string; serverMs: number | null }> {
  const config = getPaddleConfig();
  const response = await requestJson(
    "POST",
    `${config.url}/ocr`,
    { image: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` },
    {
      apiKey: config.apiKey,
      signal,
      service: "PaddleOCR",
      unreachableHint: "Start it with python OCR_server/ocr_server.py start, or set PADDLE_OCR_URL.",
    },
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
        ? "PaddleOCR rejected the API key. Check PADDLE_OCR_API_KEY."
        : response.status === 404
          ? "The OCR server has no /paddle route. Update OCR_server and restart it."
          : `PaddleOCR failed (${response.status}): ${data.error ?? "unknown error"}`,
    );
  }
  const segments = parsePaddleSegments(data);
  return { lines: mergeWordsIntoLines(segments), segments, model: data.model ?? "PaddleOCR", serverMs: data.durationMs ?? null };
}
