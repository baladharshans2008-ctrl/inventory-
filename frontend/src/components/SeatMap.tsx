import { Armchair } from "lucide-react";
import type { SeatPreview } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  AVAILABLE: "border-emerald-400/40 bg-emerald-400/12 text-emerald-200 hover:border-emerald-300",
  HELD: "border-amber-400/40 bg-amber-400/12 text-amber-200",
  CONFIRMED: "border-slate-500/40 bg-slate-500/15 text-slate-300",
};

const LEGEND = [
  { status: "AVAILABLE", label: "Available" },
  { status: "HELD", label: "Held (awaiting payment)" },
  { status: "CONFIRMED", label: "Confirmed" },
];

/**
 * Physical seat preview straight from the database: the same rows the
 * allocation transaction locks, so what you see is the authoritative state -
 * not a cached or optimistic guess.
 */
export function SeatMap({
  seats,
  className,
  columns = 8,
}: {
  seats: SeatPreview[];
  className?: string;
  columns?: number;
}) {
  if (!seats.length) {
    return (
      <p className={cn("rounded-xl border border-dashed border-white/12 px-4 py-8 text-center text-sm text-muted-foreground", className)}>
        No seat rows published for this class yet.
      </p>
    );
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-3 pb-4">
        {LEGEND.map((item) => (
          <span key={item.status} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("h-3 w-3 rounded border", STATUS_STYLES[item.status])} aria-hidden />
            {item.label}
          </span>
        ))}
      </div>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        role="list"
        aria-label="Seat availability preview"
      >
        {seats.map((seat) => (
          <div
            key={seat.seat_number}
            role="listitem"
            title={`${seat.seat_number} - ${seat.seat_type} - ${seat.status}`}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center transition-colors",
              STATUS_STYLES[seat.status] ?? STATUS_STYLES.CONFIRMED,
            )}
          >
            <Armchair className="h-3.5 w-3.5" aria-hidden />
            <span className="font-mono text-[0.62rem] font-medium">{seat.seat_number}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SeatSummaryBar({
  total,
  available,
  held,
  confirmed,
}: {
  total: number;
  available: number;
  held: number;
  confirmed: number;
}) {
  const pct = (value: number) => (total ? `${(value / total) * 100}%` : "0%");
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <span className="bg-slate-500/60" style={{ width: pct(confirmed) }} title={`Confirmed ${confirmed}`} />
        <span className="bg-amber-400/70" style={{ width: pct(held) }} title={`Held ${held}`} />
        <span className="bg-emerald-400/70" style={{ width: pct(available) }} title={`Available ${available}`} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-400/80" aria-hidden /> {available} available
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-amber-400/80" aria-hidden /> {held} held
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-slate-500/80" aria-hidden /> {confirmed} confirmed
        </span>
        <span className="ml-auto font-mono">{total} seats</span>
      </div>
    </div>
  );
}
