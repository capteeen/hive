#!/usr/bin/env node
/**
 * npm run check:live — is this environment ready for LAUNCH_MODE=live?
 *
 * Reads .env.local and .env from the repo root (the shell's environment wins, like Next.js), checks
 * every live-mode variable for presence and shape, then probes Supabase, the Solana RPC, Helius,
 * PumpPortal and pump.fun's IPFS endpoint (each with a timeout; a blocked network is reported, not
 * fatal). Prints a checklist: ✓ ok, ✗ must fix (with the one-line fix), ! worth fixing. Exit code 1
 * when anything is ✗.
 *
 * Never prints a secret: values are only ever described (set / length / valid), and URLs that may carry
 * an API key are not echoed.
 *
 *   npm run check:live
 *   npm run check:live -- --env path/to/.env.production   # read this file instead of .env.local / .env
 *   npm run check:live -- --offline                       # shape checks only, no network
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TABLES = ['hives', 'actions', 'harvests', 'prices', 'launches', 'cell_claims', 'secrets', 'meta', 'locks'];
export const RPCS = ['claim_cell', 'try_lock'];
const TIMEOUT_MS = 6000;

/* ---------- env files ---------- */

/** KEY=value lines; `export ` prefixes, quotes and trailing ` # comments` (unquoted) are handled. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) {
      v = v.slice(1, v.lastIndexOf(q));
      if (q === '"') v = v.replace(/\\n/g, '\n');
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/** .env, then .env.local over it, then the process environment over both (Next.js precedence). */
export function loadEnv(argv = process.argv.slice(2), env = process.env, root = ROOT) {
  const i = argv.indexOf('--env');
  const files = i >= 0 && argv[i + 1] ? [path.resolve(argv[i + 1])] : [path.join(root, '.env'), path.join(root, '.env.local')];
  const merged = {};
  const read = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    Object.assign(merged, parseEnv(readFileSync(f, 'utf8')));
    const rel = path.relative(root, f);
    read.push(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f);
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') merged[k] = v;
  return { env: merged, files: read };
}

/* ---------- shape checks ---------- */

const val = (env, k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : undefined);
const falsy = (v) => /^(0|false|no|off)$/i.test(v ?? '');

