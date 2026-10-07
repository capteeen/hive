# HIVE — every coin is a beehive

Every coin launched through HIVE is a beehive. Every holder is a bee. The coin's agent is the
queen. She runs the hive with its creator fees using three verbs: **SEAL** (burn), **STORE**
(accumulate honey) and **SWARM** (buy a neighbor). 20% of every hive's fees buy `$HIVE` on the
hour; the hub **HARVESTS**: half is burned, half goes to the biggest hive.

HIVE is built as an **engine**. The hive skin is one config file; `themes/pack.ts` (wolves,
dens, an alpha, cull / cache / hunt, circular den map) proves a second skin works by swapping
one import.

```
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
npm run typecheck
```

**Going live with real pump.fun coins: follow [`GO-LIVE.md`](GO-LIVE.md)** (Supabase, keys, Vercel env,
the engine schedule, the first launch, wiping test data). `npm run check:live` and `GET /api/health`
show what is still missing.

## What's here (Phase 1)

| Area | Where | Notes |
| --- | --- | --- |
| Theme engine | `themes/types.ts`, `themes/hive.ts`, `themes/pack.ts`, `themes/index.ts` | Copy, palette, fonts, verb names, shape language, rule parameters and the 3D scene all read from `theme`. |
| Mock simulator | `lib/sim.ts` | Demo only (`NEXT_PUBLIC_DEMO_HIVES=1`, off by default): 60 hives on a hex grid. Every 2–5 s a few hives earn fees; queens run SEAL / STORE / SWARM by rule; swarms fly between adjacent cells; the harvest runs every mock hour (60 s); hives starve after 6 mock hours of silence and are abandoned after 24. Deterministic seed so SSR, hydration and the OG image agree. |
| Store | `lib/store.ts` | Zustand. Ticks the simulator every 250 ms, exposes `world`, `stats`, night/day mode, sound, the session's founded hives, mock positions. |
| The comb | `lib/comb3d.ts`, `components/comb/CombScene.tsx` | Three.js, orthographic camera at 30° tilt, instanced hex prisms (depth = holders, fill = honey, colour = state), physically based honey with transmission, UnrealBloom kept subtle, drag to pan, scroll / pinch to zoom, click a cell to open the hive. Every animation is driven by a `SceneEvent` emitted for one logged action. For `theme.scene === 'den'` the same renderer lays cells out on concentric rings with cylindrical cells. |
| Bees | `lib/comb3d.ts` (`beeGeometry`, `writeBee`) | Instanced bees with a striped abdomen, golden thorax, dark head and four translucent wings, plus a soft shadow on the honey. They wander over their own cell, land on the rim to rest, and lift off again; ≤ 30 per cell (real count on hover). Each living cell has a queen: larger, slower, near the centre, white for the biggest hive. Starving cells' bees turn grey and drift off. |
| Founding | `CombRenderer.found`, `flyTo`, `project` | Launching is shown on the comb: the camera flies to the edge, a new cell's walls rise, honey pours in, the queen descends and a stream of bees arrives from off-screen. The launch modal routes to `/comb?focus=<ca>`, which replays the sequence for a hive founded in this session, pins a tracking label to the cell and shows a card with the queen wallet and a link to the hive page. |
| Pages | `app/` | `/` hero + steps + stats + log + explore + leaderboard, `/comb`, `/hive/[ca]` (single-cell 3D, price chart with verb markers, queen log, swarms in/out), `/harvest`, `/leaderboard`, `/how`, `/me`. |
| OG image | `app/hive/[ca]/opengraph-image.tsx` | Per hive: faux-3D cell render (SVG, no WebGL), name, honey, bees, state. |
| Launch modal | `components/LaunchModal.tsx` | Spread-style breakdown, wired to the Solana wallet adapter (Phantom, Solflare, plus Wallet Standard wallets such as Backpack). Launch is mocked: it signs a message if the wallet allows, then founds a hive at the comb's edge. |

