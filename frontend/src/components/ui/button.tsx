import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-r from-cyan-500 to-sky-500 text-slate-950 shadow-[0_10px_30px_-12px_rgba(6,182,212,0.75)] hover:from-cyan-400 hover:to-sky-400 hover:shadow-[0_14px_38px_-12px_rgba(6,182,212,0.9)]",
        secondary:
          "border border-white/12 bg-white/[0.06] text-foreground hover:bg-white/[0.11] hover:border-white/20",
        outline:
          "border border-white/15 bg-transparent text-foreground hover:bg-white/[0.07] hover:border-cyan-400/40",
        ghost: "text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
        destructive:
          "bg-gradient-to-r from-rose-500 to-red-500 text-white shadow-[0_10px_30px_-14px_rgba(244,63,94,0.8)] hover:from-rose-400 hover:to-red-400",
        success:
          "bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-[0_10px_30px_-14px_rgba(16,185,129,0.8)] hover:from-emerald-400 hover:to-teal-400",
        link: "text-cyan-300 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-12 rounded-xl px-7 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
