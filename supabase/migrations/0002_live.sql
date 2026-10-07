-- HIVE migration 0002: live-mode helpers. Run after 0001_hive.sql (Postgres 15+ / Supabase).
--
--  1. Preview (mock) hives never block a real launch. A live database can still hold preview rows
--     (test launches before go-live, or a mock deployment sharing the database): the old
--     hives_cell_unique (cell_q, cell_r) constraint becomes one unique index per status, so a live hive
--     may stand on a cell a preview hive occupies (the public reads of a live server never show
--     preview hives). Two hives of the same status still never share a cell.
--  2. claim_live_cell(q, r, launch, expires): claim_cell for live launches. Preview hives do not count
--     and a claim held by a mock-mode launch gives way. claim_cell itself is unchanged (mock mode).
--  3. hive_schema_info(): a report for /api/health and `npm run check:live`: schema version, which
--     tables / functions exist, realtime publication membership, and how much preview / dry-run data
--     is left (supabase/cleanup-fake-data.sql removes it). Booleans and counts only, no row data.
--
-- Re-running this file is safe: every statement is IF [NOT] EXISTS / CREATE OR REPLACE, grants are
-- re-applied. 0001 stays valid on its own; the server falls back to claim_cell without this file.

-- ---------------------------------------------------------------- one cell per hive, per status

alter table public.hives drop constraint if exists hives_cell_unique;
create unique index if not exists hives_live_cell_unique on public.hives (cell_q, cell_r) where status = 'live';
create unique index if not exists hives_mock_cell_unique on public.hives (cell_q, cell_r) where status = 'mock';

-- ---------------------------------------------------------------- claim_live_cell

-- Same contract as claim_cell (0001), except that preview data does not occupy cells:
--  * false if a non-preview hive stands on the cell or another live launch holds an unexpired /
--    permanent claim; hives with status 'mock' are ignored;
--  * an expired claim, and any claim held by a mode 'mock' launch, is deleted first;
--  * idempotent for the same launch; a launch holds at most one pending cell.
create or replace function public.claim_live_cell(q integer, r integer, launch text, expires timestamptz)
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
  if exists (select 1 from public.hives h where h.cell_q = q and h.cell_r = r and h.status <> 'mock') then
    return false;
  end if;

  delete from public.cell_claims c
   where c.q = q and c.r = r and c.expires_at is not null and c.expires_at <= now();
  delete from public.cell_claims c
   where c.q = q and c.r = r and c.launch_id <> launch
     and exists (select 1 from public.launches l where l.id = c.launch_id and l.mode = 'mock');

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

-- ---------------------------------------------------------------- hive_schema_info

create or replace function public.hive_schema_info()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with
    want_tables(t) as (values ('hives'), ('actions'), ('harvests'), ('prices'), ('launches'), ('cell_claims'), ('secrets'), ('meta'), ('locks')),
    want_functions(f) as (values ('try_lock'), ('claim_cell'), ('claim_live_cell'), ('hive_schema_info')),
    pub as (select puballtables from pg_publication where pubname = 'supabase_realtime')
  select jsonb_build_object(
    'version', 2,
    'tables', (select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from want_tables where to_regclass('public.' || t) is not null),
    'functions', (select coalesce(jsonb_agg(f order by f), '[]'::jsonb) from want_functions
                   where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f)),
    'rls', (select coalesce(bool_and(c.relrowsecurity), false) from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and c.relname in (select t from want_tables)),
    'realtime', jsonb_build_object(
      'publication', exists (select 1 from pub),
      'allTables', coalesce((select puballtables from pub), false),
      'tables', (select coalesce(jsonb_agg(tablename::text order by tablename), '[]'::jsonb) from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('hives', 'actions', 'harvests'))),
    'preview', jsonb_build_object(
      'hives', (select count(*) from public.hives where status = 'mock'),
      'launches', (select count(*) from public.launches where mode = 'mock'),
      'dryRunActions', (select count(*) from public.actions where dry_run),
      'dryRunHarvests', (select count(*) from public.harvests where dry_run)),
    'live', jsonb_build_object(
      'hives', (select count(*) from public.hives where status = 'live'),
      'launches', (select count(*) from public.launches where mode = 'live'))
  );
$$;

-- Server-only, like the 0001 helpers (Postgres and Supabase grant EXECUTE to PUBLIC / anon by default).
revoke execute on function public.claim_live_cell(integer, integer, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.hive_schema_info() from public, anon, authenticated;
grant execute on function public.claim_live_cell(integer, integer, text, timestamptz) to service_role;
grant execute on function public.hive_schema_info() to service_role;
