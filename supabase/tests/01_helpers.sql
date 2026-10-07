-- Test helpers (schema hive_test). Run after the migration.

create schema if not exists hive_test;

-- Assert: raise (and stop psql) on failure, print a NOTICE on success.
create or replace function hive_test.ok(cond boolean, what text) returns void
language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'FAIL: %', what;
  end if;
  raise notice 'ok - %', what;
end
$$;

-- Run `stmt` as `who`. 'denied' on insufficient_privilege (also RLS WITH CHECK violations),
-- otherwise 'ok:<rows affected>'. Changes made by a successful statement are kept.
create or replace function hive_test.run_as(who text, stmt text) returns text
language plpgsql as $$
declare
  n bigint;
  res text;
begin
  execute format('set local role %I', who);
  begin
    execute stmt;
    get diagnostics n = row_count;
    res := 'ok:' || n;
  exception when insufficient_privilege then
    res := 'denied';
  end;
  execute 'reset role';
  return res;
end
$$;

-- Rows of public.<tbl> visible to `who`; -1 when the role may not read the table at all.
create or replace function hive_test.count_as(who text, tbl text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute format('set local role %I', who);
  begin
    execute format('select count(*) from public.%I', tbl) into n;
  exception when insufficient_privilege then
    n := -1;
  end;
  execute 'reset role';
  return n;
end
$$;

-- True when `stmt` fails with SQLSTATE `state` (e.g. 23505 unique_violation, 23514 check_violation).
create or replace function hive_test.fails_with(stmt text, state text) returns boolean
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate <> state then
      raise notice 'expected %, got %: %', state, sqlstate, sqlerrm;
    end if;
    return sqlstate = state;
  end;
  return false;
end
$$;

-- A minimal valid hive row.
create or replace function hive_test.hive_sql(ca text, q int, r int, queen text) returns text
language sql as $$
  select format(
    'insert into public.hives (ca, name, ticker, cell_q, cell_r, queen_wallet, owner_wallet, status) values (%L, %L, %L, %s, %s, %L, %L, %L)',
    ca, 'Hive ' || ca, 'HV', q, r, queen, 'owner-' || ca, 'mock');
$$;
