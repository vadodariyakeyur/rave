import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — this file is owned in-repo and editable,
// not a dependency. `npx shadcn@latest add <name>` drops siblings here.
//
// NeoPOP's plunk: square, extra-bold, with two solid edges that the press sinks
// into (see .plunk in globals.css). Ghost and link are flat and carry no edge.
// Disabled loses its edges, the honest signal that it will not depress.
const plunk = 'plunk plunk-press disabled:[--plunk-right:transparent] disabled:[--plunk-bottom:transparent] mr-[3px] mb-[3px]';
const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none text-[0.9375rem] font-extrabold uppercase tracking-wide focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:bg-muted-foreground disabled:text-white/50 [&_svg]:size-5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: `${plunk} bg-primary text-primary-foreground [--plunk-right:var(--color-ring)] [--plunk-bottom:var(--color-ring)]`,
        destructive: `${plunk} bg-destructive text-destructive-foreground`,
        outline: `${plunk} bg-card text-foreground`,
        secondary: `${plunk} bg-secondary text-secondary-foreground [--plunk-right:#8a8a8a] [--plunk-bottom:#e0e0e0]`,
        ghost: 'normal-case tracking-normal text-muted-foreground hover:bg-accent hover:text-foreground',
        link: 'normal-case tracking-normal text-ring underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5',
        sm: 'h-[30px] px-4',
        lg: 'h-[50px] px-8 text-base',
        icon: 'size-11',
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
