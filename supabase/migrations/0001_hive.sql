-- HIVE schema for Supabase (Postgres 15+).
--
-- Public (anon / authenticated may SELECT, nothing else): hives, actions, harvests, prices.
-- Private (service_role only; RLS on with no policies AND privileges revoked): launches, cell_claims,
-- secrets, meta, locks.
-- The server uses the service-role key, which bypasses RLS. Browsers use the anon key for reads and
-- Realtime (hives / actions / harvests are in the supabase_realtime publication).
--
-- Re-running this file is safe: tables / indexes use IF NOT EXISTS, functions CREATE OR REPLACE,
-- policies are dropped and recreated, grants are re-applied. It does NOT alter columns of tables that
-- already exist: schema changes go in a new numbered migration.
--
-- Timestamps are timestamptz; the app converts to/from epoch ms (lib/shared/rows.ts).

-- ---------------------------------------------------------------- public tables

create table if not exists public.hives (
  ca            text primary key,
  name          text not null,
  ticker        text not null,
  image         text not null default '',
  description   text,
  motto         text,
  telegram      text,
  twitter       text,
  cell_q        integer not null,
  cell_r        integer not null,
  queen_wallet  text not null,
  owner_wallet  text not null,
  look          jsonb,
  rules         jsonb,
  temperament   jsonb,
  dev_buy       numeric not null default 0 check (dev_buy >= 0),
  status        text not null check (status in ('mock', 'live')),
  create_tx     text,
  honey         numeric not null default 0,
  bees          integer not null default 0 check (bees >= 0),
  fees_total    numeric not null default 0,
  royal_jelly   numeric not null default 0,
  price         double precision,
  state         text not null default 'working' check (state in ('working', 'starving', 'abandoned')),
  last_fee_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint hives_cell_unique unique (cell_q, cell_r),
  constraint hives_queen_wallet_unique unique (queen_wallet)
);

create table if not exists public.actions (
  id          text primary key,
  ca          text not null,
  verb        text not null check (verb in ('seal', 'store', 'swarm', 'starve', 'abandon', 'jelly', 'born')),
  amount      numeric not null default 0,
  target_ca   text,
  reason      text not null default '',
  tx_sig      text,
  at          timestamptz not null,
  dry_run     boolean not null default false
);
create index if not exists actions_ca_at_idx on public.actions (ca, at desc);
create index if not exists actions_at_idx on public.actions (at desc);

create table if not exists public.harvests (
  id            text primary key,
  at            timestamptz not null,
  fees_in       numeric not null default 0,
  hive_bought   numeric not null default 0,
  burned        numeric not null default 0,
  jelly_to      text not null default '',
  jelly_amount  numeric not null default 0,
  jelly_sol     numeric not null default 0,
  tx_sig        text not null default '',
  dry_run       boolean not null default false
);
create index if not exists harvests_at_idx on public.harvests (at desc);

create table if not exists public.prices (
  ca      text not null,
  at      timestamptz not null,
  price   double precision not null check (price >= 0),
  -- (ca, at) unique: re-recording the same snapshot replaces it; also serves the (ca, at) range scans
  constraint prices_pkey primary key (ca, at)
);

-- ---------------------------------------------------------------- private tables

create table if not exists public.launches (
  id               text primary key,
  mode             text not null check (mode in ('mock', 'live')),
  state            text not null check (state in ('reserved', 'paid', 'metadata', 'created', 'live', 'failed', 'expired', 'refunded')),
  owner            text not null,
  payload          jsonb not null,
  queen_wallet     text not null,
  mint_pubkey      text not null unique,
  mint_secret_enc  text not null,
  cell_q           integer not null,
  cell_r           integer not null,
  lamports         bigint not null check (lamports >= 0),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  updated_at       timestamptz not null default now(),
  ca               text,
  metadata_uri     text,
  image_uri        text,
  txs              jsonb not null default '{}'::jsonb,
  error            text,
  attempts         integer not null default 0
);
create index if not exists launches_state_idx on public.launches (state, created_at);

-- One row per reserved cell. expires_at null = permanent (the hive is live).
create table if not exists public.cell_claims (
  q           integer not null,
  r           integer not null,
  launch_id   text not null,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint cell_claims_pkey primary key (q, r)
);
create index if not exists cell_claims_launch_idx on public.cell_claims (launch_id);

