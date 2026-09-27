import { EXAM_UPLOADS_BUCKET } from "./extraction/constants";
import { getSupabase } from "./supabase";

export type UploadKind = "question" | "answer";

// crypto.randomUUID only exists in secure contexts, and the dev server is
// sometimes opened over plain http on the LAN (e.g. from a phone).
export function createId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

// Storage keys reject spaces and most non-ASCII characters.
function safeFileName(name: string) {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-100);
  return cleaned || "file";
}

// Random prefixes mean a path is never reused, so no overwrite (and therefore
// no select/update permission) is needed.
async function upload(path: string, body: Blob, contentType: string) {
  const { error } = await getSupabase()
    .storage.from(EXAM_UPLOADS_BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) throw error;
  return path;
}

/** Stores the original file at `<submissionId>/<kind>/<random>-<name>`. */
export function uploadExamFile(file: File, kind: UploadKind, submissionId: string) {
  return upload(`${submissionId}/${kind}/${createId()}-${safeFileName(file.name)}`, file, file.type);
}

/** Stores a rendered page at `<submissionId>/<kind>/pages/<nnn>-<random>.jpg`. */
export function uploadPageImage(
  image: Blob,
  kind: UploadKind,
  submissionId: string,
  pageIndex: number,
) {
  const page = String(pageIndex + 1).padStart(3, "0");
  return upload(`${submissionId}/${kind}/pages/${page}-${createId()}.jpg`, image, "image/jpeg");
}
