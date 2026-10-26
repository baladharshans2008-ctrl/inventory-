import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BadgeCheck,
  Clock,
  Hourglass,
  Loader2,
  RefreshCw,
  ServerCog,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, InfoBanner } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { MetricCard } from "@/components/MetricCard";
import { Skeleton } from "@/components/ui/skeleton";
import { api, getAdminKey } from "@/lib/api";
import { usePolling } from "@/lib/hooks";
import { countdownLabel, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/store";
import { isComplete, submitReservation } from "@/lib/booking";

export default function VirtualQueue() {
  const navigate = useNavigate();
  const { session, update, ensureQueueRequestKey, ensureIdempotencyKey } = useSession();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<Error | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const claimAttempted = useRef(false);
  const [demoBusy, setDemoBusy] = useState(false);

  const draft = session.draft;
  const ready = isComplete(draft) && !!draft.scheduleId;

  const depth = usePolling(() => api.queueStatus(), 2500, true);

  const entry = usePolling(
    () => (session.queueToken ? api.queueEntry(session.queueToken) : Promise.resolve(null)),
    2000,
    Boolean(session.queueToken),
  );

  const queue = entry.data?.queue ?? null;

  async function joinQueue() {
    if (!draft.scheduleId) return;
    setJoining(true);
    setJoinError(null);
    try {
      const requestKey = ensureQueueRequestKey();
      const response = await api.joinQueue({
        schedule_id: draft.scheduleId,
        travel_class: draft.travelClass,
        passenger_count: draft.passengers.length,
        request_key: requestKey,
      });
      update({ queueToken: response.queue.token });
    } catch (err) {
      setJoinError(err as Error);
    } finally {
      setJoining(false);
    }
  }

  async function claimSeats(auto = false) {
    if (claiming || !draft.scheduleId) return;
    setClaiming(true);
    if (!auto) setClaimMessage(null);
    const key = ensureIdempotencyKey();
    const result = await submitReservation(draft, key, session.queueToken);
    setClaiming(false);

    if (result.ok) {
      update({ reservation: result.reservation, payment: null });
      navigate(`/bookings/${result.reservation.reservation_id}`);
      return;
    }
    if (result.reason === "queue_required") {
      setClaimMessage("The service is still at capacity. Stay in the queue - you will be admitted shortly.");
      return;
    }
    if (result.reason === "seat_unavailable") {
      setClaimMessage("Those seats were taken while you waited. Return to the results and choose another class.");
      return;
    }
    setClaimMessage(result.error.message);
  }

  // Admitted -> claim the seats automatically, exactly once.
  useEffect(() => {
    const admitted = queue?.status === "READY" || queue?.status === "PROCESSING";
    if (admitted && ready && !claimAttempted.current) {
      claimAttempted.current = true;
      void claimSeats(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue?.status, ready]);

  const adminKey = getAdminKey();

  async function demoAction(action: "surge" | "promote" | "clear") {
    setDemoBusy(true);
    try {
      if (action === "surge" && draft.scheduleId) {
        await api.injectSurge({ count: 150, schedule_id: draft.scheduleId, travel_class: draft.travelClass });
      } else if (action === "promote") {
        await api.promoteQueue(20);
      } else if (action === "clear") {
        await api.clearQueueDemo();
      }
    } catch (err) {
      setJoinError(err as Error);
    } finally {
      setDemoBusy(false);
    }
  }

  function leaveQueue() {
    update({ queueToken: null });
    claimAttempted.current = false;
    setClaimMessage(null);
  }

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Traffic control"
        title="Virtual waiting queue"
        description="Under a Tatkal-style surge the booking service admits a bounded number of requests at a time. Your position is computed by the server; refreshing this page will not move you forward or create a second slot."
        actions={
          <Badge variant="secondary">
            <RefreshCw className="h-3 w-3" aria-hidden />
            Positions auto-refresh every 2s
          </Badge>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Waiting now"
          value={depth.data ? formatNumber(depth.data.queue.waiting) : "…"}
          hint={`Capacity ${depth.data?.queue.capacity ?? 40} concurrent admissions`}
          icon={Users}
          tone="cyan"
        />
        <MetricCard
          label="Admitted"
          value={depth.data ? formatNumber(depth.data.queue.admitted) : "…"}
          hint={`${depth.data?.queue.occupancy_pct ?? 0}% of capacity in use`}
          icon={BadgeCheck}
          tone="emerald"
        />
        <MetricCard
          label="Admission rate"
          value={depth.data ? `${depth.data.queue.admission_rate_per_second}/s` : "…"}
          hint="Processed by the background queue worker"
          icon={Zap}
          tone="blue"
        />
        <MetricCard
          label="Service state"
          value={depth.data?.saturated ? "Saturated" : "Open"}
          hint={depth.data?.saturated ? "New bookings require queue admission" : "Bookings are admitted immediately"}
          icon={ServerCog}
          tone={depth.data?.saturated ? "amber" : "emerald"}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Hourglass className="h-4 w-4 text-cyan-300" aria-hidden />
              <span className="text-sm font-semibold">Your queue position</span>
            </div>
            {queue ? <StatusPill status={queue.status} kind="queue" /> : <Badge variant="secondary">Not in queue</Badge>}
          </div>

          <CardContent className="space-y-5 pt-6">
            {joinError ? <ErrorState error={joinError} /> : null}

            {!ready ? (
              <EmptyState
                icon={Users}
                title="No booking draft to queue for"
                description="Choose a train, class and passenger details first. The queue needs to know what you intend to book so it can reserve capacity for that exactly request."
                action={
                  <Button asChild className="mt-2">
                    <Link to="/search">Search trains</Link>
                  </Button>
                }
              />
            ) : !session.queueToken ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-sm font-semibold">Ready to join</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    You will be queued for{" "}
                    <span className="font-mono text-foreground">{draft.passengers.length}</span> seat(s) in{" "}
                    <span className="font-mono text-foreground">{draft.travelClass}</span> on schedule{" "}
                    <span className="font-mono text-foreground">{draft.scheduleId}</span>.
                  </p>
                  <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                    <li>• The request key is stable, so retrying or refreshing never creates a second slot.</li>
                    <li>• An admission token is single-use and bound to this exact booking request.</li>
                    <li>• Being admitted does not reserve a seat - the allocation transaction still has to win.</li>
                  </ul>
                </div>
                <Button size="lg" onClick={joinQueue} disabled={joining}>
                  {joining ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
                  {joining ? "Joining queue..." : "Join the virtual queue"}
                </Button>
              </div>
            ) : !entry.lastUpdated && !queue && !entry.error ? (
              <div className="space-y-3">
                <Skeleton className="h-8 w-40" />
                <Skeleton className="h-2 w-full" />
                <Skeleton className="h-20 w-full rounded-xl" />
              </div>
            ) : queue ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Token
                    </p>
                    <p className="mt-1 font-mono text-lg font-semibold text-cyan-200">{queue.token}</p>
                  </div>
                  {queue.status === "WAITING" ? (
                    <div className="text-right">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Requests ahead
                      </p>
                      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                        {formatNumber(queue.requests_ahead)}
                      </p>
                    </div>
                  ) : null}
                </div>

                <Progress
                  value={
                    queue.status === "WAITING"
                      ? Math.max(4, 100 - Math.min(100, queue.position * 2))
                      : queue.status === "READY" || queue.status === "PROCESSING" || queue.status === "CONSUMED"
                        ? 100
                        : 0
                  }
                  indicatorClassName={queue.status === "WAITING" ? "from-amber-400 to-orange-500" : undefined}
                />

                <div className="grid gap-3 sm:grid-cols-3">
                  <Tile
                    label="Position"
                    value={queue.status === "WAITING" ? `#${queue.position}` : "-"}
                    hint={queue.status === "WAITING" ? "computed server-side" : "not waiting"}
                  />
                  <Tile
                    label="Estimated wait"
                    value={queue.status === "WAITING" ? `~${queue.estimated_wait_seconds}s` : "0s"}
                    hint="approximate, based on admission rate"
                  />
                  <Tile
                    label="Token expiry"
                    value={
                      queue.expires_at ? (
                        <span className="font-mono text-base">{countdownLabel(secondsUntil(queue.expires_at))}</span>
                      ) : (
                        "-"
                      )
                    }
                    hint="tokens expire if unused"
                  />
                </div>

                <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                  {queue.note}
                </div>

                {claimMessage ? (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100">
                    {claimMessage}
                  </div>
                ) : null}

                {queue.status === "READY" || queue.status === "PROCESSING" ? (
                  <Button size="lg" onClick={() => claimSeats(false)} disabled={claiming}>
                    {claiming ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
                    {claiming ? "Holding your seats..." : "Claim my seats now"}
                  </Button>
                ) : null}

                {queue.status === "EXPIRED" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-sm text-rose-200">
                      This token expired before you were admitted. Rejoin with the same request key to renew it.
                    </p>
                    <Button variant="secondary" onClick={joinQueue} disabled={joining}>
                      Renew token
                    </Button>
                  </div>
                ) : null}

                <Separator />
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="ghost" size="sm" onClick={leaveQueue}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Leave the queue view
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Leaving this view does not cancel your server-side slot; the token stays valid until it expires.
                  </span>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <InfoBanner title="Why a queue at all?" tone="cyan">
            <p>
              A bounded admission rate protects the database from thundering herds. The queue never decides who
              owns a seat: it only decides who is allowed to <em>try</em>. Correctness still comes from the
              allocation transaction.
            </p>
          </InfoBanner>

          <Card>
            <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3">
              <Zap className="h-4 w-4 text-amber-300" aria-hidden />
              <span className="text-sm font-semibold">Demo controls</span>
              <Badge variant="secondary" className="ml-auto text-[0.65rem]">
                admin
              </Badge>
            </div>
            <CardContent className="space-y-3 pt-5">
              {!adminKey ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  These controls need the admin key.{" "}
                  <Link to="/ops" className="font-medium text-cyan-300 hover:underline">
                    Unlock operations
                  </Link>{" "}
                  to inject a synthetic surge and watch the queue drain in real time.
                </p>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Inject synthetic waiting traffic, then admit it at the configured rate. All of it runs through
                    the real queue processor and event log.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={demoBusy} onClick={() => demoAction("surge")}>
                      Inject 150 requests
                    </Button>
                    <Button size="sm" variant="secondary" disabled={demoBusy} onClick={() => demoAction("promote")}>
                      Admit 20 now
                    </Button>
                    <Button size="sm" variant="ghost" disabled={demoBusy} onClick={() => demoAction("clear")}>
                      Clear synthetic queue
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="p-5">
            <p className="kicker">Request key</p>
            <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground">
              {session.queueRequestKey ?? "generated when you first join"}
            </p>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              The key is stored in this browser and reused on every retry, which is what makes queue joining
              idempotent.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="flex items-center gap-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden />
        {label}
      </p>
      <p className="mt-1.5 font-mono text-xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-0.5 text-[0.65rem] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function secondsUntil(iso: string): number {
  const normalised = /[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const target = new Date(normalised).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 1000));
}
