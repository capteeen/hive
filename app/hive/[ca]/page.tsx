import HivePage from '@/components/hive/HivePage';
import { theme } from '@/themes';
import { hiveSummary } from '@/lib/server/hive-summary';

export async function generateMetadata({ params }: { params: { ca: string } }) {
  const h = await hiveSummary(params.ca);
  const tag = h?.source === 'preview' ? ' (preview)' : h?.source === 'demo' ? ' (demo)' : '';
  return {
    title: h ? `${h.name} ($${h.ticker})${tag} — ${theme.name}` : `${theme.unit} — ${theme.name}`,
    description: h ? `${h.name}: ${h.honey.toFixed(2)} SOL ${theme.copy.resource}, ${h.bees} ${theme.holderPlural}, ${h.state}.` : theme.copy.tagline,
  };
}

export default function Page({ params }: { params: { ca: string } }) {
  return <HivePage ca={params.ca} />;
}
