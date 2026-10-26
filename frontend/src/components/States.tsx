import type { LucideIcon } from "lucide-react";
import { AlertOctagon, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/12 bg-white/[0.02] px-6 py-12 text-center",
        className,
      )}
    >
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.05] text-cyan-300">
        <Icon className="h-6 w-6" aria-hidden />
      </span>
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: Error | null;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error?.message ?? "Something went wrong.";
  const isAuth = message.toLowerCase().includes("admin key");
  const isQueue = message.toLowerCase().includes("queue");

  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] px-5 py-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-rose-100">{isAuth ? "Admin key required" : "Request failed"}</p>
          <p className="mt-1 text-sm leading-relaxed text-rose-100/80">{message}</p>
          {isQueue ? (
            <p className="mt-1 text-xs text-rose-100/70">
              The booking service is at capacity. Join the virtual queue to get an admission token.
            </p>
          ) : null}
        </div>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function InfoBanner({
  title,
  children,
  tone = "cyan",
}: {
  title: string;
  children: React.ReactNode;
  tone?: "cyan" | "amber" | "rose" | "emerald";
}) {
  const tones = {
    cyan: "border-cyan-400/25 bg-cyan-400/[0.07] text-cyan-100",
    amber: "border-amber-400/25 bg-amber-400/[0.07] text-amber-100",
    rose: "border-rose-400/25 bg-rose-400/[0.07] text-rose-100",
    emerald: "border-emerald-400/25 bg-emerald-400/[0.07] text-emerald-100",
  } as const;

  return (
    <div className={cn("rounded-xl border px-4 py-3", tones[tone])}>
      <p className="text-sm font-semibold">{title}</p>
      <div className="mt-1 text-sm leading-relaxed opacity-85">{children}</div>
    </div>
  );
}
