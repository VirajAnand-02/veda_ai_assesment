import { readJob } from "@/lib/extraction/jobs";

// The page polls this for an extraction's progress and result (see POST /api/extract).
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
