import HarvestPage from '@/components/HarvestPage';
import { theme } from '@/themes';

export const metadata = { title: `${theme.name} — ${theme.hubRitual}` };

export default function Page() {
  return <HarvestPage />;
}
