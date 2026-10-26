import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  BadgeCheck,
  Ban,
  CheckCircle2,
  Clock4,
  FlaskConical,
  Gauge,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TriangleAlert,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, InfoBanner } from "@/components/States";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { formatNumber, relativeFromNow, titleCase } from "@/lib/format";
import type {
  CorrectnessSuite,
  PresetsResponse,
  SimulationEventRecord,
  SimulationRun,
  SimulationSummary,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const CONFIG_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "concurrent_requests", label: "Concurrent requests", hint: "Burst size hitting the booking endpoint" },
  { key: "available_seats", label: "Available seats", hint: "Disposable inventory provisioned for the run" },
  { key: "seats_per_request", label: "Seats per request", hint: "Passengers on each synthetic booking" },
  { key: "arrival_rate_per_second", label: "Arrival rate / s", hint: "How fast the burst is released" },
  { key: "payment_failure_pct", label: "Payment failure %", hint: "Share of simulated declines" },
  { key: "payment_delay_ms", label: "Payment delay (ms)", hint: "Gateway latency per attempt" },
  { key: "network_timeout_pct", label: "Network timeout %", hint: "Client abandons before the response lands" },
  { key: "hold_seconds", label: "Hold seconds", hint: "Seat hold lifetime before expiry" },
  { key: "duplicate_retry_pct", label: "Duplicate retry %", hint: "Requests retried with the same idempotency key" },
];

