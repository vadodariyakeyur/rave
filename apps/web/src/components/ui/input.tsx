import * as React from 'react';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — owned in-repo, not a dependency.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1 text-base shadow-sm transition-colors',
        'placeholder:text-[var(--color-muted-foreground)]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'file:mr-3 file:h-7 file:rounded-md file:border-0 file:bg-[var(--color-secondary)] file:px-3 file:text-sm file:font-medium file:text-[var(--color-secondary-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
