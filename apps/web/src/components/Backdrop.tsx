import { Cover } from '@/components/Cover';
import type { TrackArt } from '@/lib/artimage';
import { cn } from '@/lib/utils';

// Apple Music's player background, per a teardown of it: four copies of the
// cover at roughly 25, 50, 80 and 125% of the window, the big ones turning in
// place, the small ones also circling, all oversaturated and heavily blurred.
// Each is a small box scaled up, so the blur is worked out small and only
// moved after that.
const LAYERS = [
  'scale-[8.4] animate-spin-slow [animation-direction:reverse] [animation-duration:140s]',
  'scale-[5.4] animate-spin-slow [animation-duration:100s]',
  'scale-[3.4] animate-orbit [animation-duration:60s]',
  'scale-[1.7] animate-orbit [animation-direction:reverse] [animation-duration:40s]',
];

/**
 * The colour behind the whole window, taken from a cover. The glass panels
 * sit on it, so a cover's colour reaches them. It is fixed and outside every
 * scroller, so nothing blurred ever scrolls. A new cover crossfades in.
 */
export function Backdrop({
  title,
  art,
  still = false,
  calm = false,
}: {
  /** What the generated cover is made from when there is no picture. */
  title: string;
  art?: TrackArt;
  /** Nothing is playing: the light stays where it is. */
  still?: boolean;
  /** Little colour: for screens where nothing is playing, so the glass is not sitting on a loud wash. */
  calm?: boolean;
}) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div key={art?.url ?? title} className="absolute inset-0 animate-fade">
        {LAYERS.map((layer) => (
          <Cover
            key={layer}
            title={title}
            art={art}
            className={cn(
              'absolute top-1/2 left-1/2 -mt-24 -ml-24 size-48 blur-2xl',
              calm ? 'saturate-100' : 'saturate-[2.2]',
              still && '[animation-play-state:paused]',
              layer,
            )}
          />
        ))}
      </div>
      <div className={cn('absolute inset-0', calm ? 'bg-background/90' : 'bg-background/55')} />
    </div>
  );
}
