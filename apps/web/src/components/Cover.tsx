import { Disc3 } from 'lucide-react';
import type { TrackArt } from '@/lib/artimage';
import { coverOf } from '@/lib/cover';
import { cn } from '@/lib/utils';

/** The two colours a track lights the room with: its picture's, or the generated cover's. */
export function glowOf(title: string, art?: TrackArt): [string, string] {
  return art?.glow ?? coverOf(title).glow;
}

/**
 * A track's cover: the picture inside its file when there is one, otherwise
 * one made from its title, so no track is ever blank and the same title always
 * looks the same on every device. Decoration: the title is always beside it.
 */
export function Cover({
  title,
  art,
  className,
}: {
  /** Undefined draws the empty disc: no track yet. */
  title?: string;
  art?: TrackArt;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn('relative grid shrink-0 place-items-center overflow-hidden bg-muted', className)}
      style={title !== undefined && !art ? { background: coverOf(title).background } : undefined}
    >
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small blob: URL made here; the image optimiser cannot reach it.
        <img src={art.url} alt="" decoding="async" className="size-full object-cover" />
      ) : title === undefined ? (
        <Disc3 className="size-1/3 text-muted-foreground" />
      ) : null}
    </div>
  );
}
