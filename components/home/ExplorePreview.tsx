'use client';
import { useHive, selectHives } from '@/lib/store';
import HiveCard from '@/components/HiveCard';
import EmptyHives from './EmptyHives';

export default function ExplorePreview() {
  const hives = useHive(selectHives);
  const biggest = useHive((s) => s.world.biggestCa);
  if (!hives.length) return <EmptyHives />;
  const max = Math.max(1, ...hives.map((h) => h.honey));
  const picks = [...hives].sort((a, b) => b.feesHour - a.feesHour).slice(0, 4);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {picks.map((h) => (
        <HiveCard key={h.ca} hive={h} maxHoney={max} biggest={h.ca === biggest} />
      ))}
    </div>
  );
}
