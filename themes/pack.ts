import type { Theme } from './types';

/**
 * PACK — the second theme. Wolves, dens, an alpha, cull / cache / hunt.
 * Proves the engine: swap the import in themes/index.ts and the whole app re-skins,
 * including the 3D scene (circular den map instead of a honeycomb).
 */
export const pack: Theme = {
  id: 'pack',
  name: 'PACK',
  unit: 'den',
  unitPlural: 'dens',
  holder: 'wolf',
  holderPlural: 'wolves',
  agent: 'alpha',
  verbs: { burn: 'cull', store: 'cache', interact: 'hunt' },
  hubToken: { symbol: '$PACK', name: 'PACK', ca: 'PACKalphaHubTokenMockAddress111111111111111' },
  hubRitual: 'hunt',
  hubSplit: { burn: 0.5, toBiggest: 0.5 },
  feeToHub: 0.2,
  rules: {
    burnShare: 0.4,
    storeShare: 0.6,
    interactThreshold: 2,
    interactShare: 0.25,
    starveHours: 6,
    abandonHours: 24,
  },
  palette: {
    base: '#070A0F',
    surface: '#0F161F',
    accent: '#8FB8FF',
    accentSoft: '#C9DDFF',
    text: '#E6EEF8',
    royal: '#FFFFFF',
    starving: '#4E5661',
    raid: '#FF4D6D',
    dayBase: '#EEF3FA',
    dayText: '#0F161F',
  },
  fonts: {
    heading: '"Manrope", "Space Grotesk", system-ui, sans-serif',
    body: '"Inter", system-ui, sans-serif',
    headingWeight: 700,
    tracking: '-0.02em',
  },
  shape: 'circle',
  scene: 'den',
  // wolves get no bees and no honey; the money splashes stay
  ambience: { critter: null, honey: false },
  copy: {
    eyebrow: 'Every coin is a den. Every holder is a wolf.',
    tagline: 'Launch a coin, get an alpha. It culls, caches and hunts with your fees, every hour, on-chain.',
    steps: [
      { title: 'Dig a den.', body: 'Your coin launches on pump.fun and gets an alpha with its own Solana wallet.' },
      { title: 'Wolves move in.', body: 'Every holder is a wolf. More holders, bigger pack.' },
      {
        title: 'The alpha works.',
        body: 'With the den’s fees it culls (burns), caches (accumulates), or hunts (buys a neighbor). Every action on-chain, explained.',
      },
      { title: 'The pack hunts.', body: '20% of every den’s fees buy $PACK each hour. Half burns. Half goes to the biggest den.' },
    ],
    feature: [
      { title: 'No LLM in the money path.', body: 'The alpha is a rulebook. Every verb is a fixed rule on /how, verifiable on-chain.' },
      { title: 'Territory is literal.', body: 'Dens sit on one circular map. Hunts target the nearest den with the fastest-growing fees.' },
      { title: 'Starving is visible.', body: 'Stop earning and wolves leave. The den goes grey. After a day the cache pays out and the den stays as a ruin.' },
    ],
    launch: {
      title: 'Dig a den',
      cta: 'Launch',
      sentence:
        'Paid to your den’s alpha wallet, which launches the coin as creator. From then on 80% of creator fees stay with the alpha to cull, cache and hunt, and 20% go to the hourly hunt.',
      reserveLabel: 'Alpha reserve',
      namePlaceholder: 'Grey Ridge',
      tickerPlaceholder: 'RIDGE',
      mottoPlaceholder: 'Quiet paws, long winters.',
    },
    verbLabels: { burn: 'CULL', store: 'CACHE', interact: 'HUNT', starve: 'STARVE', abandon: 'ABANDON' },
    stats: { units: 'Dens', holders: 'Wolves', stored: 'Cached', burned: '$PACK burned', next: 'Next hunt' },
    resource: 'cache',
    reward: 'alpha’s share',
    footer: 'Coins launch on pump.fun (Solana). A meme, not an investment. Crypto is risky. Only use what you can afford to lose.',
  },
};

export default pack;
