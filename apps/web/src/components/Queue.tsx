'use client';

import { Check, ChevronDown, ChevronUp, LoaderCircle, Play, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Cover } from '@/components/Cover';
import { Equalizer } from '@/components/Equalizer';
import type { LiveRoom, PlaylistItem, RoomSnapshot } from '@/lib/room';
import { cn } from '@/lib/utils';

/**
 * The playlist: a cover and a title per track, which one the room is on, and
 * for the creator the controls that change it. Tracks are added here too,
 * through the one file input the whole screen shares (its id is what the
 * stage's drop area points at).
 */
export function Queue({
  room,
  snapshot,
  adding,
  addError,
  onFiles,
}: {
  room: LiveRoom;
  snapshot: RoomSnapshot;
  adding: boolean;
  addError: string | null;
  onFiles: (files: FileList | null) => void;
}) {
  const { isCreator, playing, playlist } = snapshot;
  return (
    <section aria-label="Playlist" className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 text-sm font-semibold text-muted-foreground">
        <h2 className="flex items-center gap-1.5">
          Playlist
          {playlist.length > 0 && <span className="font-medium">{playlist.length}</span>}
        </h2>
        {isCreator && (
          // The input is there and focusable, only not drawn: the label is
          // what is seen, and it shows the input's focus.
          <label
            htmlFor="add-tracks"
            className="grid size-9 cursor-pointer place-items-center rounded-full transition-colors duration-200 hover:bg-white/12 hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring has-disabled:pointer-events-none has-disabled:opacity-50"
          >
            {adding ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
            <span className="sr-only">Add tracks</span>
            <input
              id="add-tracks"
              type="file"
              accept="audio/*"
              multiple
              disabled={adding}
              className="sr-only"
              onChange={(e) => {
                onFiles(e.target.files);
                // So choosing the same file again still fires a change.
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      {playlist.length > 0 && (
        <ol className="flex flex-col gap-0.5">
          {playlist.map((track, index) => {
            const isCurrent = track.id === snapshot.currentTrackId;
            return (
              <li
                key={track.id}
                className={cn(
                  'flex animate-pop flex-col gap-1 rounded-[20px] p-2 transition-colors duration-200 hover:bg-white/8',
                  isCurrent && 'bg-white/12',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="relative">
                    <Cover title={track.title} art={track.art} className="size-11 rounded-lg" />
                    {isCurrent && (
                      <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/55 text-chart-1">
                        <Equalizer playing={playing} />
                      </span>
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate text-sm', isCurrent ? 'font-semibold' : 'font-medium')}>
                      {track.title}
                    </span>
                    <span className="text-xs text-muted-foreground">{index + 1}</span>
                  </span>
                  {!isCreator && <DownloadStatus track={track} />}
                </div>
                {isCreator && (
                  <div className="flex items-center justify-end gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 text-foreground"
                      aria-label={`Play ${track.title}`}
                      onClick={() => void room.playTrack(track.id)}
                    >
                      <Play />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Move ${track.title} up`}
                      disabled={index === 0}
                      onClick={() => room.moveTrack(track.id, -1)}
                    >
                      <ChevronUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Move ${track.title} down`}
                      disabled={index === playlist.length - 1}
                      onClick={() => room.moveTrack(track.id, 1)}
                    >
                      <ChevronDown />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9"
                      aria-label={`Remove ${track.title}`}
                      onClick={() => room.removeTrack(track.id)}
                    >
                      <X />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {adding && <p className="px-2 text-sm text-muted-foreground">Checking the file…</p>}
      {addError && (
        <p role="alert" className="px-2 text-sm font-medium text-destructive">
          {addError}
        </p>
      )}
      {playlist.length === 0 && (
        <div className="flex flex-col items-start gap-3 px-2 py-3">
          <div aria-hidden className="flex">
            {[0, 1, 2].map((i) => (
              <Cover
                key={i}
                className={cn('size-10 rounded-lg border border-dashed border-white/25 bg-transparent', i > 0 && '-ml-4')}
              />
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {isCreator ? 'No tracks yet. Add some with +, or drop files on the stage.' : 'The host has not added any tracks yet.'}
          </p>
        </div>
      )}
    </section>
  );
}

/** Where one track stands on this member's device. */
function DownloadStatus({ track }: { track: PlaylistItem }) {
  const className = 'flex shrink-0 items-center gap-1 text-xs';
  if (track.state === 'ready') {
    return (
      <span className={className}>
        <Check className="size-3.5 animate-pop text-chart-1" />
        ready
      </span>
    );
  }
  if (track.state === 'waiting') {
    return <span className={cn(className, 'text-muted-foreground')}>waiting</span>;
  }
  return (
    <span className={cn(className, 'tabular-nums text-muted-foreground')}>
      <LoaderCircle className="size-3.5 animate-spin" />
      {Math.round((track.progress ?? 0) * 100)}%
    </span>
  );
}
