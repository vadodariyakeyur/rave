'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Where you can go from anywhere: the room list and a new room. A client leaf only for the current path. */
export function SideNav() {
  const path = usePathname();
  const links = [
    { href: '/', label: 'Rooms', Icon: Radio, current: path === '/' },
    { href: '/create', label: 'Create a room', Icon: Plus, current: path === '/create' },
  ];
  return (
    <nav aria-label="rave" className="flex flex-col gap-1 px-2">
      {links.map(({ href, label, Icon, current }) => (
        <Link
          key={href}
          href={href}
          aria-current={current ? 'page' : undefined}
          className={cn(
            'flex h-11 items-center gap-3 rounded-full px-4 text-[0.9375rem] font-semibold transition-[background-color,scale] duration-300 ease-soft active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            current ? 'bg-white/14 text-foreground' : 'text-muted-foreground hover:bg-white/8 hover:text-foreground',
          )}
        >
          <Icon className={cn('size-5', current && 'text-ring')} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
