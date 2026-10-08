import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

// The font theme.css names in --font-sans. Change both together.
const font = Geist({ subsets: ['latin'], variable: '--font-loaded' });

export const metadata: Metadata = {
  title: 'rave',
  description: 'Synchronized peer-to-peer audio rooms',
};

export const viewport: Viewport = {
  // theme.css's dark --background. A meta tag cannot read a CSS variable.
  themeColor: '#0c0c0e',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // `dark` is hard-set: this app has no light mode and no theme toggle.
  return (
    <html lang="en" className={`dark ${font.variable}`}>
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
              '--border-radius': 'var(--radius)',
              fontFamily: 'var(--font-sans)',
            } as React.CSSProperties
          }
        />
      </body>
    </html>
  );
}
