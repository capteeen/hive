'use client';
import { useUI } from '@/lib/ui';
import { theme } from '@/themes';
import HexButton from '@/components/HexButton';

/**
 * What a list of hives shows before any exists (no demo hives, nothing launched yet): an invitation to
 * found the first one, never made-up rows.
 */
export default function EmptyHives({ title = `No ${theme.unitPlural} yet`, body, className = '' }: { title?: string; body?: string; className?: string }) {
  const openLaunch = useUI((s) => s.openLaunch);
  return (
    <div className={`shape-card glass flex flex-wrap items-center justify-between gap-4 p-6 ${className}`} data-empty="hives">
      <div className="min-w-0">
        <h3 className="font-heading text-lg font-semibold tracking-tight">{title}</h3>
        <p className="mt-1 max-w-md text-sm text-text/65">{body ?? `Every ${theme.unit} here is a real coin. The ${theme.scene} starts with one cell in the middle: yours, if you found it first.`}</p>
      </div>
      <HexButton onClick={() => openLaunch({ q: 0, r: 0 })} data-sfx="open" size="sm">
        Found the first {theme.unit}
      </HexButton>
    </div>
  );
}
