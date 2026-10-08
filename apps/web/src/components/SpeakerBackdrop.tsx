'use client';

import { useEffect, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import type { TrackArt } from '@/lib/artimage';

/**
 * The backdrop for a room, alive: while music plays it is the track's colours
 * (the caller's `fallback` and `art`); in talk mode it takes the colours of
 * whoever spoke last, and stays on them through the silence after. A change
 * waits half a second, so a quick back and forth between two voices is a slow
 * drift of colour and not a flash.
 */
export function SpeakerBackdrop({
  talk,
  speaker,
  fallback,
  art,
  idle,
}: {
  talk: boolean;
  /** Name of someone speaking right now, if anyone is. */
  speaker?: string;
  fallback: string;
  art?: TrackArt;
  /** Nothing is playing: little colour, and the light holds still. */
  idle: boolean;
}) {
  const [held, setHeld] = useState<string>();
  useEffect(() => {
    if (!speaker) return;
    const timer = setTimeout(() => setHeld(speaker), 500);
    return () => clearTimeout(timer);
  }, [speaker]);

  const spoke = talk && held !== undefined;
  return (
    <Backdrop
      title={spoke ? held : fallback}
      art={talk ? undefined : art}
      still={idle && !spoke}
      calm={idle && !spoke}
    />
  );
}
