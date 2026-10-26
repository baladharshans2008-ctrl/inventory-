import { Link } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  Clock4,
  Database,
  Fingerprint,
  FlaskConical,
  Gauge,
  GitBranch,
  Layers,
  Lock,
  RefreshCcw,
  Server,
  ShieldCheck,
  Sparkles,
  Ticket,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader, SectionHeading } from "@/components/PageHeader";
import { ErrorState } from "@/components/States";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { formatNumber } from "@/lib/format";

const STACK = [
  { layer: "Frontend", value: "React 18 + Vite + TypeScript + Tailwind + shadcn/ui", detail: "Recharts for live charts, React Router for the ten-page flow, Lucide icons." },
  { layer: "Backend", value: "Python 3.11 + FastAPI + SQLAlchemy 2.0", detail: "REST API plus Server-Sent Events for the operations dashboard." },
  { layer: "Authoritative store", value: "PostgreSQL (SQLite locally)", detail: "Transactional inventory with row-level locking and conditional updates." },
  { layer: "Cache & limiter", value: "Redis (in-process fallback)", detail: "Queue snapshots, rate limiting and short-lived caches." },
];

const MECHANISMS = [
  {
    icon: Users,
    title: "Server-authoritative virtual queue",
    problem: "Client-side queues let a refresh or a double click skip the line.",
    solution:
      "Every entry is a database row with a token, a server-computed position and an expiry. Re-submitting the same request key returns the same entry instead of creating a second one.",
    verify: "POST /api/queue/join twice with one key returns a single entry.",
  },
  {
    icon: Lock,
    title: "Transactional seat allocation",
    problem: "A read-then-write check lets two requests claim the same seat.",
    solution:
      "Seats move AVAILABLE → HELD → CONFIRMED through a conditional UPDATE inside one transaction. The affected row count is verified, so a lost race rolls back instead of overselling.",
    verify: "Tests A and B race 100 requests against 10 seats and 1 seat.",
  },
  {
    icon: Fingerprint,
    title: "Idempotent bookings and payments",
    problem: "Retries after a timeout create duplicate bookings or double charges.",
    solution:
      "A UNIQUE idempotency key on reservations and payment transactions collapses repeated submissions into the original record.",
    verify: "Test C and Test G submit the same key repeatedly.",
  },
  {
    icon: RefreshCcw,
    title: "Payment reconciliation, never guessing",
    problem: "A browser timeout is not the same as a failed payment.",
    solution:
      "The real outcome is stored server-side and hidden from the API until the ledger is consulted. Unresolved transactions stay PENDING and are settled by a reconciliation worker.",
    verify: "Test D forces an unknown gateway result and reconciles it.",
  },
  {
    icon: Clock4,
    title: "Hold expiry, exactly once",
    problem: "Abandoned carts must return seats without touching confirmed bookings.",
    solution:
      "A background expiry worker releases only rows still in the HELD state, guarded by a status condition so a confirmed seat can never be released.",
    verify: "Test E expires a hold with a two-second window.",
  },
  {
    icon: BadgeCheck,
    title: "Continuous inventory consistency",
    problem: "Denormalised counters can silently drift from the physical seat rows.",
    solution:
      "Counters are recomputed and asserted against the seat rows, both on demand and after every simulation run.",
    verify: "Test F and the operations dashboard's consistency panel.",
  },
];

const FLOW = [
  { step: "1", title: "Search", body: "GET /api/trains returns schedules with per-class availability computed from seat rows." },
  { step: "2", title: "Queue", body: "POST /api/queue/join issues a server-side admission token when demand saturates capacity." },
  { step: "3", title: "Hold seats", body: "POST /api/reservations claims seats transactionally and sets a hold window." },
  { step: "4", title: "Pay", body: "POST /api/payments/simulate drives the payment state machine for the hold." },
  { step: "5", title: "Reconcile", body: "A worker or an explicit call resolves PENDING transactions against the ledger." },
  { step: "6", title: "Confirm or release", body: "Success confirms the seats; failure or expiry returns them to inventory exactly once." },
];

