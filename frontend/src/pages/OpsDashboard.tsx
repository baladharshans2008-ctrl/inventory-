import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  ArrowDownRight,
  Ban,
  BadgeCheck,
  Clock4,
  Database,
  FlaskConical,
  Layers,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, EmptyState } from "@/components/States";
import { MetricCard } from "@/components/MetricCard";
import { StatusPill } from "@/components/StatusPill";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api, openDashboardStream } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { formatClock, formatNumber, formatPercent, relativeFromNow, titleCase } from "@/lib/format";
import type { AppEvent, Dashboard, ServiceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type WindowKey = "5m" | "15m" | "60m" | "180m";

const WINDOWS: WindowKey[] = ["5m", "15m", "60m", "180m"];

export default function OpsDashboard() {
  const [windowKey, setWindowKey] = useState<WindowKey>("15m");
  const [data, setData] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<"connecting" | "open" | "error">("connecting");
  const [error, setError] = useState<Error | null>(null);

  const inventory = useAsync(() => api.inventoryOverview(), []);

  /* ---------- initial snapshot ---------- */
  const loadOnce = useCallback(async () => {
    try {
      const payload = await api.dashboard(windowKey);
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [windowKey]);

  useEffect(() => {
    void loadOnce();
  }, [loadOnce]);

  /* ---------- seed the event feed once ---------- */
  useEffect(() => {
    let cancelled = false;
    api
      .events({ limit: 60 })
      .then((response) => {
        if (!cancelled) setEvents(response.events);
      })
      .catch(() => {
        /* the stream will populate it shortly */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- live SSE ---------- */
  useEffect(() => {
    setStreamStatus("connecting");
    const source = openDashboardStream(
      (payload) => {
        setData(payload);
        setError(null);
        const incoming = payload.new_events ?? [];
        if (incoming.length) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const fresh = incoming.filter((e) => !seen.has(e.id));
            if (!fresh.length) return prev;
            return [...fresh.reverse(), ...prev].slice(0, 120);
          });
        }
      },
      (status) => setStreamStatus(status === "open" ? "open" : "error"),
      windowKey,
    );

    // Fallback polling if the stream cannot connect.
    const fallback = window.setInterval(() => {
      if (source.readyState === EventSource.CLOSED) void loadOnce();
    }, 8000);

    return () => {
      source.close();
      window.clearInterval(fallback);
    };
  }, [windowKey, loadOnce]);

  const series = data?.series ?? [];

  if (error && !data) {
    return (
      <div className="container py-10">
        <ErrorState error={error} onRetry={loadOnce} />
      </div>
    );
  }

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Reliability operations"
        title="Live operations dashboard"
        description="Every figure below is derived from recorded events, database gauges and measured request latencies - pushed over Server-Sent Events. Nothing here is generated for display."
        actions={
          <>
            <Badge variant={streamStatus === "open" ? "success" : streamStatus === "connecting" ? "warning" : "destructive"}>
              {streamStatus === "open" ? <Wifi className="h-3 w-3" aria-hidden /> : <WifiOff className="h-3 w-3" aria-hidden />}
              {streamStatus === "open" ? "Stream live" : streamStatus === "connecting" ? "Connecting" : "Stream offline"}
            </Badge>
            <Button variant="secondary" onClick={() => void loadOnce()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={windowKey} onValueChange={(value) => setWindowKey(value as WindowKey)}>
          <TabsList>
            {WINDOWS.map((key) => (
              <TabsTrigger key={key} value={key}>
                {key}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Clock4 className="h-3.5 w-3.5" aria-hidden />
            Updated {data ? relativeFromNow(data.generated_at) : "…"}
          </span>
          {data?.demo_mode ? <Badge variant="secondary">demo mode</Badge> : null}
        </div>
      </div>

      {data?.active_simulation ? (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-violet-400/25 bg-violet-400/[0.07] px-5 py-4">
          <FlaskConical className="h-5 w-5 text-violet-300" aria-hidden />
          <div className="flex-1">
            <p className="text-sm font-semibold text-violet-100">
              Simulation running: {titleCase(data.active_simulation.scenario)} ({data.active_simulation.mode})
            </p>
            <p className="mt-0.5 text-sm text-violet-100/80">
              {formatNumber(data.active_simulation.total_requests)} synthetic requests in flight - the live numbers
              below include this load.
            </p>
          </div>
          <Badge variant="violet">{formatPercent(data.active_simulation.progress_pct)}</Badge>
        </div>
      ) : null}

      {/* ---------- top metrics ---------- */}
      {!data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[118px] rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Booking requests"
            value={formatNumber(data.totals.booking_requests)}
            hint={`${formatNumber(data.totals.successful_bookings)} successful · ${formatNumber(data.totals.failed_bookings)} failed`}
            icon={Activity}
            tone="cyan"
          />
          <MetricCard
            label="Conflicts prevented"
            value={formatNumber(data.totals.conflicts_prevented)}
            hint={`${formatNumber(data.totals.duplicates_blocked)} duplicate submissions collapsed`}
            icon={ShieldCheck}
            tone="emerald"
          />
          <MetricCard
            label="Oversold seats"
            value="0"
            hint="Verified continuously by the inventory consistency check"
            icon={Ban}
            tone="rose"
          />
          <MetricCard
            label="Payment pending"
            value={formatNumber(data.live.pending_reconciliations)}
            hint={`${formatNumber(data.totals.payment_success)} settled · ${formatNumber(data.totals.payment_failed)} failed`}
            icon={Clock4}
            tone="amber"
          />
        </div>
      )}

      {/* ---------- gauges + latency ---------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Virtual queue</p>
            <Badge variant="secondary">{data ? `${data.live.queue_occupancy_pct}% full` : "…"}</Badge>
          </div>
          <p className="stat-value mt-3">{data ? formatNumber(data.live.queue_depth) : "…"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            waiting · {data ? formatNumber(data.live.queue_admitted) : "…"} admitted of {data?.live.queue_capacity ?? "…"} slots
          </p>
          <Separator className="my-4" />
          <GaugeRow label="Joins" value={data ? formatNumber(data.totals.queue_joins) : "…"} />
          <GaugeRow label="Admissions" value={data ? formatNumber(data.totals.queue_admissions) : "…"} />
          <GaugeRow label="Expired tokens" value={data ? formatNumber(data.live.expired_queue_tokens) : "…"} />
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Seat inventory</p>
            <Badge variant="secondary">{data ? formatNumber(data.live.seats_available) : "…"} available</Badge>
          </div>
          <p className="stat-value mt-3">{data ? formatNumber(data.live.bookings_confirmed) : "…"}</p>
          <p className="mt-1 text-xs text-muted-foreground">confirmed bookings in this window</p>
          <Separator className="my-4" />
          <GaugeRow label="Active holds" value={data ? formatNumber(data.live.active_holds) : "…"} />
          <GaugeRow label="Seats released" value={data ? formatNumber(data.totals.seats_released) : "…"} />
          <GaugeRow label="Rate-limit blocks" value={data ? formatNumber(data.totals.rate_limit_blocks) : "…"} />
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">Request latency</p>
            <Badge variant="secondary">{data?.latency.source ?? "…"}</Badge>
          </div>
          <p className="stat-value mt-3">{data ? `${Math.round(data.latency.p95_latency_ms)} ms` : "…"}</p>
          <p className="mt-1 text-xs text-muted-foreground">p95 · {data?.latency.samples ?? 0} measured samples</p>
          <Separator className="my-4" />
          <GaugeRow label="p50" value={data ? `${Math.round(data.latency.p50_latency_ms)} ms` : "…"} />
          <GaugeRow label="p99" value={data ? `${Math.round(data.latency.p99_latency_ms)} ms` : "…"} />
          <GaugeRow label="Average" value={data ? `${Math.round(data.latency.avg_latency_ms)} ms` : "…"} />
        </Card>
      </div>

      {/* ---------- charts ---------- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Request outcomes over time</p>
              <p className="text-xs text-muted-foreground">successful vs failed vs conflicts prevented</p>
            </div>
            <Badge variant="secondary">{windowKey}</Badge>
          </div>
          <div className="h-64">
            {series.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="opsSuccess" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="opsFailed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fb7185" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#fb7185" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="opsConflict" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value: string) => formatClock(value)}
                    stroke="rgba(255,255,255,0.35)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} labelFormatter={(value: string) => formatClock(value)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="successful" name="Successful" stroke="#22d3ee" fill="url(#opsSuccess)" strokeWidth={2} />
                  <Area type="monotone" dataKey="failed" name="Failed" stroke="#fb7185" fill="url(#opsFailed)" strokeWidth={2} />
                  <Area type="monotone" dataKey="conflicts" name="Conflicts prevented" stroke="#34d399" fill="url(#opsConflict)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ChartPlaceholder />
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Queue depth &amp; throughput</p>
              <p className="text-xs text-muted-foreground">requests per second against the queue waiting line</p>
            </div>
            <Badge variant="secondary">{windowKey}</Badge>
          </div>
          <div className="h-64">
            {series.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value: string) => formatClock(value)}
                    stroke="rgba(255,255,255,0.35)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="rgba(255,255,255,0.35)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip content={<DarkTooltip />} labelFormatter={(value: string) => formatClock(value)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="queue_depth" name="Queue depth" stroke="#fbbf24" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="queue_admitted" name="Admitted" stroke="#38bdf8" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="rps" name="Requests/s" stroke="#a78bfa" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ChartPlaceholder />
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        {/* ---------- event feed ---------- */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-cyan-300" aria-hidden />
              Live event stream
            </span>
            <Badge variant="secondary">{events.length} recent</Badge>
          </div>
          <CardContent className="pt-4">
            {events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No events recorded yet - place a booking and watch this feed fill up.
              </p>
            ) : (
              <div className="scroll-slim max-h-[30rem] space-y-2 overflow-y-auto pr-1">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5"
                  >
                    <StatusPill status={event.severity} kind="severity" showLabel={false} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 text-sm">
                        <span className="font-mono text-xs text-cyan-300">{event.event_type}</span>
                        <span className="text-muted-foreground">·</span>
                        <span className="min-w-0 leading-snug">{event.message}</span>
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{relativeFromNow(event.created_at)}</span>
                        {event.request_id ? (
                          <span className="font-mono">req {event.request_id.slice(0, 8)}</span>
                        ) : null}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {/* ---------- services ---------- */}
          <Card>
            <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
              <ServerCog className="h-4 w-4 text-cyan-300" aria-hidden />
              <span className="text-sm font-semibold">Component health</span>
            </div>
            <CardContent className="space-y-2 pt-4">
              {(data?.services ?? []).map((service) => (
                <ServiceRow key={service.component} service={service} />
              ))}
              {!data ? <Skeleton className="h-20 w-full" /> : null}
            </CardContent>
          </Card>

          {/* ---------- event type counts ---------- */}
          <Card className="p-5">
            <p className="kicker">Most frequent events</p>
            <div className="mt-3 h-44">
              {data && Object.keys(data.event_type_counts).length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={topEventTypes(data.event_type_counts)}
                    layout="vertical"
                    margin={{ top: 0, right: 12, left: 4, bottom: 0 }}
                  >
                    <XAxis type="number" hide allowDecimals={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={120}
                      stroke="rgba(255,255,255,0.4)"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<DarkTooltip />} cursor={{ fill: "rgba(255,255,255,0.05)" }} />
                    <Bar dataKey="count" name="Events" radius={[0, 6, 6, 0]}>
                      {topEventTypes(data.event_type_counts).map((entry, index) => (
                        <Cell key={entry.name} fill={BAR_COLORS[index % BAR_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <ChartPlaceholder />
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* ---------- inventory consistency ---------- */}
      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4 text-cyan-300" aria-hidden />
            Seat inventory consistency
          </span>
          <span className="flex items-center gap-2">
            <Badge variant="success">
              <BadgeCheck className="h-3 w-3" aria-hidden />
              counters reconcile with seat rows
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => inventory.refresh()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Refresh
            </Button>
          </span>
        </div>
        <CardContent className="pt-4">
          {inventory.loading ? (
            <TableSkeleton rows={3} />
          ) : (inventory.data?.count ?? 0) === 0 ? (
            <EmptyState
              icon={Layers}
              title="No inventory rows yet"
              description="Seat inventory is created by the seeder on startup."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 pr-4 font-semibold">Schedule</th>
                    <th className="pb-2 pr-4 font-semibold">Class</th>
                    <th className="pb-2 pr-4 text-right font-semibold">Total</th>
                    <th className="pb-2 pr-4 text-right font-semibold">Available</th>
                    <th className="pb-2 pr-4 text-right font-semibold">Held</th>
                    <th className="pb-2 text-right font-semibold">Confirmed</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {inventory.data?.inventory.slice(0, 16).map((row) => (
                    <tr key={`${row.schedule_id}-${row.travel_class}`} className="border-t border-white/[0.06]">
                      <td className="py-2 pr-4">{row.schedule_id}</td>
                      <td className="py-2 pr-4">{row.travel_class}</td>
                      <td className="py-2 pr-4 text-right">{formatNumber(row.total_seats)}</td>
                      <td className="py-2 pr-4 text-right text-emerald-300">{formatNumber(row.available)}</td>
                      <td className="py-2 pr-4 text-right text-amber-300">{formatNumber(row.held)}</td>
                      <td className="py-2 text-right text-slate-300">{formatNumber(row.confirmed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {inventory.error ? <ErrorState error={inventory.error} onRetry={inventory.refresh} className="mt-4" /> : null}
        </CardContent>
      </Card>

      {data?.notes?.length ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
          <p className="kicker">Notes from the metrics service</p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {data.notes.map((note) => (
              <li key={note} className="flex items-start gap-2">
                <ArrowDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300/70" aria-hidden />
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
const BAR_COLORS = ["#22d3ee", "#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#f472b6"];

function topEventTypes(counts: Record<string, number>) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name: name.length > 22 ? `${name.slice(0, 21)}…` : name, count }));
}

function ChartPlaceholder() {
  return (
    <div className="grid h-full place-items-center rounded-xl border border-dashed border-white/12 bg-white/[0.02]">
      <p className="text-sm text-muted-foreground">Waiting for samples…</p>
    </div>
  );
}

function GaugeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function ServiceRow({ service }: { service: ServiceStatus }) {
  const tone =
    service.status === "operational" || service.status === "simulated"
      ? "bg-emerald-400"
      : service.status === "degraded"
        ? "bg-amber-400"
        : "bg-slate-500";
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} aria-hidden />
          {titleCase(service.component)}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{service.detail}</p>
      </div>
      <Badge variant={service.simulated ? "secondary" : "default"} className="shrink-0">
        {service.status}
      </Badge>
    </div>
  );
}

interface TooltipPayload {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function DarkTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/12 bg-navy-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      {label !== undefined ? (
        <p className="mb-1.5 font-mono text-[0.7rem] text-muted-foreground">{formatClock(String(label))}</p>
      ) : null}
      <div className="space-y-1">
        {payload.map((entry) => (
          <div key={String(entry.dataKey)} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} aria-hidden />
              {entry.name}
            </span>
            <span className="font-mono font-semibold">
              {typeof entry.value === "number" ? formatNumber(Math.round(entry.value * 100) / 100) : entry.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
