'use client';
import { useHive } from '@/lib/store';
import EmptyHives from './EmptyHives';

/** `children` once at least one hive exists, otherwise the "found the first one" card. */
export default function HivesOrEmpty({ children, body }: { children?: React.ReactNode; body?: string }) {
  const any = useHive((s) => s.world.order.length > 0);
  return any ? <>{children}</> : <EmptyHives body={body} />;
}
