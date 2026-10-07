import HivePage from '@/components/hive/HivePage';
import { theme } from '@/themes';
import { createWorld, SEED } from '@/lib/sim';

export function generateMetadata({ params }: { params: { ca: string } }) {
  const h = createWorld(SEED).hives[params.ca];
  return {
    title: h ? `${h.name} ($${h.ticker}) — ${theme.name}` : `${theme.unit} — ${theme.name}`,
    description: h ? `${h.name}: ${h.honey.toFixed(2)} SOL ${theme.copy.resource}, ${h.bees} ${theme.holderPlural}, ${h.state}.` : theme.copy.tagline,
  };
}

export default function Page({ params }: { params: { ca: string } }) {
  return <HivePage ca={params.ca} />;
}
