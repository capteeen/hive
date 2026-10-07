-- Migration 0002: per-status cell uniqueness, claim_live_cell, hive_schema_info.

-- ---------- a live hive may share a cell with a preview hive, never with another hive of its status
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('LV-M1', 60, 0, 'queen-lv-m1')) = 'ok:1', 'preview hive at (60,0)');
select hive_test.ok(
  hive_test.run_as(current_user, replace(hive_test.hive_sql('LV-L1', 60, 0, 'queen-lv-l1'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1',
  'a live hive can stand on the preview hive''s cell');
select hive_test.ok(
  hive_test.fails_with(replace(hive_test.hive_sql('LV-L2', 60, 0, 'queen-lv-l2'), $q$'mock')$q$, $q$'live')$q$), '23505'),
  'a second live hive on (60,0) is a unique violation');
select hive_test.ok(hive_test.fails_with(hive_test.hive_sql('LV-M2', 60, 0, 'queen-lv-m2'), '23505'), 'a second preview hive on (60,0) is a unique violation');
select hive_test.ok(
  not exists (select 1 from pg_constraint where conname = 'hives_cell_unique')
  and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'hives_live_cell_unique')
  and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'hives_mock_cell_unique'),
  'hives_cell_unique was replaced by one unique index per status');

-- ---------- claim_live_cell
insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at)
values
  ('lv-mock-launch', 'mock', 'reserved', 'owner', '{}', 'queen-lvm', 'mint-lvm', 'v1.x.x.x', 61, 0, 0, now() + interval '15 minutes'),
  ('lv-live-launch', 'live', 'reserved', 'owner', '{}', 'queen-lvl', 'mint-lvl', 'v1.x.x.x', 62, 0, 0, now() + interval '15 minutes');
select hive_test.ok(public.claim_cell(61, 0, 'lv-mock-launch', now() + interval '15 minutes'), 'a preview launch claims (61,0)');
select hive_test.ok(public.claim_cell(62, 0, 'lv-live-launch', now() + interval '15 minutes'), 'a live launch claims (62,0)');

select hive_test.ok(not public.claim_cell(61, 0, 'lv-real', now() + interval '15 minutes'), 'claim_cell (mock mode): the preview claim still blocks');
select hive_test.ok(public.claim_live_cell(61, 0, 'lv-real', now() + interval '15 minutes'), 'claim_live_cell: a preview launch''s claim gives way');
select hive_test.ok((select launch_id from public.cell_claims where q = 61 and r = 0) = 'lv-real', '... and the live launch now holds (61,0)');
select hive_test.ok(not public.claim_live_cell(62, 0, 'lv-real-2', now() + interval '15 minutes'), 'claim_live_cell: another live launch''s claim still blocks');
select hive_test.ok(not public.claim_live_cell(60, 0, 'lv-real-2', now() + interval '15 minutes'), 'claim_live_cell: a live hive blocks its cell');
select hive_test.ok(not public.claim_cell(63, 0, '', now()), 'empty launch id is refused (claim_cell)');
select hive_test.ok(not public.claim_live_cell(63, 0, '', now()), 'empty launch id is refused (claim_live_cell)');

select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('LV-M3', 64, 0, 'queen-lv-m3')) = 'ok:1', 'preview hive at (64,0)');
select hive_test.ok(not public.claim_cell(64, 0, 'lv-real-3', now() + interval '15 minutes'), 'claim_cell: a preview hive blocks its cell');
select hive_test.ok(public.claim_live_cell(64, 0, 'lv-real-3', now() + interval '15 minutes'), 'claim_live_cell: a preview hive does not');
select hive_test.ok(public.claim_live_cell(64, 0, 'lv-real-3', now() + interval '20 minutes'), 'claim_live_cell is idempotent for the same launch');
select hive_test.ok(public.claim_live_cell(65, 0, 'lv-real-3', now() + interval '15 minutes'), 'the same launch claims (65,0)');
select hive_test.ok((select array_agg(q || ',' || r) from public.cell_claims where launch_id = 'lv-real-3') = array['65,0'],
  'claim_live_cell keeps one pending cell per launch');

-- ---------- hive_schema_info
do $$
declare
  info jsonb := public.hive_schema_info();
begin
  perform hive_test.ok((info ->> 'version')::int = 2, 'hive_schema_info reports version 2');
  perform hive_test.ok(jsonb_array_length(info -> 'tables') = 9, 'hive_schema_info lists all nine tables');
  perform hive_test.ok(info -> 'functions' ?& array['claim_cell', 'claim_live_cell', 'try_lock', 'hive_schema_info'], 'hive_schema_info lists the helper functions');
  perform hive_test.ok((info ->> 'rls')::boolean, 'hive_schema_info: RLS is on');
  perform hive_test.ok((info -> 'realtime' ->> 'publication')::boolean and info -> 'realtime' -> 'tables' = '["actions", "harvests", "hives"]'::jsonb,
    'hive_schema_info: realtime publishes hives, actions, harvests');
  perform hive_test.ok((info -> 'preview' ->> 'hives')::int = (select count(*) from public.hives where status = 'mock')
    and (info -> 'live' ->> 'hives')::int = (select count(*) from public.hives where status = 'live'),
    'hive_schema_info counts preview and live hives');
end
$$;

-- ---------- server-only
select hive_test.ok(hive_test.run_as('anon', $q$select public.claim_live_cell(66, 0, 'evil', now() + interval '1 hour')$q$) = 'denied', 'anon cannot execute claim_live_cell');
select hive_test.ok(hive_test.run_as('authenticated', $q$select public.hive_schema_info()$q$) = 'denied', 'authenticated cannot execute hive_schema_info');
select hive_test.ok(hive_test.run_as('service_role', $q$select public.hive_schema_info()$q$) = 'ok:1', 'service_role executes hive_schema_info');
select hive_test.ok(
  (select prosecdef and proconfig::text like '%search_path%' from pg_proc where oid = 'public.claim_live_cell(integer, integer, text, timestamptz)'::regprocedure),
  'claim_live_cell is SECURITY DEFINER with a pinned search_path');

-- leave nothing for the next file
delete from public.cell_claims where launch_id like 'lv-%';
delete from public.launches where id like 'lv-%';
delete from public.hives where ca like 'LV-%';