Mock time: `HOUR_MS` in `lib/sim.ts` is 60 000 ms. Set it to 3 600 000 for production cadence.

Debug: `?gpu=desktop` / `?gpu=mobile` forces the renderer's quality path; `window.__comb` exposes the live renderer.

### Swapping the skin

Edit `themes/index.ts`:

```ts
import { pack } from './pack';
export const theme = pack;
```

Everything re-skins: copy, palette, fonts, verb labels, the hub token, rule text on `/how`,
the shape language (hex clip-paths become circles) and the 3D scene (circular den map with
cylindrical cells instead of a honeycomb).

### The queen's rules (also on `/how`)

Each hour, after the hub takes 20%, the queen allocates the remaining 80%:

- **SEAL** — price below the 24h average: 40% of the hour's fees buy and burn, 60% are stored.
- **STORE** — default: at least 60% to the vault as honey; with nothing to seal, the full budget is stored.
- **SWARM** — honey above 2× the hourly fee average: 25% of honey buys the coin of the nearest
  hive on the map with the highest fee growth.
- **STARVE** — 6 consecutive zero-fee hours: bees leave, comb greys. 24 hours: abandoned, vault
  paid out pro-rata, cell stays as grey comb.

No LLM is in the money path.

## Multi-user, launches and the queen engine

Everything below works out of the box in **mock mode** (the default): launches are simulated, but
they are real records on the server, so every visitor sees every hive appear on the comb live.

```
npm run dev                 # mock mode, file store under .data/, live feed over SSE
npm test                    # unit/integration tests (vitest)
bash scripts/test-sql.sh    # the Supabase migrations + cleanup script on a throwaway Postgres 16 (148 assertions)
npm run check:live          # is this environment ready for live mode? (reads .env.local / .env)
```

The comb starts empty: no simulated hives unless `NEXT_PUBLIC_DEMO_HIVES=1` (local play). Preview
launches are labelled as previews. To start over locally, stop the server and delete `.data` (or your
`DATA_DIR`).

### Only real hives in live mode

With `LAUNCH_MODE=live` the public only ever sees real chain data (`lib/shared/visibility.ts`):
`/api/hives`, `/api/hives/[ca]` (and its image), `/api/stream` and the browser's Supabase Realtime
handling carry hives with status `live` only, and only actions / harvests that were really sent (no dry
runs) for live hives. Preview rows left in a live database are ignored by the engine, never block a real
launch's cell (`claim_live_cell`, migration 0002), and can be deleted with
`supabase/cleanup-fake-data.sql`. A dry run's plan is shown to the admin in the JSON answer of
`/api/cron/hourly` (`dryRunFeed`), never on the site.

### How other users' hives reach you

- The server stores hives, actions, harvests and prices behind one interface (`lib/server/db.ts`):
  a JSON file store (`DATA_DIR`, default `.data`, `/tmp/hive-data` on Vercel) or Supabase.
- Browsers load `/api/hives`, then listen for changes: Supabase Realtime when Supabase is configured,
  otherwise Server-Sent Events from `/api/stream`. New hives play the founding animation for everyone.
- Your own hives are the ones whose owner is your connected wallet (or, in mock mode without a
  wallet, an anonymous id stored in your browser).
- `/api/hives` carries at most 1,000 hives (abandoned, then the oldest, are left out first; their
  cells stay taken) and may be cached by a CDN for 5 s. Uploaded (data-URL) hive images are not in the
  list: they are stored separately (Supabase `meta` row `image:<ca>`, or `DATA_DIR/images/`) and served
  by `/api/hives/[ca]/image`.
- `/api/stream` allows 200 connections per server process and 6 per identifiable client address, and
  drops a connection that stops reading (512 KB unread). Browsers then fall back to re-fetching the list.
  With Supabase but no anon key, the stream polls the database every few seconds instead of Realtime.

