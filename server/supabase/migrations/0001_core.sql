-- 0001_core: profiles, places, visits, audit_logs
-- Runs on Supabase Postgres and on plain Postgres/PGlite (tests). Supabase-only
-- pieces (auth.users FK, RLS policies using auth.uid()) are applied conditionally.

-- gen_random_uuid() is built into PostgreSQL 13+, no extension needed.

create table if not exists profiles (
  id uuid primary key,
  role text not null default 'REQUESTER' check (role in ('REQUESTER', 'WITNESS', 'OPERATOR')),
  display_name text not null default '',
  email text,
  notification_consent boolean not null default false,
  payout_ready boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists places (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('PARKING_LOT', 'APARTMENT', 'BUILDING')),
  address text not null default '',
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  place_id uuid not null references places(id) on delete cascade,
  entered_at timestamptz not null,
  exited_at timestamptz not null,
  source text not null default 'MANUAL' check (source in ('SEED', 'MANUAL')),
  retain_until timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (entered_at < exited_at)
);
create index if not exists visits_place_time_idx on visits (place_id, entered_at, exited_at);
create index if not exists visits_user_idx on visits (user_id, entered_at desc);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_target_idx on audit_logs (target_type, target_id, created_at desc);

-- Supabase: link profiles to auth.users when the auth schema exists.
do $$
begin
  if to_regclass('auth.users') is not null then
    if not exists (select 1 from pg_constraint where conname = 'profiles_id_auth_fk') then
      alter table profiles add constraint profiles_id_auth_fk foreign key (id) references auth.users(id) on delete cascade;
    end if;
  end if;
end $$;

-- Supabase: RLS. The server connects with a privileged role and bypasses RLS;
-- these policies only protect against anon-key reads if the tables are exposed.
alter table profiles enable row level security;
alter table places enable row level security;
alter table visits enable row level security;
alter table audit_logs enable row level security;

do $$
begin
  if to_regprocedure('auth.uid()') is not null then
    execute 'create policy profiles_select_own on profiles for select using (id = auth.uid())';
    execute 'create policy places_select_all on places for select using (true)';
    execute 'create policy visits_select_own on visits for select using (user_id = auth.uid())';
  end if;
end $$;
