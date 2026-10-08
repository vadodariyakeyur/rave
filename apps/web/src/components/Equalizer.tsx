import { cn } from '@/lib/utils';

// Negative, so every bar is mid-swing from the first frame, and fixed, so
// two equalizers mounted together move as one: that is the product.
const DELAYS = ['-0.1s', '-0.55s', '-0.3s', '-0.75s'];

/** Bars that move while something is playing. Decoration: say it in text too. */
export function Equalizer({ playing = true, className }: { playing?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex h-4 shrink-0 items-end gap-0.5', className)}>
      {DELAYS.map((delay) => (
        <span
          key={delay}
          className={cn(
            'h-full w-1 origin-bottom rounded-full bg-current',
            playing ? 'animate-eq' : 'scale-y-30',
          )}
          style={{ animationDelay: delay }}
        />
      ))}
    </span>
  );
}
