-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
create table if not exists public.sop_docs (
  col  text  not null,
  id   text  not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
-- Only the server (service key) may touch the table.
alter table public.sop_docs enable row level security;

-- Private bucket for packing videos (20 MB per file).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sop-videos', 'sop-videos', false, 20971520, array['video/mp4','video/webm'])
on conflict (id) do nothing;
