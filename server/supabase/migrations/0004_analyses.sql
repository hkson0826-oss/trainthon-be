-- 0004_analyses: AI analysis records (one per submission)

create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references evidence_submissions(id) on delete cascade,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'ANALYZING', 'FINALIZING', 'READY', 'FAILED')),
  source text check (source in ('LIVE', 'PRERECORDED')),
  provider text not null default 'twelvelabs',
  model text not null,
  prompt_version text not null,
  request_payload_hash text,
  raw_response jsonb,
  result jsonb,
  error_code text check (error_code in ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED', 'INVALID_RESPONSE', 'TIMEOUT')),
  error_message text,
  attempts integer not null default 0,
  requested_by uuid references profiles(id),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists analyses_status_idx on analyses (status, updated_at);

alter table analyses enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy analyses_select_own on analyses for select using (exists (select 1 from evidence_submissions s where s.id = analyses.submission_id and s.witness_id = auth.uid()))';
  end if;
end $$;
