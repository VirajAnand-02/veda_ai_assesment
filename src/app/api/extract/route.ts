import { after } from "next/server";
import { JobWriter, newJobId, saveRunState } from "@/lib/extraction/jobs";
import { newRunState } from "@/lib/extraction/pipeline";
import { extractionRequestSchema } from "@/lib/extraction/request-schema";
import { describeError, runStep } from "@/lib/extraction/steps";

// A run takes minutes, so it runs in steps that each fit this limit (the
// Vercel Hobby maximum; lib/extraction/steps.ts keeps each step under it).
export const maxDuration = 300;

/**
 * Starts an extraction: saves the request as the job's state, runs the first
 * step after the response, and returns the job id straight away (202). The
 * page polls GET /api/extract/<jobId> and starts each further step with
 * POST /api/extract/<jobId>.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const parsed = extractionRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }

  const job = new JobWriter(newJobId(parsed.data.submissionId));
  try {
    await saveRunState(job.id, newRunState(parsed.data));
    await job.start();
  } catch (error) {
    console.error("Could not start the extraction job", error);
    return Response.json({ error: describeError(error) }, { status: 500 });
  }
  after(() => runStep(job, started));
  return Response.json({ jobId: job.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
