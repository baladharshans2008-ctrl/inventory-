import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { countdownLabel } from "@/lib/format";

/**
 * Live mm:ss countdown for a seat-hold expiry.
 * The remaining time is always recomputed from the server timestamp, so a
 * browser refresh cannot extend a hold.
 */
export function CountdownTimer({
  expiresAt,
  onExpire,
  className,
  compact = false,
}: {
  expiresAt: string | null | undefined;
  onExpire?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));

  useEffect(() => {
    setRemaining(secondsUntil(expiresAt));
    if (!expiresAt) return;
    const id = window.setInterval(() => {
      const next = secondsUntil(expiresAt);
      setRemaining((prev) => {
        if (next <= 0 && prev > 0) onExpire?.();
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  const urgent = remaining > 0 && remaining <= 120;
  const done = remaining <= 0;

  if (compact) {
    return (
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          done ? "text-rose-300" : urgent ? "text-amber-300" : "text-emerald-300",
          className,
        )}
      >
        {done ? "expired" : countdownLabel(remaining)}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 font-mono text-sm tabular-nums",
        done
          ? "border-rose-400/30 bg-rose-400/10 text-rose-200"
          : urgent
            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
            : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
        className,
      )}
      role="timer"
      aria-live="polite"
    >
      <Timer className="h-4 w-4" aria-hidden />
      {done ? "Hold expired" : countdownLabel(remaining)}
    </div>
  );
}

function secondsUntil(value: string | null | undefined): number {
  if (!value) return 0;
  const normalised = /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const target = new Date(normalised).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 1000));
}