export default function SimulationLab() {
  const presets = useAsync(() => api.presets(), []);
  const correctness = useAsync(() => api.correctnessInfo(), []);

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Hackathon simulation lab"
        title="Break it on purpose"
        description="Every scenario executes the real backend code - the same seat allocation and payment functions the booking API uses - against a disposable inventory. Results are measured from what actually happened, never pre-baked."
        actions={
          <Badge variant="default">
            <Sparkles className="h-3 w-3" aria-hidden />
            Admin protected
          </Badge>
        }
      />

      <Tabs defaultValue="scenarios">
        <TabsList>
          <TabsTrigger value="scenarios">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            Stress scenarios
          </TabsTrigger>
          <TabsTrigger value="correctness">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            Correctness suite A-G
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scenarios">
          <ScenarioRunner presets={presets.data} loading={presets.loading} error={presets.error} onRetry={presets.refresh} />
        </TabsContent>

        <TabsContent value="correctness">
          <CorrectnessPanel
            info={correctness.data}
            loading={correctness.loading}
            error={correctness.error}
            onRetry={correctness.refresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ================================================================== */
/* Scenario runner                                                     */
/* ================================================================== */
function ScenarioRunner({
  presets,
  loading,
  error,
  onRetry,
}: {
  presets: PresetsResponse | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const [scenarioId, setScenarioId] = useState<string>("");
  const [mode, setMode] = useState<"protected" | "baseline">("protected");
  const [config, setConfig] = useState<Record<string, number>>({});
  const [run, setRun] = useState<SimulationRun | null>(null);
  const [results, setResults] = useState<SimulationSummary | null>(null);
  const [events, setEvents] = useState<SimulationEventRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<Error | null>(null);
  const [comparison, setComparison] = useState<Record<string, SimulationSummary>>({});
  const lastSeqRef = useRef(0);

  const selected = useMemo(
    () => presets?.presets.find((preset) => preset.id === scenarioId) ?? null,
    [presets, scenarioId],
  );

  /* default scenario when presets arrive */
  useEffect(() => {
    if (presets && !scenarioId && presets.presets.length) {
      setScenarioId(presets.presets[0].id);
    }
  }, [presets, scenarioId]);

  /* reset the editable config whenever the scenario changes */
  useEffect(() => {
    if (!selected) return;
    const next: Record<string, number> = {};
    for (const field of CONFIG_FIELDS) {
      const value = (selected.config as unknown as Record<string, number>)[field.key];
      if (typeof value === "number") next[field.key] = value;
    }
    setConfig(next);
    setResults(null);
    setRun(null);
    setEvents([]);
    lastSeqRef.current = 0;
    setRunError(null);
  }, [selected]);

  const running = run?.status === "RUNNING";

  /* ---------- progress polling ---------- */
  const pollRun = useCallback(async (runId: string) => {
    try {
      const response = await api.getRun(runId);
      setRun(response.run);
      if (response.run.status !== "RUNNING") {
        const final = await api.runResults(runId);
        if (final.results_ready && final.results) {
          setResults(final.results);
          setComparison((prev) => ({ ...prev, [`${final.results!.scenario}|${final.results!.mode}`]: final.results! }));
        }
      }
    } catch (err) {
      setRunError(err as Error);
    }
  }, []);

  useEffect(() => {
    if (!running || !run) return;
    const timer = window.setInterval(() => void pollRun(run.run_id), 900);
    return () => window.clearInterval(timer);
  }, [running, run, pollRun]);

  /* ---------- live event tail ---------- */
  useEffect(() => {
    if (!running || !run) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await api.runEvents(run.run_id, lastSeqRef.current, 200);
        if (response.events.length) {
          lastSeqRef.current = response.last_seq;
          setEvents((prev) => [...prev, ...response.events].slice(-120));
        }
      } catch {
        /* transient - retry on the next tick */
      }
    }, 1100);
    return () => window.clearInterval(timer);
  }, [running, run]);

  async function start() {
    if (!selected) return;
    setBusy(true);
    setRunError(null);
    setResults(null);
    setEvents([]);
    lastSeqRef.current = 0;
    try {
      const response = await api.runSimulation({ scenario: selected.id, mode, ...config });
      const started: SimulationRun = {
        run_id: response.run_id,
        scenario: selected.id,
        scenario_label: selected.label,
        mode,
        status: "RUNNING",
        progress: 0,
        total_requests: config.concurrent_requests ?? 0,
        config: response.config,
        summary: {},
        schedule_id: null,
        seed: config.seed ?? 0,
        error: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      };
      setRun(started);
      await pollRun(response.run_id);
    } catch (err) {
      setRunError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
        <Card className="p-6">
          <TableSkeleton rows={6} />
        </Card>
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    );
  }

  if (error || !presets) {
    return <ErrorState error={error ?? new Error("Could not load scenarios")} onRetry={onRetry} />;
  }

  const bounds = presets.bounds;
  const protectedResult = selected ? comparison[`${selected.id}|protected`] : undefined;
  const baselineResult = selected ? comparison[`${selected.id}|baseline`] : undefined;
  const progressPct = run ? Math.min(100, Math.round((run.progress / Math.max(1, run.total_requests)) * 100)) : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.45fr]">
      {/* ---------------- configuration ---------------- */}
      <div className="space-y-4">
        <Card className="p-5">
          <p className="kicker">1 · Choose a scenario</p>
          <div className="mt-3 space-y-2">
            {presets.presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setScenarioId(preset.id)}
                className={cn(
                  "w-full rounded-xl border px-4 py-3 text-left transition-all",
                  preset.id === scenarioId
                    ? "border-cyan-400/40 bg-cyan-400/[0.09]"
                    : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]",
                )}
              >
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {preset.id === scenarioId ? (
                    <CheckCircle2 className="h-4 w-4 text-cyan-300" aria-hidden />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-white/25" aria-hidden />
                  )}
                  {preset.label}
                </p>
                <p className="mt-1 pl-6 text-xs leading-relaxed text-muted-foreground">{preset.description}</p>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <p className="kicker">2 · Protection mode</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {presets.modes.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setMode(option.id as "protected" | "baseline")}
                className={cn(
                  "rounded-xl border px-4 py-3 text-left transition-all",
                  option.id === mode
                    ? option.id === "protected"
                      ? "border-emerald-400/40 bg-emerald-400/[0.09]"
                      : "border-rose-400/40 bg-rose-400/[0.09]"
                    : "border-white/10 bg-white/[0.03] hover:border-white/20",
                )}
              >
                <p className="text-sm font-semibold">{option.label}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{option.description}</p>
              </button>
            ))}
          </div>
          {mode === "baseline" ? (
            <p className="mt-3 text-xs leading-relaxed text-rose-200/80">
              Baseline mode deliberately disables locking and idempotent dedupe, in a single documented function, to
              show what would break without the shipped mechanisms.
            </p>
          ) : null}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between">
            <p className="kicker">3 · Load parameters</p>
            <Button variant="ghost" size="sm" onClick={() => selected && setConfig(presetConfig(selected.config))}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Reset
            </Button>
          </div>
          <div className="mt-3 space-y-3">
            {CONFIG_FIELDS.map((field) => {
              const bound = bounds[field.key];
              return (
                <div key={field.key}>
                  <label className="flex items-center justify-between text-xs font-medium">
                    <span>{field.label}</span>
                    {bound ? (
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        {bound.min}–{bound.max}
                      </span>
                    ) : null}
                  </label>
                  <Input
                    type="number"
                    className="mt-1.5 font-mono"
                    min={bound?.min}
                    max={bound?.max}
                    value={config[field.key] ?? 0}
                    onChange={(event) =>
                      setConfig((prev) => ({ ...prev, [field.key]: Number(event.target.value) || 0 }))
                    }
                  />
                  <p className="mt-1 text-[0.68rem] text-muted-foreground">{field.hint}</p>
                </div>
              );
            })}
          </div>

          <Button className="mt-5 w-full" size="lg" disabled={busy || running} onClick={start}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Running…
              </>
            ) : (
              <>
                <Play className="h-4 w-4" aria-hidden />
                Run {mode === "protected" ? "protected" : "baseline"} simulation
              </>
            )}
          </Button>
          {runError ? <ErrorState error={runError} className="mt-3" /> : null}
        </Card>
      </div>

      {/* ---------------- results ---------------- */}
      <div className="space-y-4">
        {/* progress */}
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-xl border",
                  mode === "protected"
                    ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
                    : "border-rose-400/25 bg-rose-400/[0.08] text-rose-300",
                )}
              >
                <Activity className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold">{selected?.label ?? "Select a scenario"}</p>
                <p className="text-xs text-muted-foreground">
                  {run ? `${titleCase(run.mode)} mode · run ${run.run_id.slice(0, 8)}` : "No run started yet"}
                </p>
              </div>
            </div>
            <Badge
              variant={
                !run ? "secondary" : run.status === "RUNNING" ? "warning" : run.status === "COMPLETED" ? "success" : "destructive"
              }
            >
              {run?.status ?? "IDLE"}
            </Badge>
          </div>
          <Progress value={progressPct} className="mt-4" />
          <div className="mt-2 flex justify-between font-mono text-xs text-muted-foreground">
            <span>
              {run ? formatNumber(run.progress) : 0} / {run ? formatNumber(run.total_requests) : 0} requests
            </span>
            <span>{progressPct}%</span>
          </div>
        </Card>

        {/* verdict */}
        {results ? (
          <Card
            className={cn(
              "overflow-hidden border",
              results.oversold_by === 0 && results.duplicate_bookings_created === 0
                ? "border-emerald-400/25"
                : "border-rose-400/25",
            )}
          >
            <div
              className={cn(
                "flex flex-wrap items-center gap-3 border-b px-5 py-4",
                results.oversold_by === 0 && results.duplicate_bookings_created === 0
                  ? "border-emerald-400/20 bg-emerald-400/[0.07]"
                  : "border-rose-400/20 bg-rose-400/[0.07]",
              )}
            >
              {results.oversold_by === 0 && results.duplicate_bookings_created === 0 ? (
                <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden />
              ) : (
                <TriangleAlert className="h-5 w-5 text-rose-300" aria-hidden />
              )}
              <div className="flex-1">
                <p className="text-sm font-semibold">
                  {results.oversold_by === 0 && results.duplicate_bookings_created === 0
                    ? "Verdict: every guard held"
                    : "Verdict: protections breached"}
                </p>
                <p className="mt-0.5 text-xs opacity-80">
                  {formatNumber(results.total_requests)} requests · {formatNumber(results.successful_bookings)} bookings ·
                  expected max {formatNumber(results.expected_max_bookings)} · oversold by {formatNumber(results.oversold_by)}
                </p>
              </div>
            </div>
            <CardContent className="space-y-1 pt-4">
              {results.verdict_checks.map((check) => (
                <div key={check.name} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                  {check.passed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden />
                  )}
                  <div>
                    <p className="text-sm font-medium">{check.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{check.detail}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {/* measured metrics */}
        {results ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Successful bookings" value={formatNumber(results.successful_bookings)} hint={`${formatNumber(results.held_bookings)} still held`} tone="cyan" />
            <Stat label="Conflicts prevented" value={formatNumber(results.conflicts_prevented)} hint="Lost races rolled back cleanly" tone="emerald" />
            <Stat label="Duplicates handled" value={formatNumber(results.duplicates_handled_safely)} hint={`${formatNumber(results.duplicate_bookings_created)} duplicate bookings created`} tone="sky" />
            <Stat label="Oversold by" value={formatNumber(results.oversold_by)} hint={`${formatNumber(results.confirmed_seat_rows)} confirmed seat rows`} tone={results.oversold_by === 0 ? "emerald" : "rose"} />
            <Stat label="Seats consumed" value={formatNumber(results.seats_consumed)} hint={`${formatNumber(results.seats_before)} → ${formatNumber(results.seats_after)} available`} tone="amber" />
            <Stat label="Throughput" value={`${results.throughput_rps}/s`} hint={`${results.duration_seconds}s wall clock`} tone="violet" />
            <Stat label="Payment success" value={formatNumber(results.payments.success)} hint={`${formatNumber(results.payment_failures)} failed · ${formatNumber(results.payment_recoveries)} recovered`} tone="cyan" />
            <Stat label="Latency p95" value={`${Math.round(results.latency.p95)} ms`} hint={`avg ${Math.round(results.latency.avg)} ms · ${formatNumber(results.latency.samples)} samples`} tone="slate" />
          </div>
        ) : null}

        {/* comparison */}
        {protectedResult || baselineResult ? (
          <Card className="p-5">
            <p className="kicker">Protected vs baseline</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="pb-2 pr-4 font-semibold">Measurement</th>
                    <th className="pb-2 pr-4 text-right font-semibold">Protected</th>
                    <th className="pb-2 text-right font-semibold">Baseline</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  <CompareRow label="Oversold by" a={protectedResult?.oversold_by} b={baselineResult?.oversold_by} invert />
                  <CompareRow label="Duplicate bookings" a={protectedResult?.duplicate_bookings_created} b={baselineResult?.duplicate_bookings_created} invert />
                  <CompareRow label="Successful bookings" a={protectedResult?.successful_bookings} b={baselineResult?.successful_bookings} />
                  <CompareRow label="Conflicts prevented" a={protectedResult?.conflicts_prevented} b={baselineResult?.conflicts_prevented} />
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Run the same scenario in both modes to fill this table. Baseline numbers come from the deliberately unsafe
              code path and show the failure the protected path prevents.
            </p>
          </Card>
        ) : null}

        {/* live events */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-cyan-300" aria-hidden />
              Run event log
            </span>
            <Badge variant="secondary">{events.length} shown</Badge>
          </div>
          <CardContent className="pt-4">
            {events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Events appear here while the run executes.
              </p>
            ) : (
              <div className="scroll-slim max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {events.map((event) => (
                  <div key={event.seq} className="flex items-start gap-3 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 font-mono text-xs">
                    <span className="w-10 shrink-0 text-muted-foreground">#{event.seq}</span>
                    <span className="w-44 shrink-0 truncate text-cyan-300">{event.event_type}</span>
                    <span className="min-w-0 flex-1 font-sans leading-snug text-foreground/85">{event.message}</span>
                    {event.latency_ms !== null ? (
                      <span className="shrink-0 text-muted-foreground">{Math.round(event.latency_ms)}ms</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {results?.consistency ? (
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <p className="kicker">Inventory consistency (Test F)</p>
              <Badge variant={results.consistency.ok ? "success" : "destructive"}>
                {results.consistency.ok ? "consistent" : "inconsistent"}
              </Badge>
            </div>
            <div className="mt-3 space-y-2">
              {results.consistency.checks.map((check) => (
                <div key={check.name} className="flex items-start gap-3 text-sm">
                  {check.passed ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden />
                  )}
                  <div>
                    <p className="font-medium">{check.name}</p>
                    <p className="text-xs text-muted-foreground">{check.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}

        {results?.notes?.length ? (
          <InfoBanner title="Run notes" tone="cyan">
            <ul className="space-y-1">
              {results.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </InfoBanner>
        ) : null}

        {!results && !running ? (
          <Card className="p-5">
            <EmptyState
              icon={FlaskConical}
              title="No run yet"
              description="Pick a scenario, choose a mode and press run. The lab provisions its own seat inventory, fires the burst and computes the verdict from the events it produced."
            />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function presetConfig(config: { [key: string]: unknown }): Record<string, number> {
  const next: Record<string, number> = {};
  for (const field of CONFIG_FIELDS) {
    const value = config[field.key];
    if (typeof value === "number") next[field.key] = value;
  }
  return next;
}

function Stat({
  label,
  value,
  hint,
  tone = "cyan",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "cyan" | "emerald" | "amber" | "rose" | "sky" | "violet" | "slate";
}) {
  const tones: Record<string, string> = {
    cyan: "border-cyan-400/25 bg-cyan-400/[0.06]",
    emerald: "border-emerald-400/25 bg-emerald-400/[0.06]",
    amber: "border-amber-400/25 bg-amber-400/[0.06]",
    rose: "border-rose-400/25 bg-rose-400/[0.06]",
    sky: "border-sky-400/25 bg-sky-400/[0.06]",
    violet: "border-violet-400/25 bg-violet-400/[0.06]",
    slate: "border-white/12 bg-white/[0.03]",
  };
  return (
    <div className={cn("rounded-2xl border p-4", tones[tone])}>
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function CompareRow({
  label,
  a,
  b,
  invert = false,
}: {
  label: string;
  a?: number;
  b?: number;
  invert?: boolean;
}) {
  const format = (value?: number) => (value === undefined ? "—" : formatNumber(value));
  const better =
    a === undefined || b === undefined
      ? null
      : invert
        ? a < b
          ? "a"
          : a > b
            ? "b"
            : "tie"
        : a > b
          ? "a"
          : a < b
            ? "b"
            : "tie";
  return (
    <tr className="border-t border-white/[0.06]">
      <td className="py-2 pr-4 font-sans text-muted-foreground">{label}</td>
      <td className={cn("py-2 pr-4 text-right", better === "a" && "font-semibold text-emerald-300")}>{format(a)}</td>
      <td className={cn("py-2 text-right", better === "b" && "font-semibold text-emerald-300")}>{format(b)}</td>
    </tr>
  );
}

/* ================================================================== */
/* Correctness suite                                                   */
/* ================================================================== */
function CorrectnessPanel({
  info,
  loading,
  error,
  onRetry,
}: {
  info: { suite: string; tests: { id: string; name: string; detail: string }[]; run_with: string } | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  const [suite, setSuite] = useState<CorrectnessSuite | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<Error | null>(null);

  async function run(tests?: string) {
    setRunning(true);
    setRunError(null);
    try {
      const response = await api.runCorrectness(tests);
      setSuite(response);
    } catch (err) {
      setRunError(err as Error);
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-6">
        <TableSkeleton rows={7} />
      </Card>
    );
  }
  if (error || !info) {
    return <ErrorState error={error ?? new Error("Could not load the suite")} onRetry={onRetry} />;
  }

  const allPassed = suite ? suite.failed === 0 : false;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.35fr]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-cyan-300" aria-hidden />
            <p className="text-sm font-semibold">{info.suite}</p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Seven deterministic checks executed against the live database. Each one asserts a specific reliability
            guarantee and reports the measured values - not an expected answer.
          </p>
          <div className="mt-4 space-y-2">
            {info.tests.map((test) => {
              const result = suite?.results.find((entry) => entry.id === test.id);
              return (
                <div
                  key={test.id}
                  className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-white/12 bg-white/[0.05] font-mono text-xs font-semibold text-cyan-300">
                    {test.id}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{test.name}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{test.detail}</p>
                  </div>
                  {result ? (
                    result.passed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden />
                    )
                  ) : null}
                </div>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <Button disabled={running} onClick={() => run()}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
              Run all seven tests
            </Button>
            <Button variant="secondary" disabled={running} onClick={() => run("A,B")}>
              <Gauge className="h-4 w-4" aria-hidden />
              Race tests only
            </Button>
          </div>
          {runError ? <ErrorState error={runError} className="mt-3" /> : null}
        </Card>

        <InfoBanner title="Reproduce from the terminal" tone="cyan">
          <p className="font-mono text-xs">pytest backend/tests -v</p>
          <p className="mt-1.5">
            The same guarantees are covered by the automated pytest suite, so a green CI run and a green lab run mean
            the same thing.
          </p>
        </InfoBanner>
      </div>

      <div className="space-y-4">
        {suite ? (
          <>
            <Card
              className={cn(
                "flex flex-wrap items-center gap-4 border p-5",
                allPassed ? "border-emerald-400/25 bg-emerald-400/[0.06]" : "border-rose-400/25 bg-rose-400/[0.06]",
              )}
            >
              {allPassed ? (
                <BadgeCheck className="h-8 w-8 text-emerald-300" aria-hidden />
              ) : (
                <TriangleAlert className="h-8 w-8 text-rose-300" aria-hidden />
              )}
              <div className="flex-1">
                <p className="text-base font-semibold">
                  {allPassed ? "All checks passed" : `${suite.failed} check(s) failed`}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {suite.passed} of {suite.total} passed · {suite.duration_seconds}s · finished {relativeFromNow(suite.finished_at)}
                </p>
              </div>
              <div className="flex gap-2">
                <Badge variant="success">{suite.passed} passed</Badge>
                {suite.failed ? <Badge variant="destructive">{suite.failed} failed</Badge> : null}
              </div>
            </Card>

            <div className="space-y-3">
              {suite.results.map((result) => (
                <Card key={result.id} className="overflow-hidden">
                  <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
                    <span className="flex items-center gap-3">
                      <span className="grid h-7 w-7 place-items-center rounded-lg border border-white/12 bg-white/[0.05] font-mono text-xs font-semibold text-cyan-300">
                        {result.id}
                      </span>
                      <span className="text-sm font-semibold">{result.name}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="font-mono text-xs text-muted-foreground">{result.duration_ms} ms</span>
                      {result.passed ? (
                        <Badge variant="success">
                          <CheckCircle2 className="h-3 w-3" aria-hidden />
                          passed
                        </Badge>
                      ) : (
                        <Badge variant="destructive">
                          <XCircle className="h-3 w-3" aria-hidden />
                          failed
                        </Badge>
                      )}
                    </span>
                  </div>
                  <CardContent className="space-y-2 pt-4 text-sm">
                    <p className="text-muted-foreground">{result.goal}</p>
                    <Separator />
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          Expected
                        </p>
                        <p className="mt-1 font-mono text-xs leading-relaxed">{result.expected}</p>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          Actual
                        </p>
                        <p className="mt-1 font-mono text-xs leading-relaxed">{result.actual}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        ) : (
          <Card className="p-5">
            <EmptyState
              icon={BadgeCheck}
              title="Suite not run yet"
              description="Run all seven tests to assert overselling prevention, single-seat races, duplicate bookings, payment timeouts, expiry release, inventory consistency and failure recovery."
              action={
                <Button className="mt-2" disabled={running} onClick={() => run()}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                  Run suite
                </Button>
              }
            />
          </Card>
        )}

        <Card className="p-5">
          <p className="kicker">Also try</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild variant="secondary" size="sm">
              <Link to="/ops">
                <Activity className="h-3.5 w-3.5" aria-hidden />
                Live operations dashboard
              </Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/architecture">
                <Layers className="h-3.5 w-3.5" aria-hidden />
                How the guards work
              </Link>
            </Button>
          </div>
          <Separator className="my-4" />
          <ul className="space-y-2 text-xs text-muted-foreground">
            <li className="flex items-start gap-2">
              <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300/80" aria-hidden />
              Overselling and duplicate bookings must always report zero in protected mode.
            </li>
            <li className="flex items-start gap-2">
              <Clock4 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" aria-hidden />
              Expiry tests use a two-second hold so the release worker is observable.
            </li>
            <li className="flex items-start gap-2">
              <TrendingDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300/80" aria-hidden />
              Baseline mode exists only to show the difference; it is never used by the booking API.
            </li>
            <li className="flex items-start gap-2">
              <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300/80" aria-hidden />
              All data is fictional and payments are simulated - this prototype is not affiliated with any railway operator.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
