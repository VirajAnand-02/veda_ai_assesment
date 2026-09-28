import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EXAM_UPLOADS_BUCKET } from "./extraction/constants";

let client: SupabaseClient | undefined;

// Server-only client using the secret key, which bypasses storage policies.
// It is needed to read uploaded pages back, since the browser key can only
// upload. Never import this from client code.
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY, which the server needs to read uploaded pages (see .env.example).",
    );
  }

  client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export async function downloadExamFile(path: string): Promise<Uint8Array> {
  const { data, error } = await getSupabaseAdmin().storage.from(EXAM_UPLOADS_BUCKET).download(path);
  if (error) throw new Error(`Could not read ${path} from storage: ${error.message}`);
  return new Uint8Array(await data.arrayBuffer());
}
