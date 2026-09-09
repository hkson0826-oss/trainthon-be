-- 0003_submissions: evidence_submissions (Y video uploads)

create table if not exists evidence_submissions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  witness_id uuid not null references profiles(id) on delete cascade,
  object_path text not null unique,
  mime text not null default 'video/mp4',
  bytes bigint not null default 0,
  declared_bytes bigint not null default 0,
  duration_sec double precision,
  width integer,
  height integer,
  sha256 text,
  recorded_at timestamptz,
  status text not null default 'UPLOADING' check (status in ('UPLOADING', 'UPLOADED', 'ANALYZING', 'READY', 'ANALYSIS_FAILED', 'SUBMITTED', 'ADOPTED', 'REJECTED')),
  upload_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (incident_id, witness_id)
);
create index if not exists evidence_submissions_incident_idx on evidence_submissions (incident_id, created_at desc);
create index if not exists evidence_submissions_witness_idx on evidence_submissions (witness_id, created_at desc);

alter table notifications
  drop constraint if exists notifications_submission_id_fkey,
  add constraint notifications_submission_id_fkey foreign key (submission_id) references evidence_submissions(id) on delete cascade;

alter table settlements
  drop constraint if exists settlements_payout_submission_id_fkey,
  add constraint settlements_payout_submission_id_fkey foreign key (payout_submission_id) references evidence_submissions(id);

alter table evidence_submissions enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy submissions_select_own on evidence_submissions for select using (witness_id = auth.uid())';
  end if;
end $$;
