-- supabase/cleanup-fake-data.sql: deletes preview / dry-run data, never anything live, and is idempotent.

-- ---------- seed: one live launch with its hive and history, one in-flight live launch, and preview data
insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at, ca)
values
  ('cl-live', 'live', 'live', 'owner-live', '{}', 'queen-cl-live', 'CLLIVE', 'v1.x.x.x', 70, 0, 1, now(), 'CLLIVE'),
  ('cl-live-pending', 'live', 'paid', 'owner-live2', '{}', 'queen-cl-live2', 'CLLIVE2', 'v1.x.x.x', 71, 0, 1, now() + interval '15 minutes', null),
  ('cl-mock', 'mock', 'live', 'guest:abcdefgh', '{}', 'queen-cl-mock', 'CLMOCK', 'v1.x.x.x', 72, 0, 0, now(), 'CLMOCK'),
  ('cl-mock-pending', 'mock', 'reserved', 'guest:abcdefgh', '{}', 'queen-cl-mock2', 'CLMOCK2', 'v1.x.x.x', 73, 0, 0, now() + interval '15 minutes', null);
select hive_test.ok(hive_test.run_as(current_user, replace(hive_test.hive_sql('CLLIVE', 70, 0, 'queen-cl-live'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1', 'seed live hive');
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('CLMOCK', 72, 0, 'queen-cl-mock')) = 'ok:1', 'seed preview hive');
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('CLMOCK3', 70, 0, 'queen-cl-mock3')) = 'ok:1', 'seed preview hive on the live hive''s cell');

insert into public.cell_claims (q, r, launch_id, expires_at) values
  (70, 0, 'cl-live', null), (71, 0, 'cl-live-pending', null), (72, 0, 'cl-mock', null), (73, 0, 'cl-mock-pending', now() + interval '15 minutes');
insert into public.actions (id, ca, verb, amount, reason, at, dry_run, target_ca) values
  ('cl-live-a', 'CLLIVE', 'store', 0.1, 'real', now(), false, null),
  ('cl-live-dry', 'CLLIVE', 'seal', 0.1, 'dry', now(), true, null),
  ('cl-mock-a', 'CLMOCK', 'store', 0.1, 'preview', now(), false, null),
  ('cl-mock-swarm', 'CLMOCK', 'swarm', 0.1, 'preview', now(), false, 'CLLIVE');
insert into public.harvests (id, at, jelly_to, tx_sig, dry_run) values
  ('cl-h-live', now(), 'CLLIVE', 'sig-live', false),
  ('cl-h-dry', now(), 'CLLIVE', '', true),
  ('cl-h-mock', now(), 'CLMOCK', 'sig-mock', false);
insert into public.prices (ca, at, price) values ('CLLIVE', now(), 1), ('CLMOCK', now(), 1);
insert into public.secrets (pubkey, enc) values ('queen-cl-live', 'v1.k.k.k'), ('CLLIVE', 'v1.k.k.k'), ('queen-cl-mock', 'v1.k.k.k'), ('CLMOCK', 'v1.k.k.k');
insert into public.meta (key, value) values
  ('image:CLLIVE', 'data:image/png;base64,AA=='), ('engine:hive:CLLIVE', '{}'), ('engine:devOwed:CLLIVE', '{}'),
  ('launch:devAmount:cl-live', '1'), ('payment:sig-pay-live', 'cl-live'), ('engine:live:real:lastHour', '{}'), ('engine:live:dry:lastHour', '{}'),
  ('image:CLMOCK', 'data:image/png;base64,AA=='), ('engine:hive:CLMOCK', '{}'), ('engine:devOwed:CLMOCK', '{}'),
  ('launch:devAmount:cl-mock', '1'), ('payment:sig-pay-mock', 'cl-mock'), ('engine:mock:real:lastHour', '{}'), ('engine:mock:harvest:open', '');
insert into public.locks (name, until) values ('launch:cl-mock', now() + interval '1 minute'), ('launch:cl-live', now() + interval '1 minute');

\ir ../cleanup-fake-data.sql

