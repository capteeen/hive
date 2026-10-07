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

## What's here (Phase 1)

| Area | Where | Notes |
| --- | --- | --- |
| Theme engine | `themes/types.ts`, `themes/hive.ts`, `themes/pack.ts`, `themes/index.ts` | Copy, palette, fonts, verb names, shape language, rule parameters and the 3D scene all read from `theme`. |
| Mock simulator | `lib/sim.ts` | 60 hives on a hex grid. Every 2–5 s a few hives earn fees; queens run SEAL / STORE / SWARM by rule; swarms fly between adjacent cells; the harvest runs every mock hour (60 s); hives starve after 6 mock hours of silence and are abandoned after 24. Deterministic seed so SSR, hydration and the OG image agree. |
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

## Phase 2 (TODO) — real chain

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
