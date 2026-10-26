import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-cyan-400/30 bg-cyan-400/12 text-cyan-200",
        secondary: "border-white/12 bg-white/[0.06] text-muted-foreground",
        success: "border-emerald-400/30 bg-emerald-400/12 text-emerald-200",
        warning: "border-amber-400/30 bg-amber-400/12 text-amber-200",
        destructive: "border-rose-400/30 bg-rose-400/12 text-rose-200",
        outline: "border-white/20 bg-transparent text-foreground",
        sky: "border-sky-400/30 bg-sky-400/12 text-sky-200",
        violet: "border-violet-400/30 bg-violet-400/12 text-violet-200",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