create table if not exists public.secrets (
  pubkey      text primary key,
  enc         text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.meta (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

create table if not exists public.locks (
  name    text primary key,
  until   timestamptz not null
);

-- ---------------------------------------------------------------- row level security

alter table public.hives       enable row level security;
alter table public.actions     enable row level security;
alter table public.harvests    enable row level security;
alter table public.prices      enable row level security;
alter table public.launches    enable row level security;
alter table public.cell_claims enable row level security;
alter table public.secrets     enable row level security;
alter table public.meta        enable row level security;
alter table public.locks       enable row level security;

drop policy if exists hives_public_read on public.hives;
create policy hives_public_read on public.hives for select to anon, authenticated using (true);
drop policy if exists actions_public_read on public.actions;
create policy actions_public_read on public.actions for select to anon, authenticated using (true);
drop policy if exists harvests_public_read on public.harvests;
create policy harvests_public_read on public.harvests for select to anon, authenticated using (true);
drop policy if exists prices_public_read on public.prices;
create policy prices_public_read on public.prices for select to anon, authenticated using (true);
-- (no policies on launches, cell_claims, secrets, meta, locks: invisible to anon / authenticated)

-- Defence in depth: Supabase grants ALL on new public tables to anon / authenticated by default and
-- relies on RLS alone. Take the write privileges (and TRUNCATE, which RLS does not cover) away too.
revoke all on public.hives, public.actions, public.harvests, public.prices from anon, authenticated;
grant select on public.hives, public.actions, public.harvests, public.prices to anon, authenticated;
revoke all on public.launches, public.cell_claims, public.secrets, public.meta, public.locks from anon, authenticated;
grant all on
  public.hives, public.actions, public.harvests, public.prices,
  public.launches, public.cell_claims, public.secrets, public.meta, public.locks
  to service_role;

-- ---------------------------------------------------------------- atomic helpers

-- Take the lock `name` until `until` if it is free or expired. True when taken.
-- One INSERT .. ON CONFLICT statement, so concurrent callers serialise on the row.
create or replace function public.try_lock(name text, until timestamptz)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  with taken as (
    insert into public.locks as l (name, until)
    values (try_lock.name, try_lock.until)
    on conflict on constraint locks_pkey do update
      set until = excluded.until
      where l.until <= now()
    returning 1
  )
  select exists (select 1 from taken);
$$;

-- Reserve cell (q, r) for `launch` until `expires` (null = permanent). True when reserved.
--  * false if a hive already stands there or another launch holds an unexpired / permanent claim;
--  * an expired unfinalized claim on the cell is deleted first, so the cell is free again;
--  * idempotent for the same launch (a retry refreshes a pending claim's expiry);
--  * a launch holds at most one pending cell: its other unfinalized claims are dropped.
create or replace function public.claim_cell(q integer, r integer, launch text, expires timestamptz)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_variable
declare
  holder text;
begin
  if q is null or r is null or launch is null or launch = '' then
    return false;
  end if;
  if exists (select 1 from public.hives h where h.cell_q = q and h.cell_r = r) then
    return false;
  end if;

  delete from public.cell_claims c
   where c.q = q and c.r = r and c.expires_at is not null and c.expires_at <= now();

  select c.launch_id into holder from public.cell_claims c where c.q = q and c.r = r for update;
  if found then
    if holder <> launch then
      return false;
    end if;
    update public.cell_claims c set expires_at = expires
     where c.q = q and c.r = r and c.expires_at is not null;
    return true;
  end if;

  begin
    insert into public.cell_claims as c (q, r, launch_id, expires_at) values (q, r, launch, expires);
  exception when unique_violation then
    return false; -- someone else claimed it between our check and insert
  end;

  delete from public.cell_claims c
   where c.launch_id = launch and c.expires_at is not null and not (c.q = q and c.r = r);
  return true;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default and Supabase also grants it to anon / authenticated:
-- only the service role may call these.
revoke execute on function public.try_lock(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_cell(integer, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.try_lock(text, timestamptz) to service_role;
grant execute on function public.claim_cell(integer, integer, text, timestamptz) to service_role;

-- ---------------------------------------------------------------- realtime

-- Browsers receive INSERT / UPDATE on these tables (filtered by the SELECT policies above).
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found: skipping realtime setup';
    return;
  end if;
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return; -- FOR ALL TABLES already covers them
  end if;
  foreach t in array array['hives', 'actions', 'harvests'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
