import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — this file is owned in-repo and editable,
// not a dependency. `npx shadcn@latest add <name>` drops siblings here.
//
// A button sits on the theme's shadow and is pushed down into it: the
// feedback is on the press itself, not on release.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-[translate,scale,box-shadow,background-color] duration-100 ease-out active:translate-y-1 active:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-md hover:brightness-105',
        destructive: 'bg-destructive text-destructive-foreground shadow-md hover:brightness-105',
        outline: 'border-2 border-border bg-card text-card-foreground shadow-md hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground shadow-md hover:brightness-110',
        // Nothing underneath to press into, so these give instead.
        ghost: 'hover:bg-accent hover:text-accent-foreground active:translate-y-0 active:scale-90',
        link: 'text-primary underline-offset-4 hover:underline active:translate-y-0',
      },
      size: {
        default: 'h-11 px-5',
        sm: 'h-9 px-4',
        lg: 'h-13 px-7 text-base',
        icon: 'size-10',
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
