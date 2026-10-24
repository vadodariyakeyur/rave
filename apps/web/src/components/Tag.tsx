import { cn } from '@/lib/utils';

const TONE = {
  live: 'block-green',
  host: 'block-yellow',
  locked: 'block-pink',
  music: 'block-lime',
  talk: 'block-pink',
  ready: 'block-green',
  wait: 'border border-border text-muted-foreground',
} as const;

/** A small uppercase chip. Always carries text: colour alone says nothing. */
export function Tag({ tone, children, className }: { tone: keyof typeof TONE; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[0.6875rem] leading-4 font-extrabold tracking-wider uppercase',
        TONE[tone],
        className,
      )}
    >
      {tone === 'live' && <span aria-hidden className="size-1.5 animate-pulse bg-current" />}
      {children}
    </span>
  );
}
