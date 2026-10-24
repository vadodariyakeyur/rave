import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Geist } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

// The font theme.css names in --font-sans. Change both together.
const font = Geist({ subsets: ['latin'], variable: '--font-loaded' });

// Headlines and big numerals only; next/font, so no npm package. Named in theme.css as --font-display.
const display = Bricolage_Grotesque({ subsets: ['latin'], weight: '800', variable: '--font-display-loaded' });

export const metadata: Metadata = {
  title: { default: 'RAVE · Same second, every phone', template: '%s · RAVE' },
  description: 'Synchronized peer-to-peer audio rooms',
};

export const viewport: Viewport = {
  // theme.css's dark --background. A meta tag cannot read a CSS variable.
  themeColor: '#121212',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // `dark` is hard-set: this app has no light mode and no theme toggle.
  return (
    <html lang="en" className={`dark ${font.variable} ${display.variable}`}>
      <body className="min-h-dvh antialiased">
        {children}
        {/* Bottom-centre: the top-right corner belongs to the debug overlay. */}
        <Toaster
          theme="dark"
          position="bottom-center"
          style={
            {
              '--normal-bg': 'var(--popover)',
              '--normal-text': 'var(--popover-foreground)',
              '--normal-border': 'var(--border)',
              '--border-radius': '0px',
              fontFamily: 'var(--font-sans)',
            } as React.CSSProperties
          }
        />
      </body>
    </html>
  );
}
