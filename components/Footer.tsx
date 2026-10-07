import Link from 'next/link';
import { theme } from '@/themes';

export default function Footer() {
  return (
    <footer className="mt-24 border-t border-accent/15">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="shape-hex inline-block h-6 w-6 bg-accent" />
          <span className="font-heading font-semibold tracking-tight">{theme.name}</span>
          <span className="text-xs text-text/50">{theme.hubToken.symbol} · an engine with {theme.name.toLowerCase()} as its first skin</span>
        </div>
        <nav className="flex flex-wrap gap-5 text-sm text-text/70">
          <Link href="/how">How it works</Link>
          <Link href="/harvest">{theme.hubRitual}</Link>
          <Link href="/leaderboard">Leaderboard</Link>
          <a href="https://x.com" target="_blank" rel="noreferrer">
            X
          </a>
          <a href="https://pump.fun" target="_blank" rel="noreferrer">
            pump.fun
          </a>
        </nav>
      </div>
      <div className="mx-auto max-w-[1400px] px-4 pb-10 text-xs text-text/50 sm:px-6">{theme.copy.footer}</div>
    </footer>
  );
}