**On Vercel you need Supabase for real multi-user.** Serverless instances do not share `/tmp`, so the
file store is only for local development and single-server deployments. Setup:
[`GO-LIVE.md`](GO-LIVE.md) and [`supabase/README.md`](supabase/README.md) (run
`supabase/migrations/0001_hive.sql` then `0002_live.sql`, set the three Supabase env vars).

### Launching

The wizard (Queen look → Temperament → Rules → Coin → Dev buy + launch) calls:

1. `POST /api/launch`: validates, reserves a free edge cell (the one you clicked, or the nearest free
   one), generates the queen and mint keypairs (encrypted at rest), and returns the amount to pay.
2. Live mode only: you sign a message proving the wallet is yours, then send one SOL transfer to your
   queen's wallet.
3. `POST /api/launch/[id]/confirm`: verifies the payment on chain, uploads the image and metadata to
   IPFS (pump.fun), creates the coin through PumpPortal with the queen as creator (plus the optional
   dev buy, whose tokens are sent to your wallet; if that transfer fails, the hourly engine sends them,
even in dry-run), and publishes the hive. Every step is idempotent and
   resumable; closing the tab and coming back resumes the launch. Failed launches can be refunded.

### The queen engine

`/api/cron/hourly` runs every hive's queen (claim creator fees → 20% to the hub → seal / store /
swarm by her rules) and then the harvest (the hub buys $HIVE, burns half, sends half to the biggest
hive). `/api/cron/refresh` updates honey, bees and price. In mock mode a local server runs both on its
own (`instrumentation.ts`; `ENGINE_AUTORUN=0` turns it off). In production, call them on a schedule:

- **Vercel Pro**: add to `vercel.json`
  `"crons": [{ "path": "/api/cron/hourly", "schedule": "0 * * * *" }, { "path": "/api/cron/refresh", "schedule": "2-59/5 * * * *" }]`.
  Vercel Hobby only allows daily crons, so this is not in the repo by default.
- **Anywhere else** (cron-job.org, GitHub Actions, a VPS): `GET /api/cron/hourly` and
  `GET /api/cron/refresh` with `Authorization: Bearer $CRON_SECRET`.

In live mode the engine only **records** what it would do (`dryRun`) until you set `ENGINE_DRY_RUN=0`.
Those records stay off the public site; the cron route's JSON (`dryRunFeed`) shows them. The engine
writes when each job last ran (meta `engine:<mode>:lastRun:<job>`), which `/api/health` reports.

### Environment

| variable | default | purpose |
| --- | --- | --- |
| `LAUNCH_MODE` | `mock` | `live` sends real transactions |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | unset | Supabase (required for live mode and for multi-user on Vercel) |
| `SOLANA_RPC_URL` | public mainnet RPC | server RPC (use a paid one for live) |
| `NEXT_PUBLIC_RPC` | public mainnet RPC | the wallet's RPC in the browser |
| `QUEEN_KEY_SECRET` | mock only: a dev key in `DATA_DIR`, or derived from `SUPABASE_SERVICE_ROLE_KEY` (HKDF-SHA256) when Supabase is configured | 32-byte key (base64 or hex) that encrypts queen and mint keys; **required in live mode** |
| `CRON_SECRET` | unset | bearer token for the cron routes (unset = only allowed in mock mode); 32+ random characters |
| `ENGINE_DRY_RUN` | `1` | live mode: record actions without sending |
| `HUB_WALLET`, `HUB_WALLET_SECRET`, `HUB_TOKEN_MINT` | unset | the harvest wallet and the $HIVE mint |
| `HELIUS_API_KEY` | unset | holder counts (bees) and the holder list for abandon payouts, via Helius DAS |
| `PRIORITY_FEE_SOL`, `SLIPPAGE_PCT` | `0.0005`, `10` | trade settings |
| `NEXT_PUBLIC_DEMO_HIVES` | unset (off) | `1` shows the 60 simulated demo hives (local play; never in production). Read at build time too: redeploy after changing it |
| `NEXT_PUBLIC_SITE_URL` | unset | the public URL (coin metadata links to it) |
| `DATA_DIR` | `.data` (`/tmp/hive-data` on Vercel) | file store location |
| `TRUST_PROXY` | unset | how many reverse proxies to trust for the client address (`X-Forwarded-For`). Ignored on Vercel, which sets it reliably. Unset on a self-hosted server: every client shares one rate-limit bucket (12 launch prepares per 10 min, 40 confirms/min, 120 status reads/min, 10 refunds per 10 min), so set it to `1` behind nginx/Caddy |

