import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — this file is owned in-repo and editable,
// not a dependency. `npx shadcn@latest add <name>` drops siblings here.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow hover:opacity-90',
        destructive:
          'bg-[var(--color-destructive)] text-[var(--color-destructive-foreground)] shadow-sm hover:opacity-90',
        outline:
          'border border-[var(--color-border)] bg-transparent shadow-sm hover:bg-[var(--color-accent)]',
        secondary:
          'bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)] shadow-sm hover:opacity-80',
        ghost: 'hover:bg-[var(--color-accent)]',
        link: 'text-[var(--color-primary)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
