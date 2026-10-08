'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flame, Heart, Laugh, PartyPopper, ThumbsUp, type LucideIcon } from 'lucide-react';
import type { Reaction } from '@rave/protocol';
import { Button } from '@/components/ui/button';
import { hash } from '@/lib/cover';
import type { LiveRoom } from '@/lib/room';

const REACTIONS: { reaction: Reaction; label: string; Icon: LucideIcon }[] = [
  { reaction: 'heart', label: 'Heart', Icon: Heart },
  { reaction: 'fire', label: 'Fire', Icon: Flame },
  { reaction: 'thumbs-up', label: 'Thumbs up', Icon: ThumbsUp },
  { reaction: 'party', label: 'Party', Icon: PartyPopper },
  { reaction: 'laugh', label: 'Laugh', Icon: Laugh },
];

/** More than this at once is a smear, and a lot of layers for a phone. */
const MAX_FLOATING = 24;

/** A tap a few times a second feels live; faster is a held-down button. */
const COOLDOWN_MS = 200;

interface Floating {
  id: number;
  reaction: Reaction;
  /** Where along the bottom it starts, 5 to 95 percent, from who sent it. */
  at: number;
}

/**
 * The reaction buttons, and the icons that rise for everyone's taps.
 *
 * The icons are drawn in the theme's live colour from lucide, not as emoji,
 * so a different theme recolours them and no platform draws them differently.
 * Under reduced motion they appear and vanish at once; the live region says
 * who sent what, which is the part that matters.
 */
export function Reactions({
  room,
  names,
  className,
}: {
  room: LiveRoom;
  /** Peer id to display name, for the announcement. */
  names: ReadonlyMap<string, string>;
  className?: string;
}) {
  const [floating, setFloating] = useState<Floating[]>([]);
  const [said, setSaid] = useState('');
  const next = useRef(0);
  const last = useRef(0);
  // Read through a ref so the subscription is not remade each time the roster changes.
  const nameOf = useRef(names);
  useEffect(() => {
    nameOf.current = names;
  });

  useEffect(
    () =>
      room.onReaction(({ from, reaction }) => {
        const id = next.current++;
        // Spread by who sent it, with a nudge so one person's taps do not stack.
        const at = 5 + ((hash(from) + id * 37) % 90);
        setFloating((all) => [...all.slice(-(MAX_FLOATING - 1)), { id, reaction, at }]);
        const who = from === room.snapshot().selfPeerId ? 'You' : (nameOf.current.get(from) ?? 'Someone');
        setSaid(`${who} sent ${REACTIONS.find((r) => r.reaction === reaction)?.label.toLowerCase()}`);
      }),
    [room],
  );

  return (
    <>
      <div role="group" aria-label="Reactions" className={className ?? 'flex flex-wrap gap-2'}>
        {REACTIONS.map(({ reaction, label, Icon }) => (
          <Button
            key={reaction}
            type="button"
            variant="outline"
            size="icon"
            aria-label={label}
            onClick={() => {
              const now = Date.now();
              if (now - last.current < COOLDOWN_MS) return;
              last.current = now;
              room.react(reaction);
            }}
          >
            <Icon />
          </Button>
        ))}
      </div>
      <p aria-live="polite" className="sr-only">
        {said}
      </p>
      {/* Over everything, under every tap: the layer never takes a click. In
          the document body, not here: this component sits inside a glass bar,
          and a backdrop-filter makes its element the containing block of
          anything fixed inside it, which would clip the icons to the bar. */}
      {createPortal(
        <div aria-hidden className="pointer-events-none fixed inset-0 z-40 overflow-hidden">
          {floating.map(({ id, reaction, at }) => {
            const Icon = REACTIONS.find((r) => r.reaction === reaction)!.Icon;
            return (
              <Icon
                key={id}
                onAnimationEnd={() => setFloating((all) => all.filter((f) => f.id !== id))}
                className="absolute bottom-0 size-9 animate-float-up fill-chart-1/30 text-chart-1"
                style={{ left: `${at}%` }}
              />
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
