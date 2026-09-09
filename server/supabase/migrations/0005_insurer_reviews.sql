-- 0005_insurer_reviews: mock insurer review (F8)

create table if not exists insurer_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references evidence_submissions(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  status text not null default 'REVIEWING' check (status in ('REVIEWING', 'ADOPTED', 'REJECTED')),
  submitted_by uuid references profiles(id),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references profiles(id),
  note text,
  evidence_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists insurer_reviews_incident_idx on insurer_reviews (incident_id, submitted_at desc);

alter table insurer_reviews enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy insurer_reviews_select_related on insurer_reviews for select using (
      exists (select 1 from incidents i where i.id = insurer_reviews.incident_id and i.requester_id = auth.uid())
      or exists (select 1 from evidence_submissions s where s.id = insurer_reviews.submission_id and s.witness_id = auth.uid()))';
  end if;
end $$;
