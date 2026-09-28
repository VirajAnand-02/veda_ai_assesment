import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { ExtractionJob, ExtractionResult, ProgressEvent } from "./types";

// Extraction runs as a job the page polls, instead of one long streamed
// request. Two small JSON files per job live in a private Supabase bucket, so
// any server instance can pick them up: "<id>.json" is what the page polls
// (status, progress, result), "<id>.state.json" the run's work so far, kept
// between steps. The bucket is created on first use.

const JOBS_BUCKET = "extraction-jobs";
/** A running job rewrites its file at least this often. */
const HEARTBEAT_MS = 20_000;
/** Progress writes are coalesced to at most one per this interval. */
const WRITE_INTERVAL_MS = 700;
/** A running job not written for this long has stopped (crashed or timed out). */
export const STALE_MS = 90_000;

const JOB_ID = /^[A-Za-z0-9-]{8,64}\.[a-z0-9]{10}$/;

export function newJobId(submissionId: string) {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
  return `${submissionId}.${suffix}`;
}

export const isJobId = (value: string) => JOB_ID.test(value);

const jobPath = (id: string) => `${id}.json`;
const statePath = (id: string) => `${id}.state.json`;

let bucketReady: Promise<void> | null = null;
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const storage = getSupabaseAdmin().storage;
    const { data } = await storage.getBucket(JOBS_BUCKET);
    if (data) return;
    const { error } = await storage.createBucket(JOBS_BUCKET, { public: false, allowedMimeTypes: ["application/json"] });
    if (error && !/exist/i.test(error.message)) throw new Error(`Could not create the ${JOBS_BUCKET} storage bucket: ${error.message}`);
  })().catch((error) => {
    bucketReady = null;
    throw error;
  });
  return bucketReady;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureBucket();
  const { error } = await getSupabaseAdmin()
    .storage.from(JOBS_BUCKET)
    .upload(path, JSON.stringify(value), { upsert: true, contentType: "application/json", cacheControl: "0" });
  if (error) throw new Error(`Could not save extraction progress: ${error.message}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  await ensureBucket();
  const { data, error } = await getSupabaseAdmin().storage.from(JOBS_BUCKET).download(path);
  if (error || !data) return null;
  return JSON.parse(await data.text()) as T;
}

export async function readJob(id: string): Promise<ExtractionJob | null> {
  if (!isJobId(id)) return null;
  const job = await readJson<ExtractionJob>(jobPath(id));
  // A running job whose writer went silent has stopped.
  if (job?.status === "running" && Date.now() - job.updatedAt > STALE_MS) {
    return { ...job, status: "error", error: "The extraction stopped unexpectedly (the server may have timed out). Please try again." };
  }
  return job;
}

/** The run's work so far (see RunState in pipeline.ts), kept between steps. */
export const saveRunState = (id: string, state: unknown) => writeJson(statePath(id), state);
export const loadRunState = <T>(id: string) => readJson<T>(statePath(id));
export async function deleteRunState(id: string) {
  await getSupabaseAdmin().storage.from(JOBS_BUCKET).remove([statePath(id)]);
}

/**
 * Writes a job's progress during one step: progress events are coalesced, a
 * heartbeat keeps it fresh during long units, and the end of the step (done,
 * failed, or waiting for the next step) is written straight away.
 */
export class JobWriter {
  private job: ExtractionJob;
  private pending: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastWrite = 0;

  /** A new job, or the next step of an existing one. */
  constructor(id: string, previous?: ExtractionJob) {
    this.job = previous
      ? { ...previous, status: "running" }
      : { id, status: "running", step: 0, events: [], updatedAt: Date.now() };
  }

  get id() {
    return this.job.id;
  }

  get step() {
    return this.job.step;
  }

  /** Saves the job as running before the step starts. */
  async start() {
    await this.flush();
    this.heartbeat = setInterval(() => this.schedule(), HEARTBEAT_MS);
  }

  progress(event: ProgressEvent) {
    this.job.events.push(event);
    this.schedule();
  }

  async finish(result: ExtractionResult) {
    this.job = { ...this.job, status: "done", result };
    await this.close();
  }

  async fail(message: string) {
    this.job = { ...this.job, status: "error", error: message };
    await this.close();
  }

  /** Ends this step; the page starts the next one. */
  async pause() {
    this.job = { ...this.job, status: "waiting", step: this.job.step + 1 };
    await this.close();
  }

  private schedule() {
    if (this.timer) return;
    const wait = Math.max(0, WRITE_INTERVAL_MS - (Date.now() - this.lastWrite));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((error) => console.warn("Could not save extraction progress.", error));
    }, wait);
  }

  private flush() {
    // Writes go one after another, so an older state never lands last; one
    // failed write (reported by its caller) doesn't stop the later ones.
    this.pending = this.pending.catch(() => {}).then(async () => {
      this.lastWrite = Date.now();
      await writeJson(jobPath(this.job.id), { ...this.job, events: [...this.job.events], updatedAt: Date.now() });
    });
    return this.pending;
  }

  private async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }
}
