'use client';

import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/Cover';
import { progressPercent } from '@/components/TrackProgress';
import type { LiveRoom, RoomSnapshot } from '@/lib/room';

/**
 * Once the stage is out of view (scrolled away, or another panel is open):
 * what is playing and the one control that matters, as a capsule of clear
 * glass floating over the cover's colours. Sits above the phone's tab bar,
 * so it shows on every panel. Clear glass, not regular: it floats over media,
 * which is what that variant is for, and it carries its own dimming.
 */
export function MiniPlayer({
  room,
  snapshot,
  positionSeconds,
}: {
  room: LiveRoom;
  snapshot: RoomSnapshot;
  positionSeconds: number;
}) {
  const current = snapshot.playlist.find((t) => t.id === snapshot.currentTrackId);
  if (!current) return null;
  const percent =
    snapshot.currentDuration === undefined ? 0 : progressPercent(positionSeconds, snapshot.currentDuration);
  return (
    <div className="glass-clear lens mx-auto mb-2 w-[min(34rem,calc(100%-1rem))] animate-rise overflow-hidden rounded-full">
      <div className="flex items-center gap-3 p-2 pr-3">
        <Cover title={current.title} art={current.art} className="size-11 rounded-full" />
        <p className="min-w-0 flex-1 truncate font-semibold">{current.title}</p>
        {snapshot.isCreator ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-foreground [&_svg]:size-6"
            disabled={snapshot.currentDuration === undefined}
            onClick={() => (snapshot.playing ? room.pause() : room.resume())}
          >
            {snapshot.playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            <span className="sr-only">{snapshot.playing ? 'Pause' : 'Play'}</span>
          </Button>
        ) : (
          <span className="pr-1 text-sm text-muted-foreground">{snapshot.playing ? 'Playing' : 'Paused'}</span>
        )}
      </div>
      <div aria-hidden className="mx-5 mb-1.5 h-0.5 overflow-hidden rounded-full bg-white/20">
        <div className="h-full rounded-full bg-white transition-[width] duration-200 ease-linear" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
