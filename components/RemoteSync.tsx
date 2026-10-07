'use client';
/**
 * Keeps the store in sync with hives stored server-side (other users' hives), and tells the store
 * which ids count as "me": the connected wallet and this browser's guest id. Renders nothing.
 * Mounted once, inside WalletProvider (app/providers.tsx).
 */
import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useHive } from '@/lib/store';
import { startRemoteSync } from '@/lib/remote';
import { guestId } from '@/lib/guest';

export default function RemoteSync() {
  const started = useHive((s) => s.started);
  const setOwnerIds = useHive((s) => s.setOwnerIds);
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  // Only after useHive.start(): start() re-seeds the world, which would drop hives applied earlier.
  // (Child effects run before the parent's, so the providers' start() has not run on first mount.)
  useEffect(() => {
    if (!started) return;
    return startRemoteSync();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const ids = [guestId()];
    if (wallet) ids.unshift(wallet);
    setOwnerIds(ids);
  }, [started, wallet, setOwnerIds]);

  return null;
}
