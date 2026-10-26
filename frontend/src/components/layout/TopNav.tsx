import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { Activity, FlaskConical, LayoutDashboard, Menu, Network, Ticket, TrainFront, Wallet, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const NAV_ITEMS = [
  { to: "/search", label: "Book Tickets", icon: Ticket },
  { to: "/bookings", label: "My Bookings", icon: TrainFront },
  { to: "/payments", label: "Payments", icon: Wallet },
  { to: "/ops", label: "Operations", icon: LayoutDashboard, admin: true },
  { to: "/lab", label: "Simulation Lab", icon: FlaskConical, admin: true },
  { to: "/architecture", label: "Architecture", icon: Network },
];

export function TopNav() {
  const [open, setOpen] = useState(false);
  const [demoMode, setDemoMode] = useState(true);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/meta")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setDemoMode(Boolean(data.demo_mode));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-navy-950/80 backdrop-blur-xl">
      <div className="container flex h-16 items-center justify-between gap-4">
        <Link to="/" className="group flex items-center gap-2.5">
          <span className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-sky-600 text-slate-950 shadow-[0_10px_28px_-14px_rgba(6,182,212,0.95)]">
            <TrainFront className="h-5 w-5" aria-hidden />
            <span className="absolute inset-0 animate-pulse-ring rounded-xl border border-cyan-400/60" />
          </span>
          <span className="leading-tight">
            <span className="block text-[0.95rem] font-extrabold tracking-tight">RailFlow AI</span>
            <span className="block text-[0.62rem] font-medium uppercase tracking-[0.16em] text-cyan-300/70">
              Crash-Resistant Booking
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-white/[0.09] text-foreground"
                    : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" aria-hidden />
              {item.label}
              {item.admin ? <span className="h-1.5 w-1.5 rounded-full bg-amber-400/80" aria-hidden /> : null}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {demoMode ? (
            <Badge variant="warning" className="hidden sm:inline-flex">
              Demo data
            </Badge>
          ) : null}
          <Badge variant="success" className="hidden md:inline-flex">
            <Activity className="h-3 w-3" aria-hidden />
            Live
          </Badge>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-lg border border-white/12 bg-white/[0.05] text-foreground lg:hidden"
            aria-label="Toggle navigation"
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </div>

      {open ? (
        <nav className="border-t border-white/10 bg-navy-950/95 px-4 pb-4 pt-2 lg:hidden">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
                  isActive ? "bg-white/[0.09] text-foreground" : "text-muted-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
