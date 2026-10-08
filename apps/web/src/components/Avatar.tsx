import { avatarOf, initialsOf } from '@/lib/cover';
import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-24 text-3xl',
} as const;

/**
 * A person, as a coloured disc with their initials. The colour comes from
 * their name, so they look the same to everyone. Decoration: the name is
 * always written next to it.
 */
export function Avatar({
  name,
  size = 'md',
  speaking = false,
  className,
}: {
  name: string;
  size?: keyof typeof SIZES;
  /** A ring in the theme's live colour, for as long as they are talking. */
  speaking?: boolean;
  className?: string;
}) {
  const { background, color } = avatarOf(name);
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-bold transition-shadow duration-150',
        SIZES[size],
        speaking && 'ring-[3px] ring-chart-1',
        className,
      )}
      style={{ background, color }}
    >
      {initialsOf(name)}
    </span>
  );
}
