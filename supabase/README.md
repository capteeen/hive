# HIVE on Supabase

Without Supabase, HIVE stores everything in JSON files under `DATA_DIR` (default `.data`) and pushes
changes to browsers over Server-Sent Events (`/api/stream`). That is fine for local development and a
single mock-mode server. **Live mode requires Supabase**: it needs a durable database shared by every
server instance, plus atomic cell claims and locks.

## Setup

1. Create a Supabase project.
2. Apply the schema: paste `migrations/0001_hive.sql` into the SQL editor and run it, or use the CLI
   (`supabase link` then `supabase db push`).
3. Set the environment (server):

   | variable | where it is used |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | server and browser |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser: read-only queries and Realtime |
   | `SUPABASE_SERVICE_ROLE_KEY` | **server only**: every write. Never expose it to the browser. |

   With the URL and service key set, the server uses Postgres (`lib/server/db-supabase.ts`). With the
   anon key set too, `/api/config` tells browsers to use Supabase Realtime and `/api/stream` returns
   204. Without the anon key, browsers fall back to SSE, which carries no events in Supabase mode
   (they still re-fetch every 60 s), so set all three.

## What the migration creates

| table | visible to the browser (anon) | contents |
| --- | --- | --- |
| `hives` | read | one row per hive, the public `RemoteHive` |
| `actions` | read | queen actions (seal / store / swarm / jelly / ...) |
| `harvests` | read | hourly $HIVE harvests |
| `prices` | read | price snapshots per hive (pruned after 14 days) |
| `launches` | no | full launch records incl. the encrypted mint secret |
| `cell_claims` | no | cell reservations (`expires_at` null = permanent) |
| `secrets` | no | encrypted queen / mint keys |
| `meta`, `locks` | no | engine bookkeeping |

* Row level security is enabled on every table. Only the four public tables have a policy, and it is
  `SELECT` for `anon` and `authenticated`. The private tables have no policies at all.
* Supabase grants all privileges on new tables to `anon` / `authenticated` by default and relies on
  RLS alone. The migration also revokes write privileges (including `TRUNCATE`, which RLS does not
  cover) and every privilege on the private tables, so a later policy mistake does not open writes.
* `claim_cell(q, r, launch, expires)` and `try_lock(name, until)` are `SECURITY DEFINER` functions
  with a pinned `search_path`. Only `service_role` may execute them.
  * `claim_cell` returns false if a hive stands on the cell or another launch holds an unexpired or
    permanent claim. It deletes an expired claim on the cell first. The same launch claiming the same
    cell again gets true, which makes retries idempotent, and a launch keeps at most one pending cell.
  * `try_lock` takes the lock only when it is free or expired, in one `INSERT .. ON CONFLICT`.
* `hives`, `actions` and `harvests` are added to the `supabase_realtime` publication. The block is
  skipped if the publication does not exist or is `FOR ALL TABLES`. Browsers subscribe to `INSERT`
  and `UPDATE` on `hives`, and to `INSERT` on `actions` and `harvests`.

### Re-running

The migration is safe to run again. Tables and indexes use `IF NOT EXISTS`, functions use
`CREATE OR REPLACE`, and policies are dropped and recreated. Grants and revokes are re-applied, and
publication membership is checked before it is added. It does **not** change the columns of a table
that already exists, so put schema changes in a new numbered file (`0002_....sql`).

## Notes

* Timestamps are `timestamptz`. The app uses epoch milliseconds and converts in `lib/shared/rows.ts`,
  which also tolerates the string-typed numerics that Realtime can deliver.
* Hive images are stored in `hives.image`. Live launches store the IPFS URL. Mock launches may store a
  data URL of up to 200 KB. Realtime may drop very large values from change payloads; the browser
  keeps the image it already has, and otherwise re-fetches `/api/hives`.
* `unlock(name)` deletes the lock row without checking who holds it. Lock holders must finish within
  the `until` they asked for, or re-take the lock.

## Testing the migration locally

```sh
scripts/test-sql.sh
```

The script needs Postgres 16 binaries (`/usr/lib/postgresql/16/bin`, or set `PGBIN`). It:

1. Starts a throwaway cluster in `/tmp/hive-pg-test` on a free port. The cluster listens on 127.0.0.1
   and a private socket only. When the script runs as root, the cluster runs as the `postgres` OS user
   (set `PG_OS_USER` to change this).
2. Emulates Supabase with `tests/00_supabase_emulation.sql`: the `anon`, `authenticated` and
   `service_role` roles, Supabase's default grants, and the `supabase_realtime` publication.
3. Applies the migration **twice**.
4. Runs `tests/*.sql`, which cover the schema shape, what anon and authenticated can and cannot do,
   constraints, and the semantics of `claim_cell` and `try_lock`.
5. Races `claim_cell` and `try_lock` from 12 parallel connections and expects exactly one winner.

`KEEP=1` keeps the cluster directory for inspection. The cluster is always stopped.