-- ---------- live data is untouched
select hive_test.ok((select count(*) from public.launches where id in ('cl-live', 'cl-live-pending')) = 2, 'live launches (finished and in flight) are kept');
select hive_test.ok(exists (select 1 from public.hives where ca = 'CLLIVE' and status = 'live'), 'the live hive is kept');
select hive_test.ok((select count(*) from public.cell_claims where launch_id in ('cl-live', 'cl-live-pending')) = 2, 'live launches keep their cells');
select hive_test.ok(exists (select 1 from public.actions where id = 'cl-live-a'), 'the live hive''s real action is kept');
select hive_test.ok(exists (select 1 from public.harvests where id = 'cl-h-live'), 'the real harvest is kept');
select hive_test.ok(exists (select 1 from public.prices where ca = 'CLLIVE'), 'the live hive''s prices are kept');
select hive_test.ok((select count(*) from public.secrets where pubkey in ('queen-cl-live', 'CLLIVE')) = 2, 'live keys are kept');
select hive_test.ok(
  (select count(*) from public.meta where key in ('image:CLLIVE', 'engine:hive:CLLIVE', 'engine:devOwed:CLLIVE', 'launch:devAmount:cl-live', 'payment:sig-pay-live', 'engine:live:real:lastHour', 'engine:live:dry:lastHour')) = 7,
  'live meta (image, engine state, dev buy, payment claim, run marks) is kept');
select hive_test.ok(exists (select 1 from public.locks where name = 'launch:cl-live'), 'a live launch''s lock is kept');

-- ---------- preview and dry-run data is gone
select hive_test.ok(not exists (select 1 from public.hives where status = 'mock'), 'no preview hives remain (including the one on a live cell)');
select hive_test.ok(not exists (select 1 from public.launches where mode = 'mock'), 'no preview launches remain');
select hive_test.ok(not exists (select 1 from public.actions where id in ('cl-mock-a', 'cl-mock-swarm', 'cl-live-dry')), 'preview actions and dry-run actions are gone');
select hive_test.ok(not exists (select 1 from public.actions where dry_run) and not exists (select 1 from public.harvests where dry_run), 'no dry-run rows remain');
select hive_test.ok(not exists (select 1 from public.harvests where id = 'cl-h-mock'), 'a harvest paid to a preview hive is gone');
select hive_test.ok(not exists (select 1 from public.prices where ca = 'CLMOCK'), 'preview prices are gone');
select hive_test.ok(not exists (select 1 from public.cell_claims where launch_id in ('cl-mock', 'cl-mock-pending')), 'preview cell claims are gone');
select hive_test.ok(
  not exists (select 1 from public.meta where key in ('image:CLMOCK', 'engine:hive:CLMOCK', 'engine:devOwed:CLMOCK', 'launch:devAmount:cl-mock', 'payment:sig-pay-mock')
                                         or key like 'engine:mock:%'),
  'preview meta (image, engine state, dev buy, payment claim, mock run marks) is gone');
select hive_test.ok(not exists (select 1 from public.locks where name = 'launch:cl-mock'), 'a preview launch''s lock is gone');
select hive_test.ok((select count(*) from public.secrets where pubkey in ('queen-cl-mock', 'CLMOCK')) = 2, 'preview keys are kept (never delete a keypair that might hold SOL)');

-- ---------- a second run deletes nothing
create temp table cl_before as
  select 'hives' as t, count(*) as n from public.hives union all select 'launches', count(*) from public.launches
  union all select 'actions', count(*) from public.actions union all select 'harvests', count(*) from public.harvests
  union all select 'prices', count(*) from public.prices union all select 'cell_claims', count(*) from public.cell_claims
  union all select 'meta', count(*) from public.meta union all select 'secrets', count(*) from public.secrets
  union all select 'locks', count(*) from public.locks;

\ir ../cleanup-fake-data.sql

select hive_test.ok(
  not exists (
    select 1 from cl_before b join (
      select 'hives' as t, count(*) as n from public.hives union all select 'launches', count(*) from public.launches
      union all select 'actions', count(*) from public.actions union all select 'harvests', count(*) from public.harvests
      union all select 'prices', count(*) from public.prices union all select 'cell_claims', count(*) from public.cell_claims
      union all select 'meta', count(*) from public.meta union all select 'secrets', count(*) from public.secrets
      union all select 'locks', count(*) from public.locks) a using (t)
    where a.n <> b.n),
  'running the cleanup again changes nothing');
select hive_test.ok(not exists (select 1 from pg_class where relname in ('_live_ids', '_fake_hives', '_fake_launches') and relpersistence = 't'), 'the cleanup''s temp tables are dropped at commit');
drop table cl_before;

-- leave nothing for the races
delete from public.cell_claims where launch_id like 'cl-%';
delete from public.locks where name like 'launch:cl-%';
