import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "cyan",
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: LucideIcon;
  tone?: "cyan" | "blue" | "emerald" | "amber" | "rose" | "violet" | "slate";
  className?: string;
}) {
  const tones: Record<string, string> = {
    cyan: "from-cyan-500/18 text-cyan-300 border-cyan-400/25",
    blue: "from-sky-500/18 text-sky-300 border-sky-400/25",
    emerald: "from-emerald-500/18 text-emerald-300 border-emerald-400/25",
    amber: "from-amber-500/18 text-amber-300 border-amber-400/25",
    rose: "from-rose-500/18 text-rose-300 border-rose-400/25",
    violet: "from-violet-500/18 text-violet-300 border-violet-400/25",
    slate: "from-slate-400/14 text-slate-300 border-white/12",
  };

  return (
    <Card className={cn("relative overflow-hidden p-5", className)}>
      <div className={cn("absolute inset-x-0 top-0 h-px bg-gradient-to-r to-transparent", tones[tone])} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <p className="stat-value mt-2 truncate">{value}</p>
          {hint ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
        </div>
        {Icon ? (
          <span
            className={cn(
              "grid h-10 w-10 shrink-0 place-items-center rounded-xl border bg-gradient-to-br to-transparent",
              tones[tone],
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        ) : null}
      </div>
    </Card>
  );
}
