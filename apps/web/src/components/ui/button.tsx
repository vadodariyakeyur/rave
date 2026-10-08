import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Vendored from shadcn/ui — this file is owned in-repo and editable,
// not a dependency. `npx shadcn@latest add <name>` drops siblings here.
//
// Capsules, as Apple's controls are. The main action is the accent, lit along
// its top edge; the rest are flat tints that sit inside whatever glass holds
// them (glass does not go on glass). The press is a shrink on the press
// itself, quick, and the colour changes follow at the softer pace.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-[0.9375rem] font-semibold transition-[scale,background-color,filter] duration-200 ease-soft active:scale-[0.96] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.28)] hover:brightness-110',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
        outline: 'bg-white/12 text-foreground hover:bg-white/18',
        secondary: 'bg-white/12 text-foreground hover:bg-white/18',
        ghost: 'text-muted-foreground hover:bg-white/10 hover:text-foreground',
        link: 'text-ring underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-5',
        sm: 'h-10 px-4',
        lg: 'h-14 px-8 text-base',
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
