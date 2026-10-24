import * as React from 'react';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — owned in-repo, not a dependency.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-12 w-full rounded-none border-0 border-b-2 border-border bg-transparent px-1 text-base caret-chart-4 transition-colors focus:border-ring',
        'placeholder:text-white/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-invalid:ring-2 aria-invalid:ring-destructive disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
