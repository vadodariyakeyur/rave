import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'rave',
  description: 'Synchronized peer-to-peer audio rooms',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // `dark` is hard-set: this app has no light mode and no theme toggle.
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh antialiased">
        {children}
        {/* Bottom-centre: the top-right corner belongs to the debug overlay. */}
        <Toaster theme="dark" position="bottom-center" />
      </body>
    </html>
  );
}
