'use client';

import type { Ref } from 'react';
import { Activity, Disc3, LoaderCircle, Pause, Play, RotateCcw, Square, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Cover, glowOf } from '@/components/Cover';
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
  visuals,
  onVisuals,
  sectionRef,
}: {
  room: LiveRoom;
  snapshot: RoomSnapshot;
  positionSeconds: number;
  visuals: boolean;
  onVisuals: (on: boolean) => void;
  sectionRef: Ref<HTMLElement>;
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
      ref={sectionRef}
      aria-label="Now playing"
      className="panel relative isolate animate-rise overflow-hidden rounded-[28px] p-5 text-card-foreground sm:p-8"
    >
      <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr] sm:gap-10">
        <div
          className={cn(
            // Paused, the cover steps back a little; playing, it comes forward.
            'relative mx-auto aspect-square w-[min(100%,20rem)] transition-transform duration-700 ease-spring sm:w-80',
            playing ? 'scale-100' : 'scale-[0.92]',
          )}
          style={{ '--halo': current ? `color-mix(in oklch, ${glow0} 55%, transparent)` : 'transparent' } as React.CSSProperties}
        >
          <Visualizer
            room={room}
            active={visuals && playing}
            color={glow0}
            className="absolute inset-0 size-full"
          />
          <Cover
            title={current?.title}
            art={current?.art}
            className={cn(
              'absolute inset-[15%] rounded-full shadow-[0_0_80px_var(--halo)] ring-4 ring-card',
              !current && 'border-2 border-dashed border-white/25',
            )}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Disc3 className={cn('size-4', playing && 'animate-spin [animation-duration:2.4s]')} />
              Now playing
            </p>
            <Button
              type="button"
              variant={visuals ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={visuals}
              onClick={() => onVisuals(!visuals)}
            >
              <Activity />
              Visuals
            </Button>
          </div>

          {current ? (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="line-clamp-2 text-4xl leading-[1.05] font-bold tracking-tight break-words sm:text-5xl">
                  {current.title}
                </h2>
                <p className="text-muted-foreground">
                  Track {index + 1} of {playlist.length}
                </p>
              </div>
              {/* Shown to listeners too: it is the only sign a member has
                  that their silent device is in fact playing. */}
              {snapshot.currentDuration !== undefined ? (
                <TrackProgress
                  positionSeconds={positionSeconds}
                  durationSeconds={snapshot.currentDuration}
                  playing={playing}
                />
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  {current.state === 'ready' ? 'Getting ready…' : 'Still downloading this track…'}
                </p>
              )}
              {isCreator && (
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" className="size-12" onClick={() => room.restart()}>
                    <RotateCcw />
                    <span className="sr-only">Restart</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-16 text-foreground [&_svg]:size-9"
                    disabled={snapshot.currentDuration === undefined}
                    onClick={() => (playing ? room.pause() : room.resume())}
                  >
                    {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
                    <span className="sr-only">
                      {playing ? 'Pause' : positionSeconds > 0 ? 'Resume' : 'Play'}
                    </span>
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-12" onClick={() => room.stop()}>
                    <Square />
                    <span className="sr-only">Stop</span>
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <h2 className="text-4xl leading-[1.05] font-bold tracking-tight sm:text-5xl">Nothing playing yet</h2>
              {isCreator ? (
                <label
                  htmlFor="add-tracks"
                  className="flex cursor-pointer items-center gap-3 rounded-[20px] border-2 border-dashed border-white/25 bg-white/5 p-4 text-muted-foreground transition-colors duration-300 hover:border-ring hover:text-foreground"
                >
                  <Upload className="size-6 shrink-0 text-ring" />
                  Drop audio files here, or tap to choose. Then press play on a track.
                </label>
              ) : (
                <p className="text-muted-foreground">The host picks what plays. Stay close.</p>
              )}
            </>
          )}
          <Reactions room={room} names={names} />
        </div>
      </div>
    </section>
  );
}
