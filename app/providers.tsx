'use client';
import { useEffect, useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { useHive } from '@/lib/store';
import RemoteSync from '@/components/RemoteSync';
import { theme } from '@/themes';
import '@solana/wallet-adapter-react-ui/styles.css';

const ENDPOINT = process.env.NEXT_PUBLIC_RPC ?? 'https://api.mainnet-beta.solana.com';

export default function Providers({ children }: { children: React.ReactNode }) {
  // Backpack and other Wallet Standard wallets are auto-detected by the adapter.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  const start = useHive((s) => s.start);
  const mode = useHive((s) => s.mode);
  useEffect(() => start(), [start]);
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    document.documentElement.dataset.shape = theme.shape;
  }, [mode]);
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {/* other users' hives + "which hives are mine" (needs the wallet context) */}
          <RemoteSync />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
