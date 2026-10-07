-- What anon / authenticated (browser keys) can and cannot do. service_role (server) can do everything.

-- seed one row everywhere, as the table owner
select hive_test.ok(hive_test.run_as(current_user, hive_test.hive_sql('SEC1', 30, 30, 'queen-sec1')) = 'ok:1', 'seed hive');
insert into public.actions (id, ca, verb, amount, reason, at) values ('sec-a1', 'SEC1', 'store', 0.1, 'seed', now());
insert into public.harvests (id, at, jelly_to) values ('sec-h1', now(), 'SEC1');
insert into public.prices (ca, at, price) values ('SEC1', now(), 0.00000028);
insert into public.launches (id, mode, state, owner, payload, queen_wallet, mint_pubkey, mint_secret_enc, cell_q, cell_r, lamports, expires_at)
  values ('sec-l1', 'mock', 'reserved', 'owner', '{"name":"x"}', 'queen-l1', 'mint-l1', 'v1.secret.secret.secret', 31, 31, 1000, now() + interval '15 minutes');
insert into public.cell_claims (q, r, launch_id, expires_at) values (31, 31, 'sec-l1', now() + interval '15 minutes');
insert into public.secrets (pubkey, enc) values ('queen-l1', 'v1.secret.secret.secret');
insert into public.meta (key, value) values ('sec-meta', 'x');
insert into public.locks (name, until) values ('sec-lock', now() + interval '1 minute');

do $$
declare
  who text;
  t text;
  res text;
begin
  foreach who in array array['anon', 'authenticated'] loop
    -- reads
    foreach t in array array['hives', 'actions', 'harvests', 'prices'] loop
      perform hive_test.ok(hive_test.count_as(who, t) > 0 and hive_test.count_as(who, t) = hive_test.count_as('service_role', t),
        format('%s can read every row of %s', who, t));
    end loop;
    foreach t in array array['launches', 'cell_claims', 'secrets', 'meta', 'locks'] loop
      perform hive_test.ok(hive_test.count_as(who, t) = -1, format('%s cannot read %s', who, t));
    end loop;

    -- writes on public tables
    perform hive_test.ok(hive_test.run_as(who, hive_test.hive_sql('EVIL', 32, 32, 'queen-evil')) = 'denied', format('%s cannot insert hives', who));
    res := hive_test.run_as(who, 'update public.hives set honey = 999');
    perform hive_test.ok(res in ('denied', 'ok:0') and (select honey from public.hives where ca = 'SEC1') = 0, format('%s cannot update hives (%s)', who, res));
    res := hive_test.run_as(who, 'delete from public.hives');
    perform hive_test.ok(res in ('denied', 'ok:0') and exists (select 1 from public.hives where ca = 'SEC1'), format('%s cannot delete hives (%s)', who, res));
    perform hive_test.ok(hive_test.run_as(who, 'truncate public.hives') = 'denied', format('%s cannot truncate hives', who));
    perform hive_test.ok(hive_test.run_as(who, $q$insert into public.actions (id, ca, verb, reason, at) values ('evil', 'SEC1', 'seal', 'x', now())$q$) = 'denied', format('%s cannot insert actions', who));
    perform hive_test.ok(hive_test.run_as(who, $q$insert into public.harvests (id, at) values ('evil', now())$q$) = 'denied', format('%s cannot insert harvests', who));
    perform hive_test.ok(hive_test.run_as(who, $q$insert into public.prices (ca, at, price) values ('SEC1', now() - interval '1 day', 1)$q$) = 'denied', format('%s cannot insert prices', who));

    -- writes on private tables
    perform hive_test.ok(hive_test.run_as(who, $q$insert into public.secrets (pubkey, enc) values ('evil', 'x')$q$) = 'denied', format('%s cannot insert secrets', who));
    perform hive_test.ok(hive_test.run_as(who, $q$update public.launches set state = 'live'$q$) = 'denied', format('%s cannot update launches', who));
    perform hive_test.ok(hive_test.run_as(who, $q$insert into public.cell_claims (q, r, launch_id) values (33, 33, 'evil')$q$) = 'denied', format('%s cannot insert cell_claims', who));
    perform hive_test.ok(hive_test.run_as(who, $q$delete from public.locks$q$) = 'denied', format('%s cannot delete locks', who));

    -- the atomic helpers are server-only
    perform hive_test.ok(hive_test.run_as(who, $q$select public.claim_cell(34, 34, 'evil', now() + interval '1 hour')$q$) = 'denied', format('%s cannot execute claim_cell', who));
    perform hive_test.ok(hive_test.run_as(who, $q$select public.try_lock('evil', now() + interval '1 hour')$q$) = 'denied', format('%s cannot execute try_lock', who));
  end loop;
end
$$;

-- nothing the browser roles tried leaked through
select hive_test.ok(not exists (select 1 from public.hives where ca = 'EVIL'), 'no EVIL hive was written');
select hive_test.ok(not exists (select 1 from public.cell_claims where launch_id = 'evil'), 'no evil claim was written');
select hive_test.ok(not exists (select 1 from public.locks where name = 'evil'), 'no evil lock was taken');

-- service_role (the server key) bypasses RLS and holds the privileges
select hive_test.ok(hive_test.count_as('service_role', 'launches') = 1, 'service_role reads launches');
select hive_test.ok(hive_test.count_as('service_role', 'secrets') = 1, 'service_role reads secrets');
select hive_test.ok(hive_test.run_as('service_role', $q$select public.try_lock('svc-lock', now() + interval '1 minute')$q$) = 'ok:1', 'service_role executes try_lock');
select hive_test.ok(hive_test.run_as('service_role', $q$update public.launches set attempts = attempts + 1 where id = 'sec-l1'$q$) = 'ok:1', 'service_role updates launches');

-- Even if someone re-grants SELECT on a private table to anon (e.g. from the dashboard), RLS still hides every row.
grant select on public.launches, public.secrets to anon;
select hive_test.ok(hive_test.count_as('anon', 'launches') = 0, 'RLS alone hides launches from anon');
select hive_test.ok(hive_test.count_as('anon', 'secrets') = 0, 'RLS alone hides secrets from anon');
revoke select on public.launches, public.secrets from anon;

-- ... and a re-granted INSERT on hives is still refused by RLS (no insert policy)
grant insert on public.hives to anon;
select hive_test.ok(hive_test.run_as('anon', hive_test.hive_sql('EVIL2', 35, 35, 'queen-evil2')) = 'denied', 'RLS alone blocks anon hive inserts');
revoke insert on public.hives from anon;
