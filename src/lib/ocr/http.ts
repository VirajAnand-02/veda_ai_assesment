import "server-only";
import http from "node:http";
import https from "node:https";

/** OCR service failures whose message is meant for the user. */
export class OcrServiceError extends Error {}

// A page can take minutes on CPU, and a request may also wait for the one
// before it (the local server handles one at a time). fetch() gives up after
// 300 s without response headers, so plain node:http is used with a longer limit.
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

type RequestOptions = {
  /** Sent as a bearer token when set. */
  apiKey?: string;
  signal?: AbortSignal;
  /** Name used in error messages, e.g. "HunyuanOCR". */
  service: string;
  /** Added to the "could not reach" message. */
  unreachableHint?: string;
};

/** JSON request to an OCR server; resolves with the raw status and body. */
export function requestJson(
  method: "GET" | "POST",
  url: string,
  body: object | undefined,
  { apiKey, signal, service, unreachableHint = "Is the OCR server running and the URL correct?" }: RequestOptions,
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const unreachable = () => new OcrServiceError(`Could not reach ${service} at ${target.origin}. ${unreachableHint}`);

  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(
      target,
      {
        method,
        headers: {
          ...(payload !== undefined && {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }),
          ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
        },
        timeout: REQUEST_TIMEOUT_MS,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => reject(unreachable()));
      },
    );
    request.on("timeout", () => request.destroy(new OcrServiceError(`${service} took longer than 30 minutes and was stopped.`)));
    request.on("error", (error) => {
      if (signal?.aborted) reject(error);
      else reject(error instanceof OcrServiceError ? error : unreachable());
    });
    request.end(payload);
  });
}
