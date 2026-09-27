import "server-only";
import type { TextLine } from "@/lib/extraction/types";
import { OcrServiceError, requestJson } from "./http";
import { parseLayoutOutput, type LayoutRegion } from "./parse-layout";
import { parseSpottingOutput } from "./parse-spotting";

// Client for HunyuanOCR (tencent/HunyuanOCR), a dedicated OCR model served
// through an OpenAI-compatible chat API: your own vLLM or llama.cpp server,
// or a hosted provider. Configure it in .env:
//   HUNYUAN_OCR_BASE_URL=http://127.0.0.1:8000/v1   (required)
//   HUNYUAN_OCR_API_KEY=...                          (if the server needs one)
//   HUNYUAN_OCR_MODEL=tencent/HunyuanOCR             (default)
//   HUNYUAN_OCR_MAX_TOKENS=4096                       (default; keep within the server's context)
// OCR_server/ in this repo runs a local server that matches these defaults.

// The official "spotting_json" prompt from Tencent-Hunyuan/HunyuanOCR
// (inference/utils/tasks.py). The model is trained on this exact wording; it
// asks for every text line in reading order as [{"box": [xmin, ymin, xmax,
// ymax] on 0–1000, "text": ...}].
const SPOTTING_PROMPT =
  "检测并识别图中所有的文字行，请按从上到下、从左到右的阅读顺序进行识别。 " +
  "输出格式为 JSON 数组，每个元素必须包含：" +
  '"box": [xmin, ymin, xmax, ymax]（坐标需归一化到 [0, 1000] 范围内）；' +
  '"text": "识别出的文字内容"。 ' +
  "注意：请直接输出 JSON 数组，不要包含任何多余的描述性文字。";

export type HunyuanConfig = { baseURL: string; apiKey: string | undefined; model: string; maxTokens: number };

export function getHunyuanConfig(): HunyuanConfig | null {
  const baseURL = process.env.HUNYUAN_OCR_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseURL) return null;
  return {
    baseURL,
    apiKey: process.env.HUNYUAN_OCR_API_KEY?.trim() || undefined,
    model: process.env.HUNYUAN_OCR_MODEL?.trim() || "tencent/HunyuanOCR",
    maxTokens: Number(process.env.HUNYUAN_OCR_MAX_TOKENS) || 4096,
  };
}

// The official "layout" prompt: regions in reading order, each with a category
// (paragraph, formula, figure, …) and a box on 0–1000. See parse-layout.ts.
const LAYOUT_PROMPT = "按照阅读顺序解析图中的版式信息。";

export { OcrServiceError };

export async function spotTextWithHunyuan(
  image: Uint8Array,
  mediaType: string,
  signal?: AbortSignal,
): Promise<{ lines: TextLine[]; raw: string; recovered: boolean; truncated: boolean; model: string }> {
  const result = await runHunyuanTask(image, mediaType, SPOTTING_PROMPT, signal);
  return { ...result, ...parseSpottingOutput(result.raw) };
}

/** Page layout: categorised regions, including figures/diagrams, with boxes. */
export async function detectLayoutWithHunyuan(
  image: Uint8Array,
  mediaType: string,
  signal?: AbortSignal,
): Promise<{ regions: LayoutRegion[]; raw: string; truncated: boolean; model: string }> {
  const result = await runHunyuanTask(image, mediaType, LAYOUT_PROMPT, signal);
  return { ...result, regions: parseLayoutOutput(result.raw) };
}

async function runHunyuanTask(
  image: Uint8Array,
  mediaType: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ raw: string; truncated: boolean; model: string }> {
  const config = getHunyuanConfig();
  if (!config) {
    throw new OcrServiceError(
      "HunyuanOCR is not configured. Set HUNYUAN_OCR_BASE_URL (and HUNYUAN_OCR_API_KEY if needed) in .env.local.",
    );
  }

  const base = {
    model: config.model,
    messages: [
      { role: "system", content: "" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: config.maxTokens,
    temperature: 0,
    top_p: 1,
  };
  // vLLM sampling settings recommended by Tencent. Some hosted APIs reject
  // unknown fields, so the request is retried without them if needed.
  const tuned = { ...base, repetition_penalty: 1.08, skip_special_tokens: true };

  const url = `${config.baseURL}/chat/completions`;
  const options = { apiKey: config.apiKey, signal, service: "HunyuanOCR" };
  let response = await requestJson("POST", url, tuned, options);
  if (response.status === 400 || response.status === 422) {
    response = await requestJson("POST", url, base, options);
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = response.body.slice(0, 300);
    throw new OcrServiceError(
      response.status === 401 || response.status === 403
        ? `HunyuanOCR rejected the API key (${response.status}). Check HUNYUAN_OCR_API_KEY.`
        : `HunyuanOCR request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  let data: { choices?: { message?: { content?: string | null }; finish_reason?: string }[] };
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new OcrServiceError("HunyuanOCR returned a response that isn't JSON.");
  }
  const choice = data.choices?.[0];
  return { raw: choice?.message?.content ?? "", truncated: choice?.finish_reason === "length", model: config.model };
}
