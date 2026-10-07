-- Schema shape: RLS on everywhere, exactly the public read policies, realtime membership.
-- Runs after the migration was applied twice, so duplicate policies / publication entries would show here.

select hive_test.ok(
  (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('hives', 'actions', 'harvests', 'prices', 'launches', 'cell_claims', 'secrets', 'meta', 'locks')
      and c.relkind = 'r')
  and (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('hives', 'actions', 'harvests', 'prices', 'launches', 'cell_claims', 'secrets', 'meta', 'locks')
      and c.relkind = 'r') = 9,
  'all nine tables exist with row level security enabled');

select hive_test.ok(
  (select count(*) from pg_policies where schemaname = 'public') = 4,
  'exactly four policies after re-running the migration');

select hive_test.ok(
  (select array_agg(tablename::text order by tablename) from pg_policies where schemaname = 'public' and cmd = 'SELECT')
    = array['actions', 'harvests', 'hives', 'prices'],
  'public SELECT policies only on hives, actions, harvests, prices');

select hive_test.ok(
  not exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('launches', 'cell_claims', 'secrets', 'meta', 'locks')),
  'no policies at all on private tables');

select hive_test.ok(
  (select array_agg(tablename::text order by tablename) from pg_publication_tables where pubname = 'supabase_realtime')
    = array['actions', 'harvests', 'hives'],
  'supabase_realtime publishes hives, actions, harvests (once each)');

select hive_test.ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'actions_ca_at_idx')
  and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'prices_pkey'),
  'indexes on actions(ca, at desc) and prices(ca, at)');

select hive_test.ok(
  (select prosecdef from pg_proc where oid = 'public.try_lock(text, timestamptz)'::regprocedure)
  and (select prosecdef from pg_proc where oid = 'public.claim_cell(integer, integer, text, timestamptz)'::regprocedure),
  'try_lock and claim_cell are SECURITY DEFINER');

select hive_test.ok(
  (select proconfig::text from pg_proc where oid = 'public.claim_cell(integer, integer, text, timestamptz)'::regprocedure) like '%search_path%',
  'claim_cell pins search_path');