### Before turning on live mode

- Verify the PumpPortal request bodies (`lib/server/chain-live.ts`) and pump.fun's IPFS endpoint
  against their current docs: this sandbox could not reach them, so they are tested against mocks only.
- Fund nothing until a full launch has been run end to end on mainnet with a small dev buy.
- `GET /api/config` shows the mode; `liveModeProblems()` refuses live launches until the required
  env vars are set (and `QUEEN_KEY_SECRET` decodes to 32 bytes). `GET /api/health` reports that list plus
  the Supabase schema / Realtime state, RPC reachability and the engine's last runs (booleans and counts
  only, never a key); `npm run check:live` checks the same from a terminal with a fix for each problem.
- PumpPortal transactions are checked before the queen signs them: only ComputeBudget, System, SPL
  Token / Token-2022, Associated Token, pump and PumpSwap programs are allowed, the priority fee is
  capped at 2 × `PRIORITY_FEE_SOL`, and a buy may not spend more than asked. If PumpPortal starts adding
  another program (a memo or a tip), trades fail safe until it is added to the allow-list.
- Abandon payouts need `HELIUS_API_KEY`: without a complete holder list, a starving hive waits and
  retries every hour instead of paying. Past 100 holders, the 100 largest share the vault pro rata.

## Phase 2 notes (historical)

Everything below is stubbed or absent; the simulator is the only data source today.

1. **Launch** — `POST /api/launch`: generate the queen keypair server-side (KMS / encrypted at
   rest), return its pubkey; the user pays launch cost + queen reserve + dev buy to it; the server
   launches the coin via PumpPortal's `create` with the queen as creator and the optional dev buy,
   stores `{ ca, queenWallet, cell }`, and assigns the next free spiral cell (persisted so hex
   placement is stable).
2. **Hourly cron (UTC, on the hour)**
   - For each hive: claim creator fees to the queen wallet (PumpPortal `collectCreatorFee`).
   - Route 20% to the hub wallet; sum → buy `$HIVE` via Jupiter; burn 50% (`burn` on the token
     account); transfer 50% to the top hive's queen wallet (royal jelly). Record a `Harvest` with the
     tx signature; post it from the X account.
   - Run the queen rules server-side against real numbers (price vs 24h average from Jupiter price
     history, honey = queen vault balance, hourly fee average from claims). SEAL: Jupiter buy then
     `burn`. STORE: no-op transfer (vault is the wallet). SWARM: Jupiter buy of the target coin from
     the queen wallet. Each action is written as an `Action` with `txSig`.
   - STARVE / ABANDON: from claim history. Abandon pays the vault out pro-rata to holders by DAS
     snapshot (batch SOL transfers), then marks the hive abandoned.
3. **Holders** — Helius DAS `getTokenAccounts` per CA, cached per minute; bees = distinct owners.
4. **Price** — Jupiter price API per minute into `priceHistory`; 24h average from the same series.
5. **Feed** — replace the Zustand simulator tick with a WebSocket / SSE stream of `World` deltas
   and `SceneEvent`s so the comb animates on real transactions.
6. **/me** — positions from DAS by connected wallet; claimable payouts from the abandon ledger.
7. **OG image** — read the hive row from the database instead of the seeded world.

### Disclaimer

Coins launch on pump.fun (Solana). A meme, not an investment. Crypto is risky. Only use what you
can afford to lose.
