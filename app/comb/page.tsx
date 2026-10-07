import { Suspense } from 'react';
import CombExplorer from '@/components/comb/CombExplorer';
import { theme } from '@/themes';

export const metadata = { title: `${theme.name} — the ${theme.scene}` };

export default function CombPage() {
  return (
    <Suspense fallback={<div className="h-[100svh] w-full" />}>
      <CombExplorer />
    </Suspense>
  );
}
