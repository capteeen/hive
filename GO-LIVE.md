# Going live

This takes HIVE from preview mode (simulated launches, nothing on chain) to real pump.fun coins. Do the
steps in order. Every value you copy goes into Vercel (step 7) and, for the local check in step 9, into a
`.env.local` file in the repo (never commit it; `.gitignore` already ignores it).

What "live" means once you are done:

- Only real coins are shown. The site lists hives with status `live` only; preview hives, dry runs and
  the 60 simulated demo hives never appear, even if they are still in the database.
- Every launch is a real pump.fun coin created by its queen wallet, paid for by the person launching.
- The engine (fees → seal / store / swarm, the hourly harvest) runs on a schedule you set up in step 10.

Keep `.env.example` open: it lists every variable with a one-line explanation.

---

## 1. Create the Supabase project

1. Go to <https://supabase.com>, sign in, **New project**. Pick a region close to your Vercel region
   (Vercel's default is Washington, D.C., `iad1` → Supabase `us-east-1`).
2. Set a database password and save it in your password manager (HIVE does not need it).
3. Wait until the project says it is ready.

## 2. Create the tables (SQL editor)

1. In Supabase: **SQL Editor** → **New query**.
2. Open `supabase/migrations/0001_hive.sql` from this repo, copy **all** of it, paste, **Run**.
   It should end with "Success. No rows returned".
3. New query again: paste all of `supabase/migrations/0002_live.sql`, **Run**.
4. Both files are safe to run again; if you are unsure whether a step went through, run it again.

## 3. Check that Realtime is on

Browsers hear about new hives through Supabase Realtime.

1. **Database** → **Publications** → `supabase_realtime`.
2. `hives`, `actions` and `harvests` must be switched on. Migration 0001 does this; if one is off, switch
   it on here (or run 0001 again).
3. Step 9 checks this for you too.

## 4. Copy the three Supabase values

**Project Settings** → **API** (or **API Keys**):

| copy this | into |
| --- | --- |
| Project URL (`https://<ref>.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` / publishable key (public) | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` / secret key (**secret**) | `SUPABASE_SERVICE_ROLE_KEY` |

The service-role key can write everything. It only ever goes into a variable **without** `NEXT_PUBLIC_`.

## 5. Generate the two secrets

In a terminal (macOS / Linux; on Windows use Git Bash or WSL):

```sh
openssl rand -base64 32   # → QUEEN_KEY_SECRET
openssl rand -hex 32      # → CRON_SECRET
```

- `QUEEN_KEY_SECRET` encrypts every queen wallet's key. **Back it up now** (password manager plus an
  offline copy). See "About QUEEN_KEY_SECRET" at the end before you continue.
- `CRON_SECRET` is the password your cron service uses to start the engine (step 10).

## 6. Get an RPC and a Helius key

1. Create a free account at <https://dashboard.helius.dev>. Copy the **API key** → `HELIUS_API_KEY`.
   The free tier is fine to start.
2. Server RPC → `SOLANA_RPC_URL`: `https://mainnet.helius-rpc.com/?api-key=<your key>` (or any paid
   mainnet RPC). The public `api.mainnet-beta.solana.com` is not enough for live mode.
3. Browser RPC → `NEXT_PUBLIC_RPC`: wallets use it to send the launch payment. It is visible to every
   visitor, so use a separate key restricted to your domain (Helius → API key → access control), or a
   provider's public endpoint.

## 7. Set the environment on Vercel

Vercel → your project → **Settings** → **Environment Variables**. Add each one for **Production**
(and Preview if you use preview deployments with their own database):

| variable | value |
| --- | --- |
| `LAUNCH_MODE` | `live` |
| `ENGINE_DRY_RUN` | `1` for the first day (step 12 turns it off) |
| `NEXT_PUBLIC_DEMO_HIVES` | not set (or `0`) |
| `NEXT_PUBLIC_SUPABASE_URL` | step 4 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | step 4 |
| `SUPABASE_SERVICE_ROLE_KEY` | step 4 |
| `QUEEN_KEY_SECRET` | step 5 |
| `CRON_SECRET` | step 5 |
| `SOLANA_RPC_URL` | step 6 |
| `NEXT_PUBLIC_RPC` | step 6 |
| `HELIUS_API_KEY` | step 6 |
| `NEXT_PUBLIC_SITE_URL` | your public URL, e.g. `https://hive.example` |
| `HUB_WALLET`, `HUB_WALLET_SECRET`, `HUB_TOKEN_MINT` | not yet: see step 13 |

Optional: `PRIORITY_FEE_SOL` (default `0.0005`), `SLIPPAGE_PCT` (default `10`).

## 8. Redeploy

Variables starting with `NEXT_PUBLIC_` are built into the page, so a redeploy is required:
**Deployments** → the latest one → **⋯** → **Redeploy** (untick "use existing build cache").

## 9. Check the setup

1. Open `https://<your site>/api/health`. You want `"ok": true` and an empty `"problems"` list.
   `"warnings"` tell you what is still worth fixing (each says how). It only shows yes/no facts and
   counts, never a key.
2. On your computer, in the repo: copy `.env.example` to `.env.local`, fill in the same values as on
   Vercel, then run

   ```sh
   npm install
   npm run check:live
   ```

   Every line is `✓` (fine), `!` (worth fixing) or `✗` (must fix, with the fix on the next line). It
   checks the shape of every value (for example that `QUEEN_KEY_SECRET` is 32 bytes, that `HUB_WALLET` is
   the public key of `HUB_WALLET_SECRET`), that Supabase has every table, function and the Realtime setup,
   that the anon key can read hives, and that the RPC, Helius, PumpPortal and pump.fun answer. It never
   prints a secret. `npm run check:live -- --offline` skips the network part.

## 10. Schedule the engine

The engine runs when something calls two URLs. Vercel Hobby only allows daily cron jobs, so use a free
external scheduler:

1. Create an account at <https://cron-job.org>.
2. **Create cronjob**:
   - URL: `https://<your site>/api/cron/hourly`
   - Schedule: every hour, at minute `0`
   - **Advanced** → **Headers** → add `Authorization` with the value `Bearer <CRON_SECRET>`
     (the word `Bearer`, a space, then your secret)
   - Request method `GET`, timeout as long as allowed (the run can take up to 5 minutes; a timeout on
     cron-job.org's side does not stop the run)
3. Second cronjob: URL `https://<your site>/api/cron/refresh`, every 5 minutes (minutes `2,7,12,…,57`
   if the site lets you; otherwise every 5 minutes is fine), same header.
4. Press **Test run** on the hourly job. The response is JSON: `"ok": true`, `"dryRun": true`, and
   `"dryRunFeed"` lists what the queens would have done. Wrong secret → `401`.

**Vercel Pro instead:** add to `vercel.json`

```json
"crons": [
  { "path": "/api/cron/hourly", "schedule": "0 * * * *" },
  { "path": "/api/cron/refresh", "schedule": "2-59/5 * * * *" }
]
```

Vercel sends `Authorization: Bearer $CRON_SECRET` itself.

If Vercel refuses the 300-second function duration on your plan, turn on **Fluid compute**
(Project → Settings → Functions).

## 11. The first real launch

1. Open the site, connect a wallet with a little SOL (launch cost + queen reserve + your dev buy; the
   wizard shows the total).
2. Launch a test coin with a **small dev buy** (e.g. 0.01 SOL). Sign the message (free), then approve the
   payment.
3. Watch the progress steps. When it says live:
   - the coin opens on pump.fun (link on the hive page) with your image and name;
   - Solscan shows the create transaction from the queen wallet;
   - your dev-buy tokens arrive in your wallet;
   - the hive appears on `/comb` in a second browser without reloading (Realtime works).
4. If a step fails, the launch page offers **Retry**, and a launch that cannot finish can be
   **refunded** (signed by the paying wallet). Nothing is lost by closing the tab: it resumes.
5. After the next full hour, `/api/health` → `engine.lastHourly` is set, and the cron-job.org history
   shows `200`.

## 12. Turn the dry run off

After a day of dry runs whose `dryRunFeed` looks sensible (seal when the price dips, store otherwise,
swarm only with lots of honey):

1. Vercel → `ENGINE_DRY_RUN` = `0` → redeploy.
2. From the next hour the queens claim fees and trade for real. Real actions appear in the public log
   with Solscan links. (Dry-run rows were never shown publicly in live mode.)

## 13. The $HIVE token and the hub

Until `HUB_*` is set, queens keep the 20% hub share and the hourly harvest is skipped (recorded as a
dry run, not shown). When `$HIVE` exists:

1. Create a dedicated hub wallet (e.g. `solana-keygen new -o hub.json`). Fund it with a little SOL for fees.
2. Set on Vercel:
   - `HUB_WALLET`: its public key (`solana-keygen pubkey hub.json`)
   - `HUB_WALLET_SECRET`: the contents of `hub.json` (the `[12,34,…]` array) or the base58 secret key
   - `HUB_TOKEN_MINT`: the `$HIVE` mint address
3. Redeploy, then `npm run check:live` (it verifies the secret belongs to `HUB_WALLET`) and `/api/health`
   (`hub.ready: true`). The harvest page then shows the real `$HIVE` address.

## 14. Wipe the test data

Anything you tried in preview mode against this database (preview hives, preview launches, dry-run rows)
is hidden in live mode but still stored. To delete it:

1. Supabase → **SQL Editor** → **New query**.
2. Paste all of `supabase/cleanup-fake-data.sql` → **Run**. The result table shows what is left.

It runs in one transaction, can be run any number of times, and never deletes a live launch, a live hive
or anything belonging to them. It keeps the encrypted keys of preview launches (a preview queen address is
a real wallet; if anyone ever sent SOL to it, that key is the only way to get it back).

Local file store (no Supabase): stop the dev server and delete the `.data` folder (or your `DATA_DIR`).

---

## About QUEEN_KEY_SECRET

Every queen wallet's private key is stored in Supabase **encrypted with `QUEEN_KEY_SECRET`**. The
queens hold the honey (SOL) and the creator fees of every hive.

- **Lose it and every queen wallet is gone for good**, with the SOL in it. Nobody, including Supabase,
  can recover it.
- **Leak it together with a database backup and anyone can empty every queen.** Keep it only in
  Vercel's environment variables, your password manager and one offline copy.
- **Never change it** once a live launch exists: keys encrypted with the old value no longer decrypt.
- A Supabase backup without this secret is useless for the queens, and this secret without the
  database is useless too. Back up both.

## When something is wrong

| symptom | where to look |
| --- | --- |
| Launch button says live mode is not configured | `/api/health` → `problems` |
| Hives only appear after a reload | step 3 (Realtime) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| Nothing happens on the hour | cron-job.org history; `401` = wrong `Authorization` header |
| Bees stay at 0 | `HELIUS_API_KEY` |
| Harvest page says "not launched yet" | step 13 |
