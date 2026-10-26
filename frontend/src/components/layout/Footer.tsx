import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Database, Server, ShieldCheck, TrainFront } from "lucide-react";
import type { MetaResponse } from "@/lib/types";

export function Footer() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/meta")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setMeta(data as MetaResponse);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer className="mt-20 border-t border-white/10 bg-navy-950/70">
      <div className="container grid gap-8 py-10 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-cyan-400 to-sky-600 text-slate-950">
              <TrainFront className="h-4 w-4" aria-hidden />
            </span>
            <span className="font-bold tracking-tight">RailFlow AI</span>
          </div>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
            An independent hackathon prototype for crash-resistant railway booking: a server-authoritative
            virtual queue, transaction-safe seat allocation, idempotent payments and a live reliability
            dashboard.
          </p>
          <p className="mt-3 max-w-md rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-100/90">
            {meta?.disclaimer ??
              "Not affiliated with IRCTC or Indian Railways. Fictional train data, simulated payments."}
          </p>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Explore</h4>
          <ul className="mt-3 space-y-2 text-sm">
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/search">Search trains</Link></li>
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/bookings">Booking history</Link></li>
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/payments">Payment status</Link></li>
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/ops">Operations dashboard</Link></li>
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/lab">Simulation lab</Link></li>
            <li><Link className="text-muted-foreground hover:text-cyan-300" to="/architecture">Architecture</Link></li>
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Runtime</h4>
          <ul className="mt-3 space-y-2.5 text-sm text-muted-foreground">
            <li className="flex items-center gap-2">
              <Database className="h-4 w-4 text-cyan-300/80" aria-hidden />
              Database: <span className="font-mono text-xs text-foreground">{meta?.database_backend ?? "..."}</span>
            </li>
            <li className="flex items-center gap-2">
              <Server className="h-4 w-4 text-cyan-300/80" aria-hidden />
              Cache: <span className="font-mono text-xs text-foreground">{meta?.cache_backend ?? "..."}</span>
            </li>
            <li className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-cyan-300/80" aria-hidden />
              Hold window: <span className="font-mono text-xs text-foreground">{meta?.hold_minutes ?? 10} min</span>
            </li>
            <li className="flex items-center gap-2">
              <Server className="h-4 w-4 text-cyan-300/80" aria-hidden />
              Queue capacity: <span className="font-mono text-xs text-foreground">{meta?.queue_capacity ?? 40}</span>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 py-4">
        <p className="container text-xs text-muted-foreground">
          RailFlow AI v{meta?.app_version ?? "1.0.0"} - independent prototype. All bookings, payments and traffic
          patterns are simulated.
        </p>
      </div>
    </footer>
  );
}
