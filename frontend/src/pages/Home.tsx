import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Ban,
  Clock4,
  Database,
  FlaskConical,
  Gauge,
  Layers,
  Lock,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Ticket,
  TrainFront,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { formatNumber } from "@/lib/format";

const PILLARS = [
  {
    icon: Users,
    title: "Virtual waiting queue",
    body: "Server-authoritative admission tokens. The browser can never decide that it has been admitted, and refreshing the page re-uses the same queue slot.",
    accent: "text-cyan-300",
  },
  {
    icon: Lock,
    title: "No double bookings",
    body: "Seat claims are conditional UPDATEs inside one transaction with a verified row count. A lost race rolls back cleanly instead of overselling.",
    accent: "text-emerald-300",
  },
  {
    icon: RefreshCcw,
    title: "Idempotent retries",
    body: "Unique idempotency keys on bookings and payments collapse duplicate submissions into a single logical booking.",
    accent: "text-sky-300",
  },
  {
    icon: Clock4,
    title: "Automatic hold expiry",
    body: "Unpaid holds return to inventory after the hold window, exactly once, without ever touching a confirmed seat.",
    accent: "text-amber-300",
  },
  {
    icon: ShieldCheck,
    title: "Payment reconciliation",
    body: "A timed-out gateway response stays PENDING until the authoritative ledger is consulted. A retry is never guessed.",
    accent: "text-violet-300",
  },
  {
    icon: Activity,
    title: "Live operations view",
    body: "Every dashboard number is derived from recorded events, database gauges and measured request latencies over Server-Sent Events.",
    accent: "text-rose-300",
  },
];

const LIFECYCLE = [
  { state: "AVAILABLE", tone: "emerald" },
  { state: "HELD", tone: "amber" },
  { state: "CONFIRMED", tone: "slate" },
];

