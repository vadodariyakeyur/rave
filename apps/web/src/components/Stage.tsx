'use client';

import { Disc3, LoaderCircle, Pause, Play, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Cover, glowOf } from '@/components/Cover';
import { Tag } from '@/components/Tag';
import { Reactions } from '@/components/Reactions';
import { TrackProgress } from '@/components/TrackProgress';
import { Visualizer } from '@/components/Visualizer';
import type { LiveRoom, RoomSnapshot } from '@/lib/room';
import { cn } from '@/lib/utils';

/**
 * Music mode's centrepiece: the cover with a ring of bars that move with the
 * sound, the title, how far through, and the creator's transport.
 *
 * The room is lit in the track's colours, taken from its picture or its
 * generated cover, and the light crossfades when the track changes. With
 * nothing playing there is one thing to do, and it is the dashed area.
 */
export function Stage({
  room,
  snapshot,
  positionSeconds,
  compact,
}: {
  room: LiveRoom;
  snapshot: RoomSnapshot;
  positionSeconds: number;
  /** Cover beside the text, so the stage is short enough to leave room for the playlist. */
  compact?: boolean;
}) {
  const { isCreator, playing, playlist } = snapshot;
  const index = playlist.findIndex((t) => t.id === snapshot.currentTrackId);
  const current = playlist[index];
  const [glow0, glow1] = current
    ? glowOf(current.title, current.art)
    : ['var(--color-primary)', 'var(--color-chart-1)'];
  const names = new Map(snapshot.peers.map((p) => [p.peerId, p.displayName]));

  return (
    <section
      aria-label="Now playing"
      className="flat relative isolate animate-rise overflow-hidden p-5 text-card-foreground"
      style={{
        backgroundImage: `linear-gradient(160deg, color-mix(in oklch, ${glow0} 28%, transparent), transparent 70%)`,
      }}
    >
      <div className={cn('flex gap-6', compact ? 'items-center' : 'flex-col')}>
        <div
          className={cn(
            // Paused, the cover steps back a little; playing, it comes forward.
            'relative aspect-square transition-transform duration-700 ease-spring',
            compact ? 'w-48 shrink-0' : 'mx-auto w-full max-w-80',
            playing ? 'scale-100' : 'scale-[0.92]',
          )}
          style={
            {
              '--halo': current ? `color-mix(in oklch, ${glow0} 55%, transparent)` : 'transparent',
            } as React.CSSProperties
          }
        >
          <Visualizer room={room} active={playing} color={glow0} className="absolute inset-0 size-full" />
          <Cover
            title={current?.title}
            art={current?.art}
            className={cn(
              'absolute inset-[15%] rounded-none shadow-[0_0_80px_var(--halo)] ring-4 ring-card',
              !current && 'border-2 border-dashed border-white/25',
            )}
          />
        </div>

        <div className={cn('flex min-w-0 flex-col', compact ? 'flex-1 gap-3' : 'gap-5')}>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Disc3 className={cn('size-4', playing && 'animate-spin [animation-duration:2.4s]')} />
              Now playing
              {playing && <Tag tone="live">Live</Tag>}
            </p>
          </div>

          {current ? (
            <>
              <div className="flex flex-col gap-1">
                <h2
                  className={cn(
                    'font-display leading-[1] tracking-tight break-words',
                    compact ? 'line-clamp-1 text-[1.75rem]' : 'line-clamp-2 text-[2.25rem]',
                  )}
                >
                  {current.title}
                </h2>
                <p className="text-muted-foreground">
                  Track {index + 1} of {playlist.length}
                </p>
              </div>
              {/* Shown to listeners too: it is the only sign a member has
                  that their silent device is in fact playing. */}
              <TrackProgress
                positionSeconds={positionSeconds}
                durationSeconds={snapshot.currentDuration ?? 0}
                playing={playing}
              />
              {snapshot.currentDuration === undefined && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  {current.state === 'ready' ? 'Getting ready…' : 'Still downloading this track…'}
                </p>
              )}
            </>
          ) : (
            <>
              <h2 className="font-display text-[2.25rem] leading-[1] tracking-tight">Nothing playing yet</h2>
              {!isCreator && <p className="text-muted-foreground">The host picks what plays. Stay close.</p>}
              <TrackProgress positionSeconds={0} durationSeconds={0} playing={false} />
            </>
          )}
          <Reactions room={room} names={names} />
        </div>
      </div>
    </section>
  );
}

/**
 * The creator's restart, play/pause and stop. Lives in the room's call-to-
 * action bar, so it stays in reach however far the page is scrolled.
 */
export function Transport({
  room,
  snapshot,
  positionSeconds,
}: {
  room: LiveRoom;
  snapshot: RoomSnapshot;
  positionSeconds: number;
}) {
  const { playing } = snapshot;
  return (
    <div className="flex w-full items-center justify-center gap-3">
      <Button type="button" variant="outline" size="icon" onClick={() => room.restart()}>
        <RotateCcw />
        <span className="sr-only">Restart</span>
      </Button>
      <Button
        type="button"
        size="lg"
        className="flex-1"
        disabled={snapshot.currentDuration === undefined}
        onClick={() => (playing ? room.pause() : room.resume())}
      >
        {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
        {playing ? 'Pause' : positionSeconds > 0 ? 'Resume' : 'Play'}
      </Button>
      <Button type="button" variant="outline" size="icon" onClick={() => room.stop()}>
        <Square />
        <span className="sr-only">Stop</span>
      </Button>
    </div>
  );
}
