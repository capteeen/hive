import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Ambient from '@/components/fx/Ambient';
import { HoneyBackdrop, HoneyPool } from '@/components/fx/Honey';
import { ambienceOf } from '@/components/fx/swarmModel';
import { theme } from '@/themes';
import { themeCss } from '@/lib/themeCss';

export const metadata: Metadata = {
  title: `${theme.name} — ${theme.copy.eyebrow}`,
  description: theme.copy.tagline,
  openGraph: { title: theme.name, description: theme.copy.tagline, type: 'website' },
};

const honey = ambienceOf(theme).honey;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-mode="night" data-shape={theme.shape} data-honey={honey ? 'on' : undefined} suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
        <style dangerouslySetInnerHTML={{ __html: themeCss() }} />
      </head>
      <body className="min-h-screen antialiased">
        {/* honeycomb texture and warm glow behind every page (static) */}
        {honey && <HoneyBackdrop />}
        <Providers>
          <Nav />
          <main className="min-h-screen">{children}</main>
          {honey ? (
            <div className="relative">
              <HoneyPool />
              <Footer />
            </div>
          ) : (
            <Footer />
          )}
          {/* money splashes, the swarm and honey on click; client-only, renders nothing on the server */}
          <Ambient />
        </Providers>
      </body>
    </html>
  );
}
