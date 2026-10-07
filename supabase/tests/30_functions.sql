-- Constraints and the atomic helpers: claim_cell, try_lock.

-- ---------- constraints
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('FN1', 0, 0, 'queen-fn1')) = 'ok:1', 'hive at (0,0)');
select hive_test.ok(hive_test.fails_with(hive_test.hive_sql('FN2', 0, 0, 'queen-fn2'), '23505'), 'a second hive on (0,0) is a unique violation');
select hive_test.ok(hive_test.fails_with(hive_test.hive_sql('FN3', 1, 0, 'queen-fn1'), '23505'), 'a queen wallet serves one hive only');
select hive_test.ok(hive_test.fails_with(replace(hive_test.hive_sql('FN4', 2, 0, 'queen-fn4'), $q$'mock')$q$, $q$'bogus')$q$), '23514'), 'status must be mock or live');
select hive_test.ok(hive_test.fails_with($q$insert into public.actions (id, ca, verb, reason, at) values ('bad', 'FN1', 'explode', '', now())$q$, '23514'), 'action verb is checked');
select hive_test.ok(hive_test.fails_with($q$update public.hives set state = 'sleeping' where ca = 'FN1'$q$, '23514'), 'hive state is checked');

-- ---------- claim_cell
select hive_test.ok(public.claim_cell(1, 1, 'A', now() + interval '15 minutes'), 'A claims (1,1)');
select hive_test.ok(not public.claim_cell(1, 1, 'B', now() + interval '15 minutes'), 'B cannot claim (1,1) while A holds it');
select hive_test.ok(public.claim_cell(1, 1, 'A', now() + interval '30 minutes'), 'A re-claiming (1,1) is idempotent');
select hive_test.ok((select expires_at > now() + interval '20 minutes' from public.cell_claims where q = 1 and r = 1), 'the retry refreshed the expiry');
select hive_test.ok(not public.claim_cell(0, 0, 'C', now() + interval '15 minutes'), 'no claim on a cell a hive stands on');

select hive_test.ok(public.claim_cell(2, 2, 'D', now() - interval '1 second'), 'D claims (2,2) with an already lapsed expiry');
select hive_test.ok(public.claim_cell(2, 2, 'E', now() + interval '15 minutes'), 'E takes (2,2) once D''s claim expired');
select hive_test.ok((select launch_id from public.cell_claims where q = 2 and r = 2) = 'E', 'the expired claim was replaced');

-- finalize = permanent: never expires, never taken over
update public.cell_claims set expires_at = null where launch_id = 'A';
select hive_test.ok(not public.claim_cell(1, 1, 'B', now() + interval '15 minutes'), 'B cannot claim a finalized cell');
select hive_test.ok(public.claim_cell(1, 1, 'A', now() + interval '15 minutes'), 'A re-claiming its finalized cell still succeeds');
select hive_test.ok((select expires_at is null from public.cell_claims where q = 1 and r = 1), '... and does not make it expire again');

-- one pending cell per launch
select hive_test.ok(public.claim_cell(3, 3, 'F', now() + interval '15 minutes'), 'F claims (3,3)');
select hive_test.ok(public.claim_cell(4, 4, 'F', now() + interval '15 minutes'), 'F claims (4,4)');
select hive_test.ok(
  (select array_agg(q || ',' || r) from public.cell_claims where launch_id = 'F') = array['4,4'],
  'F''s earlier pending claim on (3,3) was dropped');
select hive_test.ok(public.claim_cell(3, 3, 'G', now() + interval '15 minutes'), 'so G can have (3,3)');

-- release
delete from public.cell_claims where launch_id = 'G';
select hive_test.ok(public.claim_cell(3, 3, 'H', now() + interval '15 minutes'), 'a released cell is free again');

-- ---------- try_lock
select hive_test.ok(public.try_lock('engine', now() + interval '1 minute'), 'take the engine lock');
select hive_test.ok(not public.try_lock('engine', now() + interval '1 minute'), 'a held lock cannot be taken again');
select hive_test.ok(public.try_lock('harvest', now() + interval '1 minute'), 'locks are independent by name');
update public.locks set until = now() - interval '1 second' where name = 'engine';
select hive_test.ok(public.try_lock('engine', now() + interval '2 minutes'), 'an expired lock can be taken');
select hive_test.ok((select until > now() + interval '90 seconds' from public.locks where name = 'engine'), '... and gets the new expiry');
delete from public.locks where name = 'engine';
select hive_test.ok(public.try_lock('engine', now() + interval '1 minute'), 'an unlocked (deleted) lock can be taken');
