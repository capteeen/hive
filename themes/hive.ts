import type { Theme } from './types';

export const hive: Theme = {
  id: 'hive',
  name: 'HIVE',
  unit: 'hive',
  unitPlural: 'hives',
  holder: 'bee',
  holderPlural: 'bees',
  agent: 'queen',
  verbs: { burn: 'seal', store: 'store honey', interact: 'swarm' },
  hubToken: { symbol: '$HIVE', name: 'HIVE', ca: 'H1VEqueenHubTokenMockAddress1111111111111111' },
  hubRitual: 'harvest',
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
    base: '#120C06',
    surface: '#1C1409',
    accent: '#F5A524',
    accentSoft: '#FFC866',
    text: '#FFF1D6',
    royal: '#FFF8EC',
    starving: '#6E6558',
    raid: '#FF5C3A',
    dayBase: '#FFF6E5',
    dayText: '#1C1409',
  },
  fonts: {
    heading: '"Space Grotesk", "Manrope", system-ui, sans-serif',
    body: '"Inter", system-ui, sans-serif',
    headingWeight: 600,
    tracking: '-0.03em',
  },
  shape: 'hex',
  scene: 'comb',
  ambience: { critter: 'bee', honey: true },
  copy: {
    eyebrow: 'Every coin is a beehive. Every holder is a bee.',
    tagline: 'Launch a coin, get a queen. She seals, stores and swarms with your fees, every hour, on-chain.',
    steps: [
      {
        title: 'Launch a hive.',
        body: 'Your coin launches on pump.fun and gets a queen with her own Solana wallet.',
      },
      {
        title: 'Bees move in.',
        body: 'Every holder is a bee. More holders, bigger comb.',
      },
      {
        title: 'The queen works.',
        body: 'With the hive’s fees she seals (burns), stores honey (accumulates), or swarms (buys a neighbor). Every action on-chain, explained.',
      },
      {
        title: 'The hub harvests.',
        body: '20% of every hive’s fees buy $HIVE each hour. Half burns. Half goes to the biggest hive.',
      },
    ],
    feature: [
      { title: 'No LLM in the money path.', body: 'The queen is a rulebook, not a chatbot. Every verb is a fixed rule you can read on /how and verify on-chain.' },
      { title: 'Neighbors are literal.', body: 'Hives sit next to each other on one shared comb. Swarms fly to the adjacent cell with the fastest-growing fees.' },
      { title: 'Starving is visible.', body: 'Stop earning and bees leave. The comb goes grey. After a day the vault pays out to holders and the cell stays as a scar.' },
    ],
    launch: {
      title: 'Found a hive',
      cta: 'Launch',
      sentence:
        'Paid to your hive’s queen wallet, which launches the coin as creator. From then on 80% of creator fees stay with the queen to seal, store and swarm, and 20% go to the hourly harvest.',
      reserveLabel: 'Queen reserve',
      namePlaceholder: 'Amber Comb',
      tickerPlaceholder: 'AMBER',
      mottoPlaceholder: 'Slow honey, sharp sting.',
    },
    verbLabels: { burn: 'SEAL', store: 'STORE', interact: 'SWARM', starve: 'STARVE', abandon: 'ABANDON' },
    stats: { units: 'Hives', holders: 'Bees', stored: 'Honey stored', burned: '$HIVE burned', next: 'Next harvest' },
    resource: 'honey',
    reward: 'royal jelly',
    footer: 'Coins launch on pump.fun (Solana). A meme, not an investment. Crypto is risky. Only use what you can afford to lose.',
  },
};

export default hive;
