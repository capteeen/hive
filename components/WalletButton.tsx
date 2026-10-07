'use client';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { short } from '@/lib/format';

export default function WalletButton({ className = '', full = false }: { className?: string; full?: boolean }) {
  const { publicKey, disconnect, connecting } = useWallet();
  const { setVisible } = useWalletModal();
  if (publicKey) {
    return (
      <button onClick={() => disconnect()} className={`shape-btn btn-ghost inline-flex h-9 items-center text-xs font-semibold ${className}`} title="Disconnect">
        {short(publicKey.toBase58())}
      </button>
    );
  }
  return (
    <button onClick={() => setVisible(true)} className={`shape-btn btn-ghost inline-flex h-9 items-center text-xs font-semibold ${className}`}>
      {connecting ? 'Connecting…' : full ? 'Connect wallet' : 'Connect'}
    </button>
  );
}
