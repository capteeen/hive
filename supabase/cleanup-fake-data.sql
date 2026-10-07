-- HIVE: delete preview (fake) data from a Supabase database before / after going live.
--
-- Paste into the Supabase SQL editor and run. Safe to run any number of times: a second run deletes
-- nothing. Everything happens in ONE transaction: it either all applies or nothing does.
--
-- Deletes:
--   * hives with status 'mock' (preview launches), with their actions, prices, cell claims and meta
--     (image:<ca>, engine:hive:<ca>, engine:devOwed:<ca>);
--   * launches with mode 'mock', with their cell claims, payment claims (meta payment:<sig> pointing at
--     them), dev-buy bookkeeping (meta launch:devAmount:<id>) and launch locks;
--   * the mock engine's run marks (meta engine:mock:*);
--   * every dry-run action and dry-run harvest, and harvests that paid a preview hive.
-- Never deletes:
--   * a launch with mode 'live' (it may hold real SOL: its encrypted queen and mint keys), or anything
--     of a live hive or live launch (rows matching a live launch's ca / mint / id are excluded even if
--     they look like preview data);
--   * the secrets table. A preview queen is a real keypair: if anyone ever sent SOL to a preview queen
--     address, its encrypted key is the only way to get it back. Secrets are server-only and invisible
--     to the public. (To drop them anyway, see the optional statement at the end.)
--
-- Local file store (no Supabase): stop the server and delete the DATA_DIR folder (default `.data`)
-- instead. That removes everything, real data included, so only do it on a test machine.

begin;

-- What counts as preview data, decided once, before anything is deleted.
create temp table _live_ids on commit drop as
  select id as v from public.launches where mode = 'live'
  union select ca from public.launches where mode = 'live' and ca is not null
  union select mint_pubkey from public.launches where mode = 'live'
  union select ca from public.hives where status = 'live';

create temp table _fake_hives on commit drop as
  select ca from public.hives
   where status = 'mock' and ca not in (select v from _live_ids);

create temp table _fake_launches on commit drop as
  select id, ca, mint_pubkey from public.launches
   where mode = 'mock' and id not in (select v from _live_ids)
     and coalesce(ca, '') not in (select v from _live_ids) and mint_pubkey not in (select v from _live_ids);

-- actions: everything a preview hive did, and every dry run (never a live hive's real action)
delete from public.actions a
 where (a.ca in (select ca from _fake_hives) or a.dry_run)
   and not (a.ca in (select v from _live_ids) and not a.dry_run);

-- harvests: dry runs, and harvests whose royal jelly went to a preview hive (mock-mode harvests)
delete from public.harvests h
 where h.dry_run or h.jelly_to in (select ca from _fake_hives);

delete from public.prices p where p.ca in (select ca from _fake_hives);

delete from public.cell_claims c where c.launch_id in (select id from _fake_launches);

delete from public.meta m
 where m.key in (select 'image:' || ca from _fake_hives)
    or m.key in (select 'engine:hive:' || ca from _fake_hives)
    or m.key in (select 'engine:devOwed:' || ca from _fake_hives)
    or m.key in (select 'launch:devAmount:' || id from _fake_launches)
    or (m.key like 'payment:%' and m.value in (select id from _fake_launches))
    or m.key like 'engine:mock:%';

delete from public.locks l where l.name in (select 'launch:' || id from _fake_launches);

delete from public.hives h where h.ca in (select ca from _fake_hives);

delete from public.launches l where l.id in (select id from _fake_launches) and l.mode = 'mock';

commit;

-- What is left.
select 'hives (live)' as what, count(*) as n from public.hives where status = 'live'
union all select 'hives (preview)', count(*) from public.hives where status = 'mock'
union all select 'launches (live)', count(*) from public.launches where mode = 'live'
union all select 'launches (preview)', count(*) from public.launches where mode = 'mock'
union all select 'actions', count(*) from public.actions
union all select 'actions (dry run)', count(*) from public.actions where dry_run
union all select 'harvests', count(*) from public.harvests
union all select 'harvests (dry run)', count(*) from public.harvests where dry_run
union all select 'prices', count(*) from public.prices
union all select 'cell_claims', count(*) from public.cell_claims
union all select 'meta', count(*) from public.meta
union all select 'secrets (kept)', count(*) from public.secrets;

-- Optional, NOT run by default: also drop the encrypted keys of deleted preview launches. Only do this
-- if you are sure nobody ever sent SOL to a preview queen wallet. Uncomment and run on its own:
--
-- delete from public.secrets s
--  where s.pubkey not in (select queen_wallet from public.launches union select mint_pubkey from public.launches
--                         union select queen_wallet from public.hives);
