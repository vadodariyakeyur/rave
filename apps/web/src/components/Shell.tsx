import type { ReactNode } from 'react';
import { Equalizer } from '@/components/Equalizer';
import { SideNav } from '@/components/SideNav';
import { cn } from '@/lib/utils';

export type Panel = 'main' | 'sidebar' | 'aside';

/**
 * The frame every screen sits in, after Apple Music: panels of glass float on
 * one window-wide backdrop, each inset from the edges with the same gap.
 * The sidebar (the app's mark, where you can go, then whatever the screen
 * adds) is on the left, the main area scrolls under its floating bar, and
 * an optional people panel is on the right.
 *
 * Each column exists once. Below its breakpoint a column is hidden unless
 * `panel` names it, in which case it takes the whole width: that is how a
 * phone gets one panel at a time without a second copy of anything.
 */
export function Shell({
  sidebar,
  aside,
  panel = 'main',
  footer,
  backdrop,
  children,
  className,
}: {
  /** What the screen adds to the sidebar, under the navigation. */
  sidebar?: ReactNode;
  /** The people panel, always shown from xl up. */
  aside?: ReactNode;
  /** Which column a screen narrower than its breakpoint shows. */
  panel?: Panel;
  /** Under the columns: the player and the phone's tab bar. */
  footer?: ReactNode;
  /** Colour behind the window; a <Backdrop />. */
  backdrop?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="relative isolate flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Lens />
      {backdrop}
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <aside
          className={cn(
            'glass min-h-0 shrink-0 flex-col overflow-hidden rounded-[28px] md:flex md:w-64',
            panel === 'sidebar' ? 'flex w-full' : 'hidden',
          )}
        >
          <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
            <span className="grid size-8 place-items-center rounded-[10px] bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.3)]">
              <Equalizer className="h-4" />
            </span>
            <span className="text-xl font-bold tracking-tight">rave</span>
          </div>
          <SideNav />
          {sidebar && <div className="mt-2 flex min-h-0 flex-1 flex-col">{sidebar}</div>}
        </aside>
        {/* The wrapper does not scroll; main does, under the floating bar. */}
        <div
          className={cn(
            'relative min-w-0 flex-1 flex-col md:flex',
            panel === 'main' ? 'flex' : 'hidden',
          )}
        >
          <main
            id="main"
            className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[28px]', className)}
          >
            {children}
          </main>
        </div>
        {aside && (
          <aside
            className={cn(
              'glass min-h-0 shrink-0 flex-col overflow-y-auto rounded-[28px] md:w-64 xl:flex',
              panel === 'aside' ? 'flex w-full md:flex' : 'hidden',
            )}
          >
            {aside}
          </aside>
        )}
      </div>
      {footer}
    </div>
  );
}

/** A row at the top of a panel: a title and what goes with it. */
export function Bar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header className={cn('flex h-14 shrink-0 items-center gap-2 px-5 text-[0.9375rem] font-semibold', className)}>
      {children}
    </header>
  );
}

/**
 * The main area's bar: a glass capsule that floats and stays put while the
 * content scrolls under it, instead of a strip glued to the edge.
 */
export function TopBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'glass sticky top-0 z-20 mb-2 flex h-14 shrink-0 items-center gap-2 rounded-full px-5 font-semibold',
        className,
      )}
    >
      {children}
    </header>
  );
}

/**
 * One SVG filter, used by `.lens` (Chromium only): it bends what is behind
 * the player at its edges, as Liquid Glass does. The map is two gradients,
 * red for sideways and green for up and down, flat grey in the middle (no
 * bend) and strongest at the rim. Everywhere else the plain blur is used.
 */
function Lens() {
  const map = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" preserveAspectRatio="none">
      <defs>
        <linearGradient id="x"><stop offset="0" stop-color="#f00"/><stop offset=".12" stop-color="#800"/><stop offset=".88" stop-color="#800"/><stop offset="1" stop-color="#000"/></linearGradient>
        <linearGradient id="y" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f0"/><stop offset=".3" stop-color="#080"/><stop offset=".7" stop-color="#080"/><stop offset="1" stop-color="#000"/></linearGradient>
      </defs>
      <rect width="100" height="100" fill="#000"/>
      <rect width="100" height="100" fill="url(#x)"/>
      <rect width="100" height="100" fill="url(#y)" style="mix-blend-mode:screen"/>
    </svg>`,
  );
  return (
    <svg aria-hidden width="0" height="0" className="pointer-events-none absolute">
      <filter id="lens" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB" primitiveUnits="objectBoundingBox">
        <feImage href={`data:image/svg+xml,${map}`} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.06" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
