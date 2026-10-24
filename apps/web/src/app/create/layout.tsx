import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Create a room' };

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