export default function Architecture() {
  const meta = useAsync(() => api.meta(), []);
  const health = useAsync(() => api.health(), []);

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="System architecture"
        title="How RailFlow AI stays correct under load"
        description="A reliability-first booking platform: a server-authoritative queue, transaction-safe seat allocation, idempotent payments and crash recovery - each implemented in the backend service layer and exercised by an automated suite."
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/ops">
                <Gauge className="h-4 w-4" aria-hidden />
                Operations dashboard
              </Link>
            </Button>
            <Button asChild>
              <Link to="/lab">
                <FlaskConical className="h-4 w-4" aria-hidden />
                Simulation lab
              </Link>
            </Button>
          </>
        }
      />

      {/* ---------------- disclaimer ---------------- */}
      <div className="mb-8 flex flex-wrap items-start gap-4 rounded-2xl border border-cyan-400/25 bg-cyan-400/[0.07] px-5 py-4">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-cyan-100">Independent prototype - fictional data, simulated payments</p>
          <p className="mt-1 text-sm leading-relaxed text-cyan-100/80">
            {meta.data?.disclaimer ??
              "This project is an engineering demonstration. It uses invented trains and stations, never performs real bookings and is not affiliated with any railway operator."}
          </p>
        </div>
      </div>

      {/* ---------------- live system ---------------- */}
      <SectionHeading
        icon={Server}
        title="Live runtime"
        description="Read from the running backend, not from this page's markup."
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <RuntimeTile label="Database" value={meta.data?.database_backend} hint="Authoritative inventory and reservations" icon={Database} />
        <RuntimeTile label="Cache / limiter" value={meta.data?.cache_backend} hint="Queue snapshots and rate limiting" icon={Zap} />
        <RuntimeTile label="Queue capacity" value={meta.data ? `${formatNumber(meta.data.queue_capacity)} slots` : undefined} hint="Admission replaces capacity based on the live workload" icon={Users} />
        <RuntimeTile label="Hold window" value={meta.data ? `${meta.data.hold_minutes} min` : undefined} hint="Unpaid seats return to inventory after this" icon={Clock4} />
      </div>

      <Card className="mt-4 p-5">
        <p className="kicker">Component health</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {health.loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)
          ) : health.error ? (
            <div className="sm:col-span-2">
              <ErrorState error={health.error} onRetry={health.refresh} />
            </div>
          ) : (
            health.data?.checks.map((service) => <HealthRow key={service.component} label={service.component} status={service.status} detail={service.detail} />)
          )}
        </div>
      </Card>

      {/* ---------------- stack ---------------- */}
      <div className="mt-12">
        <SectionHeading icon={Boxes} title="Technology stack" description="Chosen for correctness first, then speed." />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {STACK.map((item) => (
            <Card key={item.layer} className="p-5">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{item.layer}</Badge>
              </div>
              <p className="mt-3 text-sm font-semibold">{item.value}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.detail}</p>
            </Card>
          ))}
        </div>
      </div>

      {/* ---------------- booking flow ---------------- */}
      <div className="mt-12">
        <SectionHeading
          icon={Workflow}
          title="Booking lifecycle"
          description="Six steps, every one of them guarded server-side."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {FLOW.map((item) => (
            <Card key={item.step} className="relative overflow-hidden p-5">
              <span className="absolute right-4 top-3 font-mono text-3xl font-bold text-white/[0.06]">{item.step}</span>
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] font-mono text-sm font-semibold text-cyan-300">
                {item.step}
              </span>
              <p className="mt-3 text-sm font-semibold">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </Card>
          ))}
        </div>
      </div>

      {/* ---------------- mechanisms ---------------- */}
      <div className="mt-12">
        <SectionHeading
          icon={ShieldCheck}
          title="Reliability mechanisms"
          description="Each one is a code path, not a policy document."
        />
        <div className="mt-4 space-y-3">
          {MECHANISMS.map((item) => (
            <Card key={item.title} className="p-5">
              <div className="flex flex-col gap-4 sm:flex-row">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
                  <item.icon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold">{item.title}</h3>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-rose-400/15 bg-rose-400/[0.05] px-3.5 py-2.5">
                      <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-rose-200/80">
                        The failure it prevents
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.problem}</p>
                    </div>
                    <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.05] px-3.5 py-2.5">
                      <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-emerald-200/80">
                        How it holds
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.solution}</p>
                    </div>
                  </div>
                  <p className="mt-3 flex items-start gap-2 text-xs text-cyan-200/80">
                    <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {item.verify}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* ---------------- state machines ---------------- */}
      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="kicker">Seat state machine</p>
          <div className="mt-4 flex items-center gap-3 font-mono text-sm">
            <StateChip tone="emerald">AVAILABLE</StateChip>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <StateChip tone="amber">HELD</StateChip>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <StateChip tone="slate">CONFIRMED</StateChip>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            HELD returns to AVAILABLE on expiry or payment failure. CONFIRMED is terminal - the release guard only ever
            matches rows still in the HELD state, so a confirmed seat can never be freed by a stale worker.
          </p>
        </Card>

        <Card className="p-5">
          <p className="kicker">Payment state machine</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-sm">
            <StateChip tone="sky">INITIATED</StateChip>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <StateChip tone="amber">PENDING</StateChip>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <StateChip tone="violet">RECONCILING</StateChip>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <StateChip tone="emerald">SUCCESS</StateChip>
            <span className="text-muted-foreground">/</span>
            <StateChip tone="rose">FAILED</StateChip>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The authoritative outcome is written server-side the moment the gateway responds, but the API keeps
            reporting PENDING until reconciliation. A slow or missing browser response changes nothing about the
            booking.
          </p>
        </Card>
      </div>

      {/* ---------------- concurrency notes ---------------- */}
      <div className="mt-12">
        <SectionHeading
          icon={GitBranch}
          title="Concurrency and crash safety"
          description="What happens when two requests arrive at the same microsecond."
        />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Card className="p-5">
            <Layers className="h-5 w-5 text-cyan-300" aria-hidden />
            <p className="mt-3 text-sm font-semibold">Locked check-and-allocate</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Availability is never read and then trusted. The claim itself carries the condition and its effect is
              measured by the affected row count.
            </p>
          </Card>
          <Card className="p-5">
            <RefreshCcw className="h-5 w-5 text-cyan-300" aria-hidden />
            <p className="mt-3 text-sm font-semibold">Optimistic version guard</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Contended rows carry a version counter so a stale write is rejected rather than silently overwriting a
              newer one.
            </p>
          </Card>
          <Card className="p-5">
            <Zap className="h-5 w-5 text-cyan-300" aria-hidden />
            <p className="mt-3 text-sm font-semibold">Recoverable by design</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              An interrupted request leaves either a clean rollback or a held reservation, both of which are safe:
              holds expire and release themselves.
            </p>
          </Card>
        </div>
      </div>

      {/* ---------------- tests ---------------- */}
      <div className="mt-12">
        <SectionHeading
          icon={BadgeCheck}
          title="Automated verification"
          description="Seven correctness tests plus an automated pytest suite covering the same guarantees."
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TestTile id="A" name="Overselling prevention" />
          <TestTile id="B" name="Single-seat race" />
          <TestTile id="C" name="Duplicate booking prevention" />
          <TestTile id="D" name="Payment timeout reconciliation" />
          <TestTile id="E" name="Reservation expiry" />
          <TestTile id="F" name="Inventory consistency" />
          <TestTile id="G" name="Failure recovery" />
          <Card className="flex flex-col justify-center p-5">
            <p className="text-sm font-semibold">Run them yourself</p>
            <Button asChild variant="secondary" size="sm" className="mt-3 self-start">
              <Link to="/lab">
                Open the lab
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </Button>
          </Card>
        </div>
      </div>

      {/* ---------------- cta ---------------- */}
      <div className="mt-12 flex flex-col items-start gap-5 rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.10] via-navy-900 to-navy-950 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <Badge variant="default" className="mb-3">
            <Sparkles className="h-3 w-3" aria-hidden />
            Ready to demonstrate
          </Badge>
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Book a seat, then try to break it
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Search a fictional route, hold seats, run each payment outcome and watch the operations dashboard react -
            all from the running backend.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link to="/search">
              <Ticket className="h-4 w-4" aria-hidden />
              Start booking
            </Link>
          </Button>
          <Button asChild size="lg" variant="secondary">
            <Link to="/ops">
              <Gauge className="h-4 w-4" aria-hidden />
              See the metrics
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuntimeTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value?: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
          <p className="mt-1.5 truncate text-lg font-semibold">{value ?? <Skeleton className="h-6 w-24" />}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </div>
    </Card>
  );
}

