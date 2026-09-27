// Shared by the browser and the server. Keep the bucket limits in step with
// supabase/migrations.
export const EXAM_UPLOADS_BUCKET = "exam-uploads";
export const ACCEPTED_TYPES = ["application/pdf", "image/png", "image/jpeg"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Upper bound on pages per document, to keep processing time and cost sane. */
export const MAX_PAGES = 20;