/** A base58 string that decodes to 32 bytes (a Solana address). */
export function isPubkey(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** The public key (base58) of a secret key given as base58 (64 bytes) or a JSON byte array; null if invalid. */
export function pubkeyOfSecret(raw) {
  try {
    const t = String(raw).trim();
    const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
    if (bytes.length !== 64) return null;
    const kp = nacl.sign.keyPair.fromSeed(bytes.slice(0, 32));
    // the second half of a Solana secret key is its public key: they must agree
    if (bs58.encode(kp.publicKey) !== bs58.encode(bytes.slice(32))) return null;
    return bs58.encode(kp.publicKey);
  } catch {
    return null;
  }
}

/** QUEEN_KEY_SECRET as lib/server/keys.ts reads it: 64 hex chars, or base64 of exactly 32 bytes. */
export function queenKeyBytes(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return 32;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return 0;
  return Buffer.from(raw, 'base64').length;
}

const isHttps = (s) => {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Every live-mode variable: [{ name, status: 'ok' | 'fail' | 'warn', detail, fix }]. `detail` never
 * contains a value of a secret.
 */
export function checkEnv(env) {
  const out = [];
  const add = (name, status, detail, fix = '') => out.push({ name, status, detail, fix });

  const mode = val(env, 'LAUNCH_MODE');
  if (mode === 'live') add('LAUNCH_MODE', 'ok', 'live');
  else add('LAUNCH_MODE', 'fail', mode ? `"${mode}" (preview mode)` : 'not set (preview mode)', 'Set LAUNCH_MODE=live once everything below is green.');

  const url = val(env, 'NEXT_PUBLIC_SUPABASE_URL');
  if (!url) add('NEXT_PUBLIC_SUPABASE_URL', 'fail', 'not set', 'Supabase dashboard → Project Settings → API → Project URL.');
  else if (!isHttps(url) || new URL(url).pathname.replace(/\/+$/, '') !== '') add('NEXT_PUBLIC_SUPABASE_URL', 'fail', 'not an https URL without a path', 'Use the Project URL as shown, e.g. https://abcd.supabase.co (no /rest/v1).');
  else add('NEXT_PUBLIC_SUPABASE_URL', 'ok', 'set');

  const jwtish = (s) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s) || /^sb_(publishable|secret)_[\w-]{10,}$/.test(s);
  const anon = val(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (!anon) add('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fail', 'not set', 'Supabase → Project Settings → API → anon / publishable key.');
  else if (!jwtish(anon)) add('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'warn', 'does not look like a Supabase key', 'Copy the anon (public) key again.');
  else if (/^sb_secret_/.test(anon)) add('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fail', 'is a SECRET key: it would be sent to every browser', 'Use the anon / publishable key here, never the service_role / secret key.');
  else add('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ok', 'set');

  const service = val(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!service) add('SUPABASE_SERVICE_ROLE_KEY', 'fail', 'not set', 'Supabase → Project Settings → API → service_role / secret key (server only).');
  else if (!jwtish(service)) add('SUPABASE_SERVICE_ROLE_KEY', 'warn', 'does not look like a Supabase key', 'Copy the service_role key again.');
  else if (service === anon) add('SUPABASE_SERVICE_ROLE_KEY', 'fail', 'equals the anon key', 'Use the service_role / secret key, not the anon key.');
  else add('SUPABASE_SERVICE_ROLE_KEY', 'ok', 'set');

  const qk = val(env, 'QUEEN_KEY_SECRET');
  if (!qk) add('QUEEN_KEY_SECRET', 'fail', 'not set', 'Generate one with `openssl rand -base64 32` and back it up offline: losing it loses every queen wallet.');
  else if (queenKeyBytes(qk) !== 32) add('QUEEN_KEY_SECRET', 'fail', `decodes to ${queenKeyBytes(qk)} bytes, not 32`, 'Use the output of `openssl rand -base64 32` (or 64 hex characters).');
  else add('QUEEN_KEY_SECRET', 'ok', '32 bytes');

  const cron = val(env, 'CRON_SECRET');
  if (!cron) add('CRON_SECRET', 'fail', 'not set', 'Generate one with `openssl rand -hex 32`; the cron service sends it as `Authorization: Bearer <CRON_SECRET>`.');
  else if (cron.length < 32) add('CRON_SECRET', 'warn', `only ${cron.length} characters`, 'Use at least 32 random characters (`openssl rand -hex 32`).');
  else add('CRON_SECRET', 'ok', `${cron.length} characters`);

  const rpc = val(env, 'SOLANA_RPC_URL');
  if (!rpc) add('SOLANA_RPC_URL', 'fail', 'not set (the public RPC rate-limits hard)', 'Use a paid RPC, e.g. https://mainnet.helius-rpc.com/?api-key=<key>.');
  else if (!isHttps(rpc)) add('SOLANA_RPC_URL', 'fail', 'not an https URL', 'Use your RPC provider\'s https URL.');
  else if (/api\.mainnet-beta\.solana\.com/.test(rpc)) add('SOLANA_RPC_URL', 'warn', 'the public mainnet RPC', 'Use a paid RPC: the public one rejects bursts of transactions.');
  else add('SOLANA_RPC_URL', 'ok', 'https URL set');

  const pubRpc = val(env, 'NEXT_PUBLIC_RPC');
  if (!pubRpc) add('NEXT_PUBLIC_RPC', 'warn', 'not set: wallets use the public mainnet RPC', 'Set a browser-safe RPC URL (it is visible to everyone: use a key restricted to your domain).');
  else if (!isHttps(pubRpc)) add('NEXT_PUBLIC_RPC', 'fail', 'not an https URL', 'Use an https RPC URL.');
  else add('NEXT_PUBLIC_RPC', 'ok', 'https URL set');

  const helius = val(env, 'HELIUS_API_KEY');
  if (!helius) add('HELIUS_API_KEY', 'warn', 'not set: bee counts stay 0, abandon payouts wait', 'Free key at https://dashboard.helius.dev.');
  else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(helius)) add('HELIUS_API_KEY', 'warn', 'not shaped like a Helius key (a UUID)', 'Copy the key from the Helius dashboard.');
  else add('HELIUS_API_KEY', 'ok', 'set');

  const site = val(env, 'NEXT_PUBLIC_SITE_URL');
  if (!site) add('NEXT_PUBLIC_SITE_URL', 'warn', 'not set', 'Set your public URL, e.g. https://hive.example (links and previews).');
  else if (!isHttps(site)) add('NEXT_PUBLIC_SITE_URL', 'warn', 'not an https URL', 'Use the https URL people visit.');
  else add('NEXT_PUBLIC_SITE_URL', 'ok', 'set');

  const demo = val(env, 'NEXT_PUBLIC_DEMO_HIVES');
  if (demo && !falsy(demo)) add('NEXT_PUBLIC_DEMO_HIVES', 'fail', 'on: 60 simulated hives would show next to real ones', 'Unset it (or set 0) and redeploy.');
  else add('NEXT_PUBLIC_DEMO_HIVES', 'ok', 'off');

  const dry = val(env, 'ENGINE_DRY_RUN');
  if (dry && falsy(dry)) add('ENGINE_DRY_RUN', 'ok', 'off: the engine sends real transactions');
  else add('ENGINE_DRY_RUN', 'warn', 'on: the engine only records what it would do (right for the first day)', 'Set ENGINE_DRY_RUN=0 once a dry run\'s /api/cron/hourly output looks right.');

  // the hub ($HIVE harvest): optional until the token exists
  const hubWallet = val(env, 'HUB_WALLET');
  const hubSecret = val(env, 'HUB_WALLET_SECRET');
  const hubMint = val(env, 'HUB_TOKEN_MINT');
  if (!hubWallet && !hubSecret && !hubMint) add('HUB_*', 'warn', 'not set: harvests are skipped (recorded as dry runs) until $HIVE exists', 'Set HUB_WALLET, HUB_WALLET_SECRET and HUB_TOKEN_MINT once the $HIVE token is live.');
  else {
    if (hubWallet && !isPubkey(hubWallet)) add('HUB_WALLET', 'fail', 'not a valid Solana address', 'Use the base58 public key of the hub wallet.');
    else if (hubWallet) add('HUB_WALLET', 'ok', 'valid address');
    else add('HUB_WALLET', 'warn', 'not set', 'Set the hub wallet\'s public key.');
    const derived = hubSecret ? pubkeyOfSecret(hubSecret) : null;
    if (hubSecret && !derived) add('HUB_WALLET_SECRET', 'fail', 'not a valid secret key', 'Use the base58 secret key (64 bytes) or the Solana CLI JSON byte array.');
    else if (hubSecret && hubWallet && derived !== hubWallet) add('HUB_WALLET_SECRET', 'fail', 'its public key is not HUB_WALLET', 'HUB_WALLET must be the public key of HUB_WALLET_SECRET (the hub is disabled until they agree).');
    else if (hubSecret) add('HUB_WALLET_SECRET', 'ok', 'valid, matches HUB_WALLET');
    else add('HUB_WALLET_SECRET', 'warn', 'not set: harvests are recorded as dry runs', 'Set the hub wallet\'s secret key (server only).');
    if (hubMint && !isPubkey(hubMint)) add('HUB_TOKEN_MINT', 'fail', 'not a valid mint address', 'Use the $HIVE mint (base58).');
    else if (hubMint) add('HUB_TOKEN_MINT', 'ok', 'valid address');
    else add('HUB_TOKEN_MINT', 'warn', 'not set: harvests are recorded as dry runs', 'Set the $HIVE mint address.');
  }
  return out;
}

/* ---------- network probes ---------- */

const timed = (f) => (url, init = {}) => f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
const why = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'no connection (network blocked or host down)');

/** Network checks: same item shape as checkEnv. `fetchImpl` is injectable for tests. */
export async function probe(env, fetchImpl = fetch) {
  const f = timed(fetchImpl);
  const out = [];
  const add = (name, status, detail, fix = '') => out.push({ name, status, detail, fix });
  const url = val(env, 'NEXT_PUBLIC_SUPABASE_URL')?.replace(/\/+$/, '');
  const service = val(env, 'SUPABASE_SERVICE_ROLE_KEY');
  const anon = val(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

  if (url && service) {
    const headers = { apikey: service, Authorization: `Bearer ${service}` };
    try {
      // PostgREST's OpenAPI description lists every table and function the key may use
      const res = await f(`${url}/rest/v1/`, { headers: { ...headers, Accept: 'application/openapi+json' } });
      if (res.status === 401 || res.status === 403) add('Supabase (service key)', 'fail', `rejected (HTTP ${res.status})`, 'SUPABASE_SERVICE_ROLE_KEY does not belong to this project URL.');
      else if (!res.ok) add('Supabase (service key)', 'fail', `HTTP ${res.status}`, 'Check NEXT_PUBLIC_SUPABASE_URL and that the project is not paused.');
      else {
        add('Supabase (service key)', 'ok', 'reachable');
        const spec = await res.json().catch(() => ({}));
        const paths = Object.keys(spec?.paths ?? {});
        const missingT = TABLES.filter((t) => !paths.includes(`/${t}`));
        if (missingT.length) add('Supabase tables (0001)', 'fail', `missing: ${missingT.join(', ')}`, 'SQL editor: run supabase/migrations/0001_hive.sql.');
        else add('Supabase tables (0001)', 'ok', `all ${TABLES.length} present`);
        const missingR = RPCS.filter((r) => !paths.includes(`/rpc/${r}`));
        if (missingR.length) add('Supabase functions (0001)', 'fail', `missing: ${missingR.join(', ')}`, 'SQL editor: run supabase/migrations/0001_hive.sql.');
        else add('Supabase functions (0001)', 'ok', RPCS.join(', '));
        if (!paths.includes('/rpc/claim_live_cell') || !paths.includes('/rpc/hive_schema_info')) {
          add('Supabase migration 0002', 'fail', 'not applied', 'SQL editor: run supabase/migrations/0002_live.sql (preview hives would block cells; this check cannot see Realtime).');
        } else {
          add('Supabase migration 0002', 'ok', 'applied');
          const r = await f(`${url}/rest/v1/rpc/hive_schema_info`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
          const info = r.ok ? await r.json().catch(() => null) : null;
          const rt = info?.realtime;
          if (!rt) add('Supabase Realtime', 'warn', 'could not read the publication', 'Database → Publications: supabase_realtime must include hives, actions, harvests.');
          else if (rt.allTables || ['hives', 'actions', 'harvests'].every((t) => rt.tables?.includes(t))) add('Supabase Realtime', 'ok', 'hives, actions, harvests are published');
          else add('Supabase Realtime', 'fail', `published: ${(rt.tables ?? []).join(', ') || 'none'}`, 'Re-run 0001_hive.sql, or Database → Publications → supabase_realtime: add hives, actions, harvests.');
          const p = info?.preview;
          if (p && p.hives + p.launches + p.dryRunActions + p.dryRunHarvests > 0) {
            add('Preview / dry-run data', 'warn', `${p.hives} preview hives, ${p.launches} preview launches, ${p.dryRunActions} dry-run actions, ${p.dryRunHarvests} dry-run harvests`, 'Hidden from the public in live mode; SQL editor: run supabase/cleanup-fake-data.sql to delete them.');
          } else if (p) add('Preview / dry-run data', 'ok', 'none');
        }
      }
    } catch (e) {
      add('Supabase (service key)', 'warn', why(e), 'Could not check from here; open /api/health on the deployment instead.');
    }
  }
  if (url && anon) {
    try {
      const res = await f(`${url}/rest/v1/hives?select=ca&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
      if (res.ok) add('Supabase (anon key reads hives)', 'ok', 'readable');
      else add('Supabase (anon key reads hives)', 'fail', `HTTP ${res.status}`, res.status === 401 ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY does not belong to this project.' : 'Run 0001_hive.sql (it grants anon SELECT on hives).');
    } catch (e) {
      add('Supabase (anon key reads hives)', 'warn', why(e), 'Could not check from here.');
    }
  }

  // 403 / 407 / 5xx without a JSON-RPC answer may be this machine's proxy or firewall (or an outage), not
  // the key: only a warning, like the reachability checks below. A provider rejecting the key says 401.
  const unsure = (status) => status === 403 || status === 407 || status >= 500;
  const unsureText = (status) => `answered HTTP ${status} (a rejected key, a proxy / firewall on this machine, or an outage)`;
  const rpcCall = async (rpcUrl, method) => {
    const res = await f(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
    const body = await res.json().catch(() => null);
    return { status: res.status, result: body?.result, error: body?.error };
  };
  const rpc = val(env, 'SOLANA_RPC_URL');
  if (rpc && isHttps(rpc)) {
    try {
      const h = await rpcCall(rpc, 'getHealth');
      const s = await rpcCall(rpc, 'getSlot');
      if (h.result === 'ok' && typeof s.result === 'number') add('Solana RPC', 'ok', `healthy, slot ${s.result}`);
      else if (h.result === undefined && unsure(h.status)) add('Solana RPC', 'warn', unsureText(h.status), 'Check SOLANA_RPC_URL (and its API key) from another network, or open /api/health on the deployment.');
      else add('Solana RPC', 'fail', `getHealth: ${h.result ?? `HTTP ${h.status}`}`, 'Check SOLANA_RPC_URL (and its API key) with your provider.');
    } catch (e) {
      add('Solana RPC', 'warn', why(e), 'Could not check from here.');
    }
  }
  const helius = val(env, 'HELIUS_API_KEY');
  if (helius) {
    try {
      const h = await rpcCall(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`, 'getHealth');
      if (h.result === 'ok') add('Helius key', 'ok', 'accepted');
      else if (h.result === undefined && unsure(h.status)) add('Helius key', 'warn', unsureText(h.status), 'Could not check from here: if it persists elsewhere, copy HELIUS_API_KEY again from https://dashboard.helius.dev.');
      else add('Helius key', 'fail', h.status === 401 ? 'rejected' : `HTTP ${h.status}`, 'Copy HELIUS_API_KEY again from https://dashboard.helius.dev.');
    } catch (e) {
      add('Helius key', 'warn', why(e), 'Could not check from here.');
    }
  }
  const reach = async (name, target, fix) => {
    try {
      const res = await f(target, { method: 'GET' });
      // any answer proves the host is up (a GET on these POST endpoints is refused); a proxy / firewall
      // refusal (403 / 407) or an outage (5xx) may be this machine's network, so it is only a warning
      if (res.status === 403 || res.status === 407 || res.status >= 500) add(name, 'warn', `answered HTTP ${res.status} (a proxy, a firewall or an outage)`, fix);
      else add(name, 'ok', `reachable (HTTP ${res.status})`);
    } catch (e) {
      add(name, 'warn', why(e), fix);
    }
  };
  await reach('PumpPortal', val(env, 'PUMPPORTAL_URL') ?? 'https://pumpportal.fun/api/trade-local', 'Launches and trades go through PumpPortal; check https://pumpportal.fun is up.');
  await reach('pump.fun IPFS', val(env, 'PUMP_IPFS_URL') ?? 'https://pump.fun/api/ipfs', 'Coin metadata is uploaded there; check https://pump.fun is up.');
  return out;
}

/* ---------- output ---------- */

const MARK = { ok: '✓', fail: '✗', warn: '!' };

export function render(items) {
  const lines = [];
  for (const it of items) {
    lines.push(`${MARK[it.status]} ${it.name}: ${it.detail}`);
    if (it.status !== 'ok' && it.fix) lines.push(`    → ${it.fix}`);
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const { env, files } = loadEnv(argv);
  console.log(`HIVE live-mode check (${files.length ? `read ${files.join(', ')} + the shell environment` : 'no .env.local / .env found: shell environment only'})\n`);
  const items = checkEnv(env);
  console.log('Environment');
  console.log(render(items));
  if (!argv.includes('--offline')) {
    console.log('\nConnections');
    const net = await probe(env);
    console.log(render(net));
    items.push(...net);
  }
  const fails = items.filter((i) => i.status === 'fail').length;
  const warns = items.filter((i) => i.status === 'warn').length;
  console.log(`\n${fails ? `✗ ${fails} to fix` : '✓ nothing blocking'}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}. Then open https://<your site>/api/health on the deployment.`);
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('check:live failed:', e?.message ?? e);
    process.exitCode = 2;
  });
}
