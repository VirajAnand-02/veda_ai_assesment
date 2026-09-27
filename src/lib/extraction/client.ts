import type { ExtractionRequest } from "./request-schema";
import type { ExtractionEvent, ExtractionResult } from "./types";

/** Calls the extraction route and reports its progress events as they arrive. */
export async function requestExtraction(
  body: ExtractionRequest,
  { signal, onEvent }: { signal: AbortSignal; onEvent: (event: ExtractionEvent) => void },
): Promise<ExtractionResult> {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`The extraction request failed (${response.status}).`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = done ? "" : lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ExtractionEvent;
      if (event.type === "error") throw new ExtractionError(event.message);
      if (event.type === "result") return event.result;
      onEvent(event);
    }
    if (done) break;
  }
  throw new Error("The extraction stopped before it finished.");
}

/** A failure the server described; its message is meant for the user. */
export class ExtractionError extends Error {}
