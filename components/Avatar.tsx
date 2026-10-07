/* eslint-disable @next/next/no-img-element */
import type { Hive } from '@/lib/types';

function hue(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export default function Avatar({ hive, size = 40, className = '' }: { hive: Pick<Hive, 'name' | 'ticker' | 'image' | 'state' | 'ca'>; size?: number; className?: string }) {
  const h = hue(hive.ca);
  const grey = hive.state !== 'working';
  const bg = grey
    ? 'linear-gradient(135deg, rgb(var(--c-starving)), rgb(var(--c-surface)))'
    : `linear-gradient(135deg, hsl(${h} 80% 62%), rgb(var(--c-accent)))`;
  return (
    <div className={`shape-avatar relative shrink-0 overflow-hidden ${className}`} style={{ width: size, height: size, background: bg }}>
      {hive.image ? (
        <img src={hive.image} alt={hive.name} className={`h-full w-full object-cover ${grey ? 'grayscale' : ''}`} />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center font-heading font-semibold text-base" style={{ fontSize: size * 0.34, color: 'rgb(var(--c-base))' }}>
          {hive.ticker.slice(0, 2)}
        </span>
      )}
    </div>
  );
}
