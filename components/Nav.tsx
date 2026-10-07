'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { theme } from '@/themes';
import { useHive } from '@/lib/store';
import { useUI } from '@/lib/ui';
import { installClickSounds } from '@/lib/sfx';
import { useEffect } from 'react';
import HexButton from './HexButton';
import HarvestCountdown from './HarvestCountdown';

const WalletButton = dynamic(() => import('./WalletButton'), { ssr: false });
const LaunchWizard = dynamic(() => import('./launch/LaunchWizard'), { ssr: false });
const Hum = dynamic(() => import('./Hum'), { ssr: false });

const links = [
  { href: '/comb', label: theme.scene === 'comb' ? 'Comb' : 'Map' },
  { href: '/harvest', label: cap(theme.hubRitual) },
  { href: '/leaderboard', label: 'Leaderboard' },
  { href: '/how', label: 'How' },
  { href: '/me', label: 'Me' },
];
function cap(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

export default function Nav() {
  const path = usePathname();
  const mode = useHive((s) => s.mode);
  const toggleMode = useHive((s) => s.toggleMode);
  const sound = useHive((s) => s.sound);
  const toggleSound = useHive((s) => s.toggleSound);
  const openLaunch = useUI((s) => s.openLaunch);
  const fx = useHive((s) => s.sfx);
  const toggleSfx = useHive((s) => s.toggleSfx);
  useEffect(() => installClickSounds(), []);
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 border-b border-accent/10 bg-night/60 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="shape-hex inline-block h-7 w-7 bg-accent glow" />
            <span className="font-heading text-lg font-semibold tracking-tight">{theme.name}</span>
          </Link>
          <nav className="ml-6 hidden items-center gap-6 text-sm md:flex">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="navlink" aria-current={path === l.href || path.startsWith(l.href + '/') ? 'page' : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <HarvestCountdown compact className="flex" />
            <button
              onClick={toggleSound}
              className="shape-btn btn-ghost hidden h-9 items-center gap-1.5 text-xs md:inline-flex"
              aria-pressed={sound}
              title={sound ? 'Ambient hum on' : 'Ambient hum off'}
            >
              <span className={`shape-hex inline-block h-2 w-2 ${sound ? 'bg-accent' : 'bg-text/30'}`} /> hum
            </button>
            <button
              onClick={toggleSfx}
              data-sfx="toggle"
              className="shape-btn btn-ghost inline-flex h-9 items-center text-xs"
              aria-pressed={fx}
              aria-label={fx ? 'Click sounds on' : 'Click sounds off'}
              title={fx ? 'Click sounds on' : 'Click sounds off'}
            >
              <SpeakerIcon on={fx} />
            </button>
            <button onClick={toggleMode} className="shape-btn btn-ghost hidden h-9 items-center text-xs sm:inline-flex" aria-label="Toggle daylight mode">
              {mode === 'night' ? 'Daylight' : 'Night'}
            </button>
            <span className="hidden sm:inline-flex">
              <WalletButton />
            </span>
            <HexButton size="sm" onClick={() => openLaunch()} className="hidden sm:inline-flex" data-sfx="open">
              Launch a {theme.unit}
            </HexButton>
            <HexButton size="sm" onClick={() => openLaunch()} className="sm:hidden" data-sfx="open">
              Launch
            </HexButton>
          </div>
        </div>
        <nav className="flex items-center gap-3.5 overflow-x-auto px-4 pb-2 text-[13px] md:hidden">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="navlink whitespace-nowrap" aria-current={path === l.href ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
          <span className="ml-auto flex shrink-0 items-center gap-2 sm:hidden">
            <button onClick={toggleMode} className="shape-btn btn-ghost inline-flex h-7 items-center text-[11px]" aria-label="Toggle daylight mode">
              {mode === 'night' ? 'Day' : 'Night'}
            </button>
            <WalletButton />
          </span>
        </nav>
      </header>
      <LaunchWizard />
      <Hum />
    </>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" stroke="none" />
      {on ? (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      ) : (
        <>
          <path d="m16 9 6 6" />
          <path d="m22 9-6 6" />
        </>
      )}
    </svg>
  );
}