function HealthRow({ label, status, detail }: { label: string; status: string; detail: string }) {
  const ok = status === "operational" || status === "simulated";
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className={ok ? "h-1.5 w-1.5 rounded-full bg-emerald-400" : "h-1.5 w-1.5 rounded-full bg-amber-400"} aria-hidden />
          {label}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
      <Badge variant={ok ? "success" : "secondary"} className="shrink-0">
        {status}
      </Badge>
    </div>
  );
}

function StateChip({ tone, children }: { tone: "emerald" | "amber" | "slate" | "sky" | "violet" | "rose"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    emerald: "border-emerald-400/30 bg-emerald-400/12 text-emerald-200",
    amber: "border-amber-400/30 bg-amber-400/12 text-amber-200",
    slate: "border-white/15 bg-white/[0.06] text-slate-200",
    sky: "border-sky-400/30 bg-sky-400/12 text-sky-200",
    violet: "border-violet-400/30 bg-violet-400/12 text-violet-200",
    rose: "border-rose-400/30 bg-rose-400/12 text-rose-200",
  };
  return <span className={`rounded-lg border px-2.5 py-1 ${tones[tone]}`}>{children}</span>;
}

function TestTile({ id, name }: { id: string; name: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/12 bg-white/[0.05] font-mono text-xs font-semibold text-cyan-300">
        {id}
      </span>
      <span className="text-sm font-medium leading-snug">{name}</span>
    </Card>
  );
}
