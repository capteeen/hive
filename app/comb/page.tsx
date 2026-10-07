import CombExplorer from '@/components/comb/CombExplorer';
import { theme } from '@/themes';

export const metadata = { title: `${theme.name} — the ${theme.scene}` };

export default function CombPage() {
  return <CombExplorer />;
}
