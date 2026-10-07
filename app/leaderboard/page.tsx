import LeaderboardTable from '@/components/LeaderboardTable';
import { theme } from '@/themes';

export const metadata = { title: `${theme.name} — leaderboard` };

export default function Page() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-24 sm:px-6 sm:pt-28">
      <div className="text-[11px] uppercase tracking-[0.2em] text-accent">ranked live</div>
      <h1 className="mt-2 font-heading text-5xl font-semibold tracking-tight sm:text-6xl">Leaderboard</h1>
      <p className="mt-3 max-w-lg text-text/70">
        {theme.copy.resource} is the score. The biggest {theme.unit} by {theme.copy.resource} receives the {theme.copy.reward} every {theme.hubRitual}.
      </p>
      <div className="mt-8">
        <LeaderboardTable />
      </div>
    </div>
  );
}