export default function Home() {
  const meta = useAsync(() => api.meta(), []);
  const queue = useAsync(() => api.queueStatus(), []);
  const routes = useAsync(() => api.routes(), []);
  const health = useAsync(() => api.health(), []);

  const queueData = queue.data?.queue;
  const topRoutes = routes.data?.routes.slice(0, 6) ?? [];

  return (
    <div>
      {/* ---------------- hero ---------------- */}
      <section className="relative overflow-hidden border-b border-white/10">
        <div className="pointer-events-none absolute inset-0 bg-grid-fade" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent" aria-hidden />
        <div className="container relative grid gap-12 py-16 lg:grid-cols-[1.15fr_1fr] lg:py-24">
          <div className="animate-fade-up">
            <Badge variant="default" className="mb-5">
              <Sparkles className="h-3 w-3" aria-hidden />
              Hackathon prototype - fictional data, simulated payments
            </Badge>
            <h1 className="text-balance text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              Railway booking that survives the
              <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-blue-400 bg-clip-text text-transparent">
                {" "}
                Tatkal surge
              </span>
            </h1>
            <p className="mt-5 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground sm:text-lg">
              RailFlow AI is an independent reliability prototype. It shows how a booking platform can stay
              correct when thousands of passengers hit the same train within seconds: a virtual waiting queue,
              transaction-safe seat allocation, idempotent payments and crash recovery - all visible in a live
              operations dashboard.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link to="/search">
                  <Ticket className="h-4 w-4" aria-hidden />
                  Search trains
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link to="/lab">
                  <FlaskConical className="h-4 w-4" aria-hidden />
                  Open simulation lab
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link to="/architecture">
                  How it works
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </Button>
            </div>

            <div className="mt-9 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              <HeroStat label="Seeded seats" value={meta.data ? formatNumber(meta.data.seeded_seats) : null} />
              <HeroStat label="Queue capacity" value={meta.data ? formatNumber(meta.data.queue_capacity) : null} />
              <HeroStat
                label="Admission rate"
                value={meta.data ? `${meta.data.queue_admission_rate}/s` : null}
              />
              <HeroStat label="Hold window" value={meta.data ? `${meta.data.hold_minutes} min` : null} />
            </div>
          </div>

          {/* live panel */}
          <div className="animate-fade-up">
            <Card className="glow-ring overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
                  </span>
                  <span className="text-sm font-semibold">Live system state</span>
                </div>
                <Badge variant="secondary" className="font-mono text-[0.65rem]">
                  {meta.data?.database_backend ?? "…"}
                </Badge>
              </div>
              <CardContent className="space-y-4 pt-5">
                <div className="grid grid-cols-2 gap-3">
                  <QueueTile
                    label="Waiting now"
                    value={queueData ? formatNumber(queueData.waiting) : null}
                    hint={queueData?.occupancy_pct !== undefined ? `${queueData.occupancy_pct}% of capacity` : undefined}
                  />
                  <QueueTile
                    label="Admitted"
                    value={queueData ? formatNumber(queueData.admitted) : null}
                    hint={`of ${queueData?.capacity ?? 40} slots`}
                  />
                </div>

                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="kicker">Seat lifecycle enforced by the database</p>
                  <div className="mt-3 flex items-center gap-2">
                    {LIFECYCLE.map((step, index) => (
                      <div key={step.state} className="flex flex-1 items-center gap-2">
                        <span
                          className={
                            step.tone === "emerald"
                              ? "h-2.5 flex-1 rounded-full bg-emerald-400/70"
                              : step.tone === "amber"
                                ? "h-2.5 flex-1 rounded-full bg-amber-400/70"
                                : "h-2.5 flex-1 rounded-full bg-slate-500/70"
                          }
                            aria-hidden
                        />
                        {index < LIFECYCLE.length - 1 ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-between font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                    <span>Available</span>
                    <span>Held</span>
                    <span>Confirmed</span>
                  </div>
                </div>

                <div className="space-y-2">
                  {health.data?.checks.slice(0, 4).map((service) => (
                    <div key={service.component} className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span
                          className={
                            service.status === "operational" || service.status === "simulated"
                              ? "h-1.5 w-1.5 rounded-full bg-emerald-400"
                              : service.status === "degraded"
                                ? "h-1.5 w-1.5 rounded-full bg-amber-400"
                                : "h-1.5 w-1.5 rounded-full bg-slate-500"
                          }
                          aria-hidden
                        />
                        {service.component}
                      </span>
                      <span className="font-mono text-xs text-foreground/80">{service.status}</span>
                    </div>
                  ))}
                  {health.loading ? <Skeleton className="h-4 w-full" /> : null}
                </div>
              </CardContent>
            </Card>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <MiniStat icon={Database} label="Authoritative" value="PostgreSQL" />
              <MiniStat icon={Layers} label="Cache / limiter" value="Redis" />
              <MiniStat icon={Zap} label="Queue state" value="Server-side" />
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- pillars ---------------- */}
      <section className="container py-14 lg:py-20">
        <p className="kicker">Engineering, not decoration</p>
        <h2 className="mt-2 max-w-3xl text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          Six reliability mechanisms you can watch working
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Each mechanism is implemented in the backend service layer and exercised by the automated correctness
          suite. The simulation lab runs the very same code paths so results are measured, never staged.
        </p>

        <div className="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((pillar) => (
            <Card key={pillar.title} className="group h-full p-5 transition-colors hover:border-cyan-400/25">
              <span className={`grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[0.05] ${pillar.accent}`}>
                <pillar.icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold">{pillar.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{pillar.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------------- live metrics strip ---------------- */}
      <section className="container pb-14 lg:pb-20">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Queue waiting"
            value={queueData ? formatNumber(queueData.waiting) : "…"}
            hint="Live from the database, not a fixture"
            icon={Users}
            tone="cyan"
          />
          <MetricCard
            label="Seats in inventory"
            value={meta.data ? formatNumber(meta.data.seeded_seats) : "…"}
            hint="Fictional seat rows across the seeded timetable"
            icon={Layers}
            tone="blue"
          />
          <MetricCard
            label="Correctness tests"
            value="7"
            hint="Overselling, races, duplicates, timeouts, expiry, consistency, recovery"
            icon={BadgeCheck}
            tone="emerald"
          />
          <MetricCard
            label="Overselling tolerance"
            value="0"
            hint="Verified by Tests A, B and F against real concurrent load"
            icon={Ban}
            tone="rose"
          />
        </div>
      </section>

      {/* ---------------- popular routes ---------------- */}
      <section className="container pb-16 lg:pb-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="kicker">Fictional network</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Popular routes in the demo timetable</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Ten invented routes across eleven stations, seeded for three days of departures.
            </p>
          </div>
          <Button asChild variant="secondary">
            <Link to="/search">
              <Gauge className="h-4 w-4" aria-hidden />
              Open search
            </Link>
          </Button>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {routes.loading
            ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[76px] rounded-2xl" />)
            : topRoutes.map((route) => (
                <Link
                  key={`${route.from.code}-${route.to.code}`}
                  to={`/search?from=${route.from.code}&to=${route.to.code}`}
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 transition-all hover:border-cyan-400/30 hover:bg-white/[0.06]"
                >
                  <div>
                    <p className="flex items-center gap-2 font-semibold">
                      <span className="font-mono text-cyan-300">{route.from.code}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                      <span className="font-mono text-cyan-300">{route.to.code}</span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {route.from.name ?? route.from.code} → {route.to.name ?? route.to.code}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1 font-mono text-xs text-muted-foreground">
                    {route.schedules} trains
                  </span>
                </Link>
              ))}
        </div>
        {routes.error ? (
          <p className="mt-4 text-sm text-rose-300">
            Could not load routes - {routes.error.message}
          </p>
        ) : null}
      </section>

      {/* ---------------- cta ---------------- */}
      <section className="container pb-20">
        <div className="relative overflow-hidden rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.10] via-navy-900 to-navy-950 p-8 sm:p-12">
          <div className="pointer-events-none absolute inset-0 bg-grid-fade" aria-hidden />
          <div className="relative flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <Badge variant="default" className="mb-4">
                <FlaskConical className="h-3 w-3" aria-hidden />
                Reproducible in one click
              </Badge>
              <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                Break it on purpose, then watch the guards hold
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
                The simulation lab runs seven scenarios - including a Tatkal-style surge, 100 requests racing for
                one seat, a total payment gateway outage and duplicate retries - in both protected and baseline
                modes, and prints the measured verdict.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/lab">
                  <FlaskConical className="h-4 w-4" aria-hidden />
                  Run a simulation
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link to="/bookings">
                  <TrainFront className="h-4 w-4" aria-hidden />
                  My bookings
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3">
      <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{value ?? <Skeleton className="h-5 w-16" />}</p>
    </div>
  );
}

function QueueTile({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
      <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">{value ?? <Skeleton className="h-7 w-14" />}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-center">
      <Icon className="mx-auto h-4 w-4 text-cyan-300/80" />
      <p className="mt-1.5 text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs font-semibold">{value}</p>
    </div>
  );
}
