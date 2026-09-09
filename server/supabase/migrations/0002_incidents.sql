-- 0002_incidents: incidents, incident_photos, notifications, settlements

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references profiles(id) on delete cascade,
  place_id uuid not null references places(id),
  type text not null check (type in ('HIT_AND_RUN', 'CONTACT', 'DAMAGE', 'OTHER')),
  occurred_from timestamptz not null,
  occurred_to timestamptz not null,
  vehicle_color text not null default '',
  vehicle_model text not null default '',
  damage_area text not null default '',
  description text not null default '',
  status text not null default 'DRAFT' check (status in ('DRAFT', 'OPEN', 'COLLECTING', 'REVIEWING', 'ADOPTED', 'CLOSED_NO_EVIDENCE', 'CANCELLED')),
  review_mode text not null default 'AUTO_DEMO',
  matched_witness_count integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (occurred_from < occurred_to)
);
create index if not exists incidents_requester_idx on incidents (requester_id, created_at desc);
create index if not exists incidents_place_time_idx on incidents (place_id, occurred_from, occurred_to);

create table if not exists incident_photos (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  object_path text not null unique,
  mime text not null,
  bytes bigint not null,
  width integer,
  height integer,
  sha256 text not null,
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  unique (incident_id, position)
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in ('WITNESS_REQUEST', 'CANDIDATE_FOUND', 'NO_CANDIDATE', 'ADOPTION_UPDATED', 'REWARD_SCHEDULED')),
  incident_id uuid references incidents(id) on delete cascade,
  submission_id uuid,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT (PostgreSQL 15+) so WITNESS_REQUEST rows with a NULL
  -- submission_id are deduplicated too.
  unique nulls not distinct (user_id, type, incident_id, submission_id)
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc, id desc);
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

create table if not exists settlements (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null unique references incidents(id) on delete cascade,
  deposit_amount integer not null check (deposit_amount >= 0),
  platform_fee integer not null check (platform_fee >= 0),
  witness_reward integer not null check (witness_reward >= 0),
  status text not null default 'DEPOSIT_PENDING' check (status in ('DEPOSIT_PENDING', 'DEPOSITED', 'ADOPTION_PENDING', 'PAYOUT_SCHEDULED', 'PAID', 'REFUNDED', 'PAYOUT_FAILED', 'DISPUTED')),
  payout_user_id uuid references profiles(id),
  payout_submission_id uuid,
  payout_scheduled_at timestamptz,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table incidents enable row level security;
alter table incident_photos enable row level security;
alter table notifications enable row level security;
alter table settlements enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy incidents_select_own on incidents for select using (requester_id = auth.uid())';
    execute 'create policy notifications_select_own on notifications for select using (user_id = auth.uid())';
    execute 'create policy settlements_select_own on settlements for select using (exists (select 1 from incidents i where i.id = settlements.incident_id and i.requester_id = auth.uid()))';
  end if;
end $$;
