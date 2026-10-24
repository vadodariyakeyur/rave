import { Cover, glowOf } from '@/components/Cover';
import type { TrackArt } from '@/lib/artimage';
import { cn } from '@/lib/utils';

/**
 * The colour behind the whole window, taken from a cover. The flat panels
 * sit on it, so a cover's colour reaches them: one hard block of the cover,
 * dimmed, with no blur or motion. A new cover crossfades in.
 */
export function Backdrop({
  title,
  art,
  calm = false,
}: {
  /** What the generated cover is made from when there is no picture. */
  title: string;
  art?: TrackArt;
  /** Little colour: for screens where nothing is playing, so the panels are not sitting on a loud wash. */
  calm?: boolean;
}) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div key={art?.url ?? title} className="absolute inset-0 animate-fade">
        <Cover
          title={title}
          grid={8}
          art={art}
          // Repeated at a fixed size, so a wide window gets more tiles, not bigger ones.
          className={cn(
            'absolute inset-0 size-full [background-repeat:repeat]! [background-size:112rem]!',
            calm ? 'saturate-100' : 'saturate-[1.6]',
          )}
        />
      </div>
      <div className={cn('absolute inset-0', calm ? 'bg-background/85' : 'bg-background/80')} />
      {/* Calm screens get a slow colour wash in the cover's own colours, so they are never plain black. */}
      {calm && (
        <>
          <span
            className="absolute -top-24 -left-24 size-96 animate-spin-slow rounded-full opacity-40 blur-3xl"
            style={{ background: glowOf(title, art)[0] }}
          />
          <span
            className="absolute -right-24 bottom-0 size-96 animate-spin-slow rounded-full opacity-30 blur-3xl [animation-direction:reverse]"
            style={{ background: glowOf(title, art)[1] }}
          />
        </>
      )}
    </div>
  );
}
