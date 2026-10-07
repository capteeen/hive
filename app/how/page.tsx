import { theme } from '@/themes';
import HexDiagram from '@/components/HexDiagram';
import HexButton from '@/components/HexButton';

export const metadata = { title: `${theme.name} — how it works` };

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function How() {
  const r = theme.rules;
  const V = theme.copy.verbLabels;
  const T = theme.hubToken.symbol;
  return (
    <article className="mx-auto max-w-[1100px] px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="text-[11px] uppercase tracking-[0.2em] text-accent">how it works</div>
      <h1 className="mt-2 font-heading text-5xl font-semibold tracking-tight sm:text-7xl">
        {cap(theme.copy.eyebrow)}
      </h1>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-text/75">
        {theme.name} launches coins on pump.fun and gives each one an on-chain {theme.agent}: a wallet that collects the coin’s creator fees and spends them by three public rules. There is no language model in the money path. The {theme.agent} is a rulebook. Every rule below is what runs, and every action it takes is logged with its transaction.
      </p>

      <Section n="01" title="Where the fees go">
        <p>
          Every hour, each {theme.unit}’s creator fees are claimed. {pct(theme.feeToHub)} go to the hub pool for the {theme.hubRitual}. The remaining {pct(1 - theme.feeToHub)} stay with the {theme.agent}, who allocates them by rule.
        </p>
        <div className="shape-card glass mt-6 p-4 sm:p-6">
          <HexDiagram
            height={330}
            nodes={[
              { id: 'fees', x: 110, y: 165, label: 'Creator fees', sub: 'pump.fun', tone: 'accent' },
              { id: 'queen', x: 360, y: 90, label: cap(theme.agent), sub: pct(1 - theme.feeToHub), tone: 'accent' },
              { id: 'hub', x: 360, y: 250, label: 'Hub pool', sub: pct(theme.feeToHub), tone: 'muted' },
              { id: 'seal', x: 640, y: 40, label: V.burn, sub: `${pct(r.burnShare)} buy & burn` },
              { id: 'store', x: 640, y: 150, label: V.store, sub: `${pct(r.storeShare)} to vault` },
              { id: 'swarm', x: 640, y: 260, label: V.interact, sub: `${pct(r.interactShare)} of ${theme.copy.resource}`, tone: 'raid' },
              { id: 'buy', x: 850, y: 250, label: `Buy ${T}`, sub: 'on the hour', tone: 'royal' },
            ]}
            edges={[
              { from: 'fees', to: 'queen', label: pct(1 - theme.feeToHub) },
              { from: 'fees', to: 'hub', label: pct(theme.feeToHub) },
              { from: 'queen', to: 'seal' },
              { from: 'queen', to: 'store' },
              { from: 'queen', to: 'swarm' },
              { from: 'hub', to: 'buy' },
            ]}
          />
        </div>
      </Section>

      <Section n="02" title={`The ${theme.agent}’s rules`}>
        <ol className="grid gap-4 sm:grid-cols-2">
          <Rule verb={V.burn} tone="accent">
            If the coin is below its 24h average price, {pct(r.burnShare)} of the hour’s fees buy the coin and burn it. The other {pct(r.storeShare)} is stored. On the {theme.scene} a wax cap slides over part of the cell.
          </Rule>
          <Rule verb={V.store} tone="accent">
            Default. At least {pct(r.storeShare)} of the hour’s fees go to the vault as {theme.copy.resource}. If nothing was sealed, the whole budget is stored. {cap(theme.copy.resource)} is the {theme.unit}’s score and the pool it {theme.verbs.interact}s from. The liquid level rises with a ripple.
          </Rule>
          <Rule verb={V.interact} tone="raid">
            If {theme.copy.resource} exceeds {r.interactThreshold}× the {theme.unit}’s hourly fee average, the {theme.agent} spends {pct(r.interactShare)} of {theme.copy.resource} buying the coin of the nearest {theme.unit} on the map with the highest fee growth. {cap(theme.holderPlural)} visibly fly from one cell to the other. The target’s {theme.agent} may {theme.verbs.interact} back next hour. {cap(theme.verbs.interact)}s are the PvP.
          </Rule>
          <Rule verb={V.starve} tone="grey">
            Zero fees for {r.starveHours} consecutive hours and {theme.holderPlural} start leaving: the displayed count decays and the cell desaturates. At {r.abandonHours} hours the {theme.unit} is abandoned: the vault pays out pro-rata to holders and the cell stays on the map as grey comb.
          </Rule>
        </ol>
        <div className="shape-card glass mt-6 p-4 sm:p-6">
          <HexDiagram
            height={360}
            nodes={[
              { id: 'hour', x: 110, y: 150, label: 'Each hour', sub: `${pct(1 - theme.feeToHub)} of fees`, tone: 'muted' },
              { id: 'q1', x: 340, y: 150, label: 'price < 24h avg?', tone: 'accent' },
              { id: 'seal', x: 570, y: 60, label: V.burn, sub: `${pct(r.burnShare)} + ${pct(r.storeShare)} stored` },
              { id: 'store', x: 570, y: 240, label: V.store, sub: '100% stored' },
              { id: 'q2', x: 800, y: 150, label: `${theme.copy.resource} > ${r.interactThreshold}× fees?`, tone: 'raid' },
              { id: 'swarm', x: 800, y: 295, label: V.interact, sub: `${pct(r.interactShare)} of ${theme.copy.resource}`, tone: 'raid' },
            ]}
            edges={[
              { from: 'hour', to: 'q1' },
              { from: 'q1', to: 'seal', label: 'yes' },
              { from: 'q1', to: 'store', label: 'no' },
              { from: 'seal', to: 'q2' },
              { from: 'store', to: 'q2' },
              { from: 'q2', to: 'swarm', label: 'yes' },
            ]}
            r={50}
          />
        </div>
      </Section>

      <Section n="03" title={`The ${theme.hubRitual}`}>
        <p>
          Every hour on the hour, UTC, the hub sums {pct(theme.feeToHub)} of all {theme.unitPlural}’ fees and buys {T}. {pct(theme.hubSplit.burn)} of what it bought is burned. {pct(theme.hubSplit.toBiggest)} is sent to the biggest {theme.unit} by {theme.copy.resource} as a {theme.copy.reward} deposit. A countdown to the next {theme.hubRitual} is shown on every page, and the X account posts every {theme.hubRitual} with its transaction.
        </p>
        <div className="shape-card glass mt-6 p-4 sm:p-6">
          <HexDiagram
            height={260}
            nodes={[
              { id: 'all', x: 120, y: 130, label: `All ${theme.unitPlural}`, sub: `${pct(theme.feeToHub)} of fees`, tone: 'muted' },
              { id: 'buy', x: 400, y: 130, label: `Buy ${T}`, sub: 'hourly, UTC', tone: 'accent' },
              { id: 'burn', x: 690, y: 50, label: 'Burn', sub: pct(theme.hubSplit.burn), tone: 'accent' },
              { id: 'big', x: 690, y: 210, label: `Biggest ${theme.unit}`, sub: `${pct(theme.hubSplit.toBiggest)} ${theme.copy.reward}`, tone: 'royal' },
            ]}
            edges={[
              { from: 'all', to: 'buy' },
              { from: 'buy', to: 'burn' },
              { from: 'buy', to: 'big' },
            ]}
          />
        </div>
      </Section>

      <Section n="04" title="What the map shows">
        <ul className="grid gap-3 sm:grid-cols-2">
          <Li>Every {theme.unit} is one cell on a single shared {theme.scene}. Cells are adjacent, so “neighbor” is literal.</Li>
          <Li>Cell depth is the holder count. Fill level is {theme.copy.resource}. Colour is state: gold working, white for the biggest {theme.unit}, grey starving, a red flash when {theme.verbs.interact}ed.</Li>
          <Li>The biggest {theme.unit} is always centered. New {theme.unitPlural} spawn at the edge and the {theme.scene} grows outward.</Li>
          <Li>{cap(theme.holderPlural)} hover over their own cell, capped at 30 per cell. Hover a cell for the real count.</Li>
          <Li>Every animation maps to one logged action with a transaction link. Nothing moves without a reason.</Li>
          <Li>The {theme.hubRitual} is a golden pulse from the center. The biggest cell flashes white.</Li>
        </ul>
      </Section>

      <Section n="05" title="Launching">
        <p>
          You pay the launch cost, a small {theme.agent} reserve for gas, and an optional dev buy to your {theme.unit}’s {theme.agent} wallet. The {theme.agent} launches the coin on pump.fun as its creator, so creator fees flow to her automatically. From then on {pct(1 - theme.feeToHub)} of fees stay with the {theme.agent} to {theme.verbs.burn}, {theme.verbs.store} and {theme.verbs.interact}, and {pct(theme.feeToHub)} go to the hourly {theme.hubRitual}.
        </p>
        <div className="mt-6">
          <HexButton href="/">Back to the {theme.scene}</HexButton>
        </div>
      </Section>
    </article>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-16">
      <div className="flex items-center gap-4">
        <span className="shape-hex flex h-10 w-10 items-center justify-center bg-accent/15 font-heading text-sm font-semibold text-accent">{n}</span>
        <h2 className="font-heading text-3xl font-semibold tracking-tight">{title}</h2>
      </div>
      <div className="mt-5 text-base leading-relaxed text-text/75 [&_p]:max-w-2xl">{children}</div>
    </section>
  );
}

function Rule({ verb, tone, children }: { verb: string; tone: 'accent' | 'raid' | 'grey'; children: React.ReactNode }) {
  const cls = tone === 'raid' ? 'bg-raid/15 text-raid' : tone === 'grey' ? 'bg-starving/20 text-starving' : 'bg-accent/15 text-accent';
  return (
    <li className="shape-card glass p-5">
      <span className={`shape-btn inline-flex h-7 items-center text-xs font-semibold uppercase tracking-wider ${cls}`}>{verb}</span>
      <p className="mt-3 text-sm leading-relaxed text-text/75">{children}</p>
    </li>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed">
      <span className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 shape-hex bg-accent" />
      <span>{children}</span>
    </li>
  );
}
