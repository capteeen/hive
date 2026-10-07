import HomeHero from '@/components/home/HomeHero';
import Steps from '@/components/home/Steps';
import StatsStrip from '@/components/StatsStrip';
import Log from '@/components/Log';
import Section from '@/components/Section';
import ExplorePreview from '@/components/home/ExplorePreview';
import LeaderboardTable from '@/components/LeaderboardTable';
import { theme } from '@/themes';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export default function Home() {
  return (
    <>
      <HomeHero />
      <Steps />
      <section className="mx-auto mt-16 max-w-[1400px] px-4 sm:px-6">
        <StatsStrip />
      </section>
      <div className="mx-auto mt-20 grid max-w-[1400px] gap-12 px-4 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
        <Section eyebrow="live" title={`The ${theme.agent}s’ log`} className="!px-0">
          <div className="shape-card glass max-h-[640px] overflow-y-auto scroll-thin">
            <Log limit={24} />
          </div>
        </Section>
        <div className="grid gap-12">
          <Section eyebrow="explore" title={`${cap(theme.unitPlural)} on the ${theme.scene}`} action={{ href: '/comb', label: `Open the ${theme.scene}` }} className="!px-0">
            <ExplorePreview />
          </Section>
          <Section eyebrow="leaderboard" title={`Most ${theme.copy.resource}`} action={{ href: '/leaderboard', label: 'Full leaderboard' }} className="!px-0">
            <LeaderboardTable tab="honey" limit={5} showTabs={false} />
          </Section>
        </div>
      </div>
    </>
  );
}

