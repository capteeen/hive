import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import Ambient from '@/components/fx/Ambient';
import { theme } from '@/themes';
import { themeCss } from '@/lib/themeCss';

export const metadata: Metadata = {
  title: `${theme.name} — ${theme.copy.eyebrow}`,
  description: theme.copy.tagline,
  openGraph: { title: theme.name, description: theme.copy.tagline, type: 'website' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-mode="night" data-shape={theme.shape} suppressHydrationWarning>
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
        <Providers>
          <Nav />
          <main className="min-h-screen">{children}</main>
          <Footer />
          {/* money splashes + a passing bee; client-only, renders nothing on the server */}
          <Ambient />
        </Providers>
      </body>
    </html>
  );
}
