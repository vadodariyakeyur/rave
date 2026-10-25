'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Equalizer } from '@/components/Equalizer';
import { cn } from '@/lib/utils';

/** True from 1024px up, where Shell lays out two columns. False until mounted. */
export function useWide() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(min-width: 1024px)');
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => false,
  );
}

const COLUMN = 'relative flex min-w-0 flex-col gap-4 pr-(--plunk) pb-(--plunk) lg:min-h-0 lg:overflow-y-auto';

/**
 * The frame every screen sits in, as CRED's apps lay it out: a full-bleed
 * header, blocks, and an optional call-to-action bar stuck to the bottom.
 * On a phone it is one column that scrolls with the page, `aside` first. From
 * 1024px up the page is one screen tall and does not scroll: `aside` (who and
 * what this is) is the left column and the content the right, and each column
 * scrolls on its own if it has to.
 *
 * Each column pads right and bottom by a plunk edge: edges are drawn outside
 * their box, and a scrolling column would cut them off.
 */
export function Shell({
  header,
  cta,
  backdrop,
  aside,
  banner,
  children,
}: {
  header: ReactNode;
  /** Full-bleed strip under the header. */
  banner?: ReactNode;
  /** The screen's identity: hero, preview, title. Left column on a wide screen. */
  aside?: ReactNode;
  /** The one thing to do on this screen; stays in view. */
  cta?: ReactNode;
  /** Colour behind the column; a <Backdrop />. */
  backdrop?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-background text-foreground lg:h-dvh lg:overflow-clip">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      {backdrop}
      {header}
      {banner}
      <main
        id="main"
        className={cn(
          'mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 pt-4 pb-4 lg:grid lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] lg:gap-8 lg:pt-6',
          aside && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
        )}
      >
        {aside && <div className={COLUMN}>{aside}</div>}
        <div
          className={cn(COLUMN, !aside && 'lg:place-self-center lg:w-full lg:max-w-160')}
        >
          {children}
        </div>
      </main>
      {cta && (
        <div className="sticky bottom-0 z-20 border-t-2 border-ring bg-background">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {cta}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The full-bleed bar at the top: where you came from (or the app's mark, on
 * the home screen), what this is, and what you can do from here.
 */
export function Header({
  back,
  title,
  actions,
}: {
  /** Where the arrow goes. Omitted on the home screen, which shows the mark. */
  back?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
        {back ? (
          <Link
            href={back}
            aria-label="Back to rooms"
            className="-ml-2 flex size-11 items-center justify-center text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-5" />
          </Link>
        ) : (
          <span className="grid size-8 place-items-center bg-ring text-background">
            <Equalizer className="h-4" />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-display text-lg tracking-wide uppercase">{title ?? 'rave'}</span>
        {actions}
      </div>
    </header>
  );
}
