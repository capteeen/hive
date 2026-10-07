'use client';
import { useEffect, useState } from 'react';

/**
 * Returns the current time, but only after mount (null during SSR and hydration),
 * so server and client markup match. Re-renders every `interval` ms.
 */
export function useNow(interval = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}
