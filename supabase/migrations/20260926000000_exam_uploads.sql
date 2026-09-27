-- Storage for uploaded question papers and answer sheets.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor), or apply it
-- with the Supabase CLI. It is safe to run again.

-- Private bucket. The size and type limits are enforced by Supabase itself and
-- mirror the checks in src/lib/uploads.ts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'exam-uploads',
  'exam-uploads',
  false,
  10485760, -- 10 MB
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The app has no sign-in yet, so the publishable (anon) key may add files to this
-- bucket. It cannot list, read, overwrite or delete them; add select/delete
-- policies (or read files with a server-side key) once the app needs that.
drop policy if exists "Anyone can upload exam files" on storage.objects;
create policy "Anyone can upload exam files"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'exam-uploads');
