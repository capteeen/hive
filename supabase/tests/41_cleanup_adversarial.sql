-- supabase/cleanup-fake-data.sql against data built to trick it: nothing of a live launch or live hive may
-- go, whatever its state or however its strings look; preview rows around it still go; a second run is a no-op.

-- ---------- seed
-- a live launch in every state (failed / expired / refunded ones may still hold real SOL in their queen)
insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at, ca)
select 'av-live-' || s, 'live', s, 'owner-shared', '{}', 'queen-av-live-' || s, 'AVMINT' || s, 'v1.x.x.x', 80 + i, 0, 70000000, now() - interval '1 hour',
       case when s in ('created', 'live') then 'AVMINT' || s end
  from unnest(array['reserved', 'paid', 'metadata', 'created', 'live', 'failed', 'expired', 'refunded']) with ordinality as t(s, i);
insert into public.secrets (pubkey, enc)
select 'queen-av-live-' || s, 'v1.k.k.k' from unnest(array['reserved', 'paid', 'metadata', 'created', 'live', 'failed', 'expired', 'refunded']) s
union all select 'AVMINT' || s, 'v1.k.k.k' from unnest(array['reserved', 'paid', 'metadata', 'created', 'live', 'failed', 'expired', 'refunded']) s;
-- every live launch holds its cell (finished ones permanently, the rest with an expired or pending claim)
insert into public.cell_claims (q, r, launch_id, expires_at)
select cell_q, cell_r, id, case when state = 'live' then null else now() - interval '5 minutes' end from public.launches where id like 'av-live-%';

