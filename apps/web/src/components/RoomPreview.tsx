import type { ReactNode } from 'react';
import { Lock, Mic, Music, Users } from 'lucide-react';
import type { Mode } from '@rave/protocol';
import { Cover } from '@/components/Cover';
import { Equalizer } from '@/components/Equalizer';
import { coverOf } from '@/lib/cover';

/**
 * A room as a person sees it before they are in it: a card tinted in the
 * colours of its cover (made from its name, so it is the same everywhere),
 * what it is for, and what is going on. Used by the room list, the create
 * form's preview and the join screen, so the three can never describe the
 * same room three ways. `footer` sits inside the card, under the details.
 */
export function RoomPreview({
  name,
  description,
  mode,
  memberCount,
  hasPasscode,
  nowPlaying,
  footer,
}: {
  /** Empty draws the placeholder disc and "Your room". */
  name: string;
  description?: string;
  mode: Mode;
  memberCount?: number;
  hasPasscode?: boolean;
  nowPlaying?: string | null;
  footer?: ReactNode;
}) {
  const seed = name.trim();
  const [c0, c1] = seed ? coverOf(seed).glow : ['var(--color-muted)', 'var(--color-muted)'];
  return (
    <span
      className="panel group/card flex min-w-0 flex-col rounded-[20px] p-2 text-card-foreground"
      style={{
        background: `linear-gradient(160deg, color-mix(in oklch, ${c0} 18%, var(--color-card)), color-mix(in oklch, ${c1} 8%, var(--color-card)))`,
      }}
    >
      {/* The banner is the cover again, blown up and blurred into a wash of its colours. */}
      <span aria-hidden className="block h-28 overflow-hidden rounded-xl">
        <Cover
          title={seed || undefined}
          className="size-full scale-150 rounded-none blur-xl saturate-150 transition-transform duration-700 ease-soft group-hover/card:scale-[1.7]"
        />
      </span>
      <span className="flex min-w-0 flex-col gap-1 px-2 pb-2">
        <Cover title={seed || undefined} className="-mt-7 size-14 rounded-2xl ring-4 ring-card" />
        <span className="flex items-center gap-2 pt-1 text-lg font-bold tracking-tight">
          <span className="truncate">{seed || 'Your room'}</span>
          {hasPasscode && <Lock aria-label="Needs a passcode" className="size-4 shrink-0" />}
        </span>
        {description && (
          <span className="line-clamp-2 text-sm text-muted-foreground">{description}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {mode === 'talk' ? <Mic className="size-4 text-chart-1" /> : <Music className="size-4" />}
            {mode === 'talk' ? 'talking' : 'music'}
          </span>
          {memberCount !== undefined && (
            <span className="flex items-center gap-1.5">
              <Users className="size-4" />
              {memberCount} {memberCount === 1 ? 'person' : 'people'}
            </span>
          )}
        </span>
        {mode === 'music' && nowPlaying && (
          <span className="mt-2 flex min-w-0 items-center gap-2 rounded-full bg-black/25 px-3 py-1.5 text-sm text-chart-1">
            <Equalizer />
            <span className="truncate">playing {nowPlaying}</span>
          </span>
        )}
        {footer}
      </span>
    </span>
  );
}
