import type { ExtractionRequest } from "./request-schema";
import type { ExtractionEvent, ExtractionJob, ExtractionResult } from "./types";

// Polls a little more often early on, while stages finish quickly.
const FAST_POLL_MS = 1500;
const SLOW_POLL_MS = 3000;
const FAST_POLL_FOR_MS = 60_000;
/** Consecutive failed polls (network blips) tolerated before giving up. */
const MAX_POLL_FAILURES = 5;

/**
 * Starts an extraction job, then polls it, reporting progress events as they
 * appear, until it finishes. The job runs in steps (each within the server's
 * time limit); when one ends, this starts the next. Aborting stops after the
 * step that is running.
 */
export async function requestExtraction(
  body: ExtractionRequest,
  { signal, onEvent }: { signal: AbortSignal; onEvent: (event: ExtractionEvent) => void },
): Promise<ExtractionResult> {
  const started = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const { jobId, error } = (await started.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!started.ok || !jobId) {
    if (error && started.status >= 500) throw new ExtractionError(error);
    throw new Error(`The extraction request failed (${started.status}).`);
  }

  const since = Date.now();
  let seen = 0;
  let failures = 0;
  for (;;) {
    await wait(Date.now() - since < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS, signal);
    let job: ExtractionJob;
    try {
      const response = await fetch(`/api/extract/${encodeURIComponent(jobId)}`, { cache: "no-store", signal });
      if (response.status === 404) throw new ExtractionError("The extraction could not be found. Please try again.");
      if (!response.ok) throw new Error(`Polling failed (${response.status}).`);
      job = (await response.json()) as ExtractionJob;
      failures = 0;
    } catch (failure) {
      if (signal.aborted || failure instanceof ExtractionError || ++failures > MAX_POLL_FAILURES) throw failure;
      continue;
    }

    for (const event of job.events.slice(seen)) onEvent(event);
    seen = job.events.length;
    if (job.status === "done" && job.result) return job.result;
    if (job.status === "error") throw new ExtractionError(job.error ?? "The extraction failed. Please try again.");
    if (job.status === "waiting") {
      try {
        await startStep(jobId, job.step, signal);
      } catch (failure) {
        if (signal.aborted || ++failures > MAX_POLL_FAILURES) throw failure;
      }
    }
  }
}

async function startStep(jobId: string, step: number, signal: AbortSignal) {
  const response = await fetch(`/api/extract/${encodeURIComponent(jobId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step }),
    signal,
  });
  // 409: already started (or finished); the next poll shows how it's going.
  if (!response.ok && response.status !== 409) throw new Error(`Could not continue the extraction (${response.status}).`);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** A failure the server described; its message is meant for the user. */
export class ExtractionError extends Error {}
