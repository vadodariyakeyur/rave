'use client';

/**
 * Where the track is, for everyone in the room.
 *
 * Shown to listeners as well as the creator: a silent device with a bar
 * that is visibly moving is a device that is working, and one frozen at
 * 0:00 says the opposite. It is the only feedback a peer has that the
 * room is actually playing.
 *
 * Read-only on purpose. Dragging it would be a seek, and a seek is a cue
 * the whole room has to agree on — it belongs on the creator's controls,
 * not on a progress indicator every peer renders.
 */
export function TrackProgress({
  positionSeconds,
  durationSeconds,
  playing,
}: {
  positionSeconds: number;
  durationSeconds: number;
  playing: boolean;
}) {
  const percent = progressPercent(positionSeconds, durationSeconds);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-label="Track position"
        // The seconds, not the percentage: "1:34 of 3:12" is what the
        // number means, and a screen reader saying "49 percent" of a song
        // is not an answer to where it is.
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSeconds)}
        aria-valuenow={Math.round(positionSeconds)}
        aria-valuetext={`${formatDuration(positionSeconds)} of ${formatDuration(durationSeconds)}`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-muted)]"
      >
        <div
          className="h-full rounded-full bg-[var(--color-primary)]"
          // Width, not a transform: the bar is re-read on a timer rather
          // than animated, so a CSS transition would be chasing the value
          // it is already being given.
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between text-xs tabular-nums text-[var(--color-muted-foreground)]">
        {/* Tabular figures so the digits do not shuffle sideways each tick. */}
        <span>{formatDuration(positionSeconds)}</span>
        <span>{playing ? formatDuration(durationSeconds) : 'Paused'}</span>
      </div>
    </div>
  );
}

/**
 * How far through, 0 to 100.
 *
 * Clamped at both ends: position is derived from the audio clock, which
 * can read a hair past the buffer length on the last tick before a track
 * ends, and a bar wider than its track spills out of the rounded corners.
 */
export function progressPercent(positionSeconds: number, durationSeconds: number): number {
  // A zero-length buffer cannot really happen, but the division would be
  // NaN and NaN reaches the DOM as an invalid width rather than an error.
  if (!(durationSeconds > 0)) return 0;
  return Math.min(Math.max((positionSeconds / durationSeconds) * 100, 0), 100);
}

/** m:ss. Shared with the room header, which shows the track length. */
export function formatDuration(seconds: number): string {
  // Floor, not round: at 0.9s into a track the honest reading is 0:00, and
  // rounding would show a track ending a second before it does.
  const whole = Math.max(Math.floor(seconds), 0);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