-- live hives whose strings look like preview data
select hive_test.ok(hive_test.run_as(current_user, replace(hive_test.hive_sql('AVMINTlive', 85, 0, 'queen-av-live-live'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1', 'seed the live launch''s hive');
select hive_test.ok(hive_test.run_as(current_user, replace(hive_test.hive_sql('mock-dry-run-preview', 90, 0, 'queen-av-mocklike'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1', 'seed a live hive named like a preview one');
select hive_test.ok(hive_test.run_as(current_user, replace(hive_test.hive_sql('engine:mock:x', 91, 0, 'queen-av-colon'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1', 'seed a live hive whose ca contains engine:mock:');
select hive_test.ok(hive_test.run_as(current_user, replace(hive_test.hive_sql('AV%_live', 92, 0, 'queen-av-wild'), $q$'mock')$q$, $q$'live')$q$)) = 'ok:1', 'seed a live hive whose ca holds LIKE wildcards');
update public.hives set owner_wallet = 'owner-shared' where ca in ('AVMINTlive', 'mock-dry-run-preview');

-- preview data tangled with the live rows
insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at, ca) values
  ('av-mock', 'mock', 'live', 'owner-shared', '{}', 'queen-av-mock', 'AVMOCK', 'v1.x.x.x', 93, 0, 0, now(), 'AVMOCK'),
  -- a mock launch whose ca is null and whose expired claim sits on a failed live launch's cell
  ('av-mock-null', 'mock', 'expired', 'owner-shared', '{}', 'queen-av-mock2', 'AVMOCK2', 'v1.x.x.x', 86, 0, 0, now() - interval '1 hour', null);
insert into public.cell_claims (q, r, launch_id, expires_at) values (93, 0, 'av-mock', null), (94, 0, 'av-mock-null', now() - interval '1 minute');
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('AVMOCK', 93, 0, 'queen-av-mock')) = 'ok:1', 'seed a preview hive sharing an owner with live hives');
update public.hives set owner_wallet = 'owner-shared' where ca = 'AVMOCK';
-- a preview hive on the cell of a failed live launch (allowed by 0002's per-status cell rule)
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('AVMOCK3', 86, 0, 'queen-av-mock3')) = 'ok:1', 'seed a preview hive on a failed live launch''s cell');

insert into public.actions (id, ca, verb, amount, reason, at, dry_run, target_ca) values
  ('av-a-live', 'AVMINTlive', 'store', 0.1, 'real', now(), false, null),
  ('av-a-mocklike', 'mock-dry-run-preview', 'seal', 0.1, 'real', now(), false, null),
  ('av-a-wild', 'AV%_live', 'store', 0.1, 'real', now(), false, null),
  ('av-a-live-swarm', 'AVMINTlive', 'swarm', 0.1, 'real', now(), false, 'mock-dry-run-preview'),
  ('av-a-mock', 'AVMOCK', 'store', 0.1, 'preview', now(), false, null),
  ('av-a-live-dry', 'AVMINTlive', 'seal', 0.1, 'dry', now(), true, null);
insert into public.harvests (id, at, jelly_to, tx_sig, dry_run) values
  ('av-h-live', now(), 'mock-dry-run-preview', 'sig-av', false),
  ('av-h-mock', now(), 'AVMOCK', 'sig-av-mock', false),
  ('av-h-dry', now(), 'AVMINTlive', '', true);
insert into public.prices (ca, at, price) values ('AVMINTlive', now(), 1), ('mock-dry-run-preview', now(), 1), ('engine:mock:x', now(), 1), ('AVMOCK', now(), 1);

-- meta of the live side: images, engine state, dev buys, payment claims of live launches in every state, run marks
insert into public.meta (key, value)
select 'payment:sig-av-' || s, 'av-live-' || s from unnest(array['reserved', 'paid', 'metadata', 'created', 'live', 'failed', 'expired', 'refunded']) s
union all select 'launch:devAmount:av-live-' || s, '1' from unnest(array['created', 'live', 'failed']) s
union all select k, '{}' from unnest(array[
  'image:AVMINTlive', 'engine:hive:AVMINTlive', 'engine:devOwed:AVMINTlive',
  'image:mock-dry-run-preview', 'engine:hive:mock-dry-run-preview', 'engine:devOwed:mock-dry-run-preview',
  'image:engine:mock:x', 'engine:hive:engine:mock:x', 'image:AV%_live', 'engine:hive:AV%_live',
  'engine:live:real:lastHarvestHour', 'engine:live:dry:hubPlanned', 'engine:live:harvest:open', 'engine:live:lastRun:hourly']) k;
-- and of the preview side
insert into public.meta (key, value) values
  ('image:AVMOCK', '{}'), ('engine:hive:AVMOCK', '{}'), ('payment:sig-av-mock', 'av-mock'), ('payment:sig-av-mock-null', 'av-mock-null'),
  ('launch:devAmount:av-mock', '1'), ('engine:mock:lastRun:hourly', '{}');
insert into public.locks (name, until) values ('launch:av-live-failed', now() + interval '1 minute'), ('launch:av-mock-null', now() + interval '1 minute');

-- ---------- snapshot of everything live, then clean twice
create temp table av_keep as
  select 'launch:' || id as k from public.launches where id like 'av-live-%'
  union all select 'hive:' || ca from public.hives where status = 'live' and ca in ('AVMINTlive', 'mock-dry-run-preview', 'engine:mock:x', 'AV%_live')
  union all select 'secret:' || pubkey from public.secrets where pubkey like 'queen-av-live-%' or pubkey like 'AVMINT%'
  union all select 'claim:' || launch_id from public.cell_claims where launch_id like 'av-live-%'
  union all select 'action:' || id from public.actions where id in ('av-a-live', 'av-a-mocklike', 'av-a-wild', 'av-a-live-swarm')
  union all select 'harvest:' || id from public.harvests where id = 'av-h-live'
  union all select 'price:' || ca from public.prices where ca in ('AVMINTlive', 'mock-dry-run-preview', 'engine:mock:x')
  union all select 'meta:' || key from public.meta where key like 'payment:sig-av-%' and key not like 'payment:sig-av-mock%'
  union all select 'meta:' || key from public.meta where key like 'launch:devAmount:av-live-%' or key in ('engine:live:real:lastHarvestHour', 'engine:live:dry:hubPlanned', 'engine:live:harvest:open', 'engine:live:lastRun:hourly')
                                                       or key ~ '^(image|engine:hive|engine:devOwed):(AVMINTlive|mock-dry-run-preview|engine:mock:x|AV%_live)$'
  union all select 'lock:' || name from public.locks where name = 'launch:av-live-failed';
select hive_test.ok((select count(*) from av_keep) = 8 + 4 + 16 + 8 + 4 + 1 + 3 + 8 + 3 + 4 + 10 + 1, 'snapshot of the live side is complete');

\ir ../cleanup-fake-data.sql
\ir ../cleanup-fake-data.sql

create temp table av_now as
  select 'launch:' || id as k from public.launches
  union all select 'hive:' || ca from public.hives
  union all select 'secret:' || pubkey from public.secrets
  union all select 'claim:' || launch_id from public.cell_claims
  union all select 'action:' || id from public.actions
  union all select 'harvest:' || id from public.harvests
  union all select 'price:' || ca from public.prices
  union all select 'meta:' || key from public.meta
  union all select 'lock:' || name from public.locks;

select hive_test.ok(not exists (select k from av_keep except select k from av_now), 'nothing of a live launch (any state) or a live hive was deleted');
select hive_test.ok((select count(*) from public.launches where id like 'av-live-%' and state in ('failed', 'expired', 'refunded')) = 3, 'failed / expired / refunded live launches (may hold SOL) are kept');
select hive_test.ok(exists (select 1 from public.hives where ca = 'mock-dry-run-preview' and status = 'live'), 'a live hive named like preview data is kept');
select hive_test.ok(not exists (select 1 from public.hives where ca in ('AVMOCK', 'AVMOCK3')), 'preview hives (shared owner, on a live launch''s cell) are gone');
select hive_test.ok(not exists (select 1 from public.launches where id in ('av-mock', 'av-mock-null')), 'preview launches (with and without a ca) are gone');
select hive_test.ok(not exists (select 1 from public.cell_claims where launch_id in ('av-mock', 'av-mock-null')), 'preview claims are gone');
select hive_test.ok(not exists (select 1 from public.actions where id in ('av-a-mock', 'av-a-live-dry')), 'the preview action and the live hive''s dry run are gone');
select hive_test.ok(not exists (select 1 from public.harvests where id in ('av-h-mock', 'av-h-dry')), 'the preview and dry-run harvests are gone');
select hive_test.ok(not exists (select 1 from public.prices where ca = 'AVMOCK'), 'preview prices are gone');
select hive_test.ok(
  not exists (select 1 from public.meta where key in ('image:AVMOCK', 'engine:hive:AVMOCK', 'payment:sig-av-mock', 'payment:sig-av-mock-null', 'launch:devAmount:av-mock', 'engine:mock:lastRun:hourly')),
  'preview meta is gone');
select hive_test.ok(not exists (select 1 from public.locks where name = 'launch:av-mock-null'), 'a preview launch''s lock is gone');
select hive_test.ok((select count(*) from public.secrets where pubkey in ('queen-av-mock', 'AVMOCK', 'queen-av-mock2', 'AVMOCK2')) = 0, 'no preview secrets were seeded (none to keep)');

drop table av_keep;
drop table av_now;

-- leave nothing for the races
delete from public.cell_claims where launch_id like 'av-%';
delete from public.locks where name like 'launch:av-%';
