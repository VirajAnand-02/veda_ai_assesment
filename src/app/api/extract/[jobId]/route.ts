import { after } from "next/server";
import { JobWriter, readJob } from "@/lib/extraction/jobs";
import { runStep } from "@/lib/extraction/steps";

// Same limit as POST /api/extract: one step per request.
export const maxDuration = 300;

// The page polls this for an extraction's progress and result.
export async function GET(_req: Request, ctx: RouteContext<"/api/extract/[jobId]">) {
  const { jobId } = await ctx.params;
  try {
    const job = await readJob(jobId);
    if (!job) return Response.json({ error: "No such extraction." }, { status: 404 });
    return Response.json(job, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not read the extraction job", error);
    return Response.json({ error: "Could not read the extraction's progress." }, { status: 503 });
  }
}

/**
 * Starts the next step of a job that is waiting for it. The body names the
 * step ({ step }); a step that is already running or done gets 409, so a
 * repeated request never runs a step twice.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/extract/[jobId]">) {
  const started = Date.now();
  const { jobId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { step?: unknown } | null;
  try {
    const job = await readJob(jobId);
    if (!job) return Response.json({ error: "No such extraction." }, { status: 404 });
    if (job.status !== "waiting" || job.step !== body?.step) {
      return Response.json({ error: "That step is not waiting to start.", status: job.status, step: job.step }, { status: 409 });
    }
    const writer = new JobWriter(job.id, job);
    await writer.start();
    after(() => runStep(writer, started));
    return Response.json({ step: job.step }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not start the next extraction step", error);
    return Response.json({ error: "Could not continue the extraction." }, { status: 503 });
  }
}
