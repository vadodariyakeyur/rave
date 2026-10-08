import * as React from 'react';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — owned in-repo, not a dependency.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-12 w-full rounded-full border-0 bg-white/10 px-5 text-base transition-[box-shadow,background-color] duration-200 ease-soft focus:bg-white/14',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'aria-invalid:ring-2 aria-invalid:ring-destructive disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
