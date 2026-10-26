import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Clock,
  CreditCard,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Timer,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, InfoBanner } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { formatDateTime, formatInr, relativeFromNow } from "@/lib/format";
import type { Payment } from "@/lib/types";
import { cn } from "@/lib/utils";

const UNRESOLVED = ["INITIATED", "PENDING", "RECONCILING"];

export default function PaymentStatus() {
  const { paymentId } = useParams();
  return paymentId ? <PaymentDetail id={paymentId} /> : <PaymentList />;
}

/* ================================================================== */
/* List of transactions on this browser                                */
/* ================================================================== */
function PaymentList() {
  const list = useAsync(() => api.listPayments({ limit: 30 }), []);

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Payments"
        title="Transaction status"
        description="Every payment is a simulated transaction with its own state machine. Unresolved transactions stay PENDING until the authoritative ledger is consulted - a client timeout is never treated as a failure."
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/bookings">
                <Users className="h-4 w-4" aria-hidden />
                My bookings
              </Link>
            </Button>
            <Button asChild>
              <Link to="/search">
                <CreditCard className="h-4 w-4" aria-hidden />
                New booking
              </Link>
            </Button>
          </>
        }
      />

      {list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}

      {list.loading ? (
        <Card className="p-6">
          <TableSkeleton rows={4} />
        </Card>
      ) : null}

      {!list.loading && !list.error && (list.data?.count ?? 0) === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No payment attempts yet"
          description="Once you hold seats and choose a payment outcome, every attempt - successful, failed or pending - is listed here."
          action={
            <Button asChild className="mt-2">
              <Link to="/search">Search trains</Link>
            </Button>
          }
        />
      ) : null}

      <div className="space-y-3">
        {list.data?.payments.map((payment) => (
          <Link
            key={payment.payment_id}
            to={`/payments/${payment.payment_id}`}
            className="block rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all hover:border-cyan-400/30 hover:bg-white/[0.06]"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
                  <CreditCard className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="font-mono font-semibold leading-tight">{payment.reference}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    PNR {payment.pnr ?? "-"} · scenario {payment.scenario} · attempt {payment.attempts}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(payment.created_at)}
                    {payment.reconciled ? " · reconciled" : ""}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <StatusPill status={payment.status} kind="payment" />
                <span className="font-mono text-sm font-semibold">{formatInr(payment.amount)}</span>
                <span className="text-xs text-muted-foreground">{relativeFromNow(payment.updated_at)}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */
/* Detail - live state machine view                                    */
/* ================================================================== */
function PaymentDetail({ id }: { id: string }) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.getPayment(id);
      setPayment(response.payment);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while the transaction is unresolved.
  const unresolved = payment ? UNRESOLVED.includes(payment.status) : false;
  useEffect(() => {
    if (!unresolved) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [unresolved, load]);

  async function reconcile(force: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await api.reconcilePayment(id, force);
      setPayment(response.payment);
      setNotice(response.summary);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="container py-10">
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Card className="p-6">
            <TableSkeleton rows={4} />
          </Card>
        </div>
      </div>
    );
  }

  if (error && !payment) {
    return (
      <div className="container py-10">
        <ErrorState error={error} onRetry={load} />
        <Button asChild variant="secondary" className="mt-4">
          <Link to="/payments">Back to payments</Link>
        </Button>
      </div>
    );
  }

  if (!payment) return null;

  const isSuccess = payment.status === "SUCCESS";
  const isFailed = payment.status === "FAILED";
  const isPending = unresolved;

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Transaction"
        title={payment.reference}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>PNR {payment.pnr ?? "-"}</span>
            <span className="font-mono text-xs">scenario: {payment.scenario}</span>
            <span>{payment.simulated ? "Simulated gateway" : "Gateway"}</span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
            <Button asChild variant="ghost">
              <Link to={`/bookings/${payment.reservation_id}`}>
                View booking
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </>
        }
      />

      {/* status banner */}
      <div
        className={cn(
          "mb-6 flex flex-wrap items-center gap-4 rounded-2xl border px-5 py-4",
          isSuccess
            ? "border-emerald-400/25 bg-emerald-400/[0.07]"
            : isFailed
              ? "border-rose-400/25 bg-rose-400/[0.07]"
              : "border-amber-400/25 bg-amber-400/[0.07]",
        )}
      >
        {isSuccess ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-300" aria-hidden />
        ) : isFailed ? (
          <TriangleAlert className="h-5 w-5 text-rose-300" aria-hidden />
        ) : (
          <Timer className="h-5 w-5 text-amber-300" aria-hidden />
        )}
        <div className="flex-1">
          <p className="text-sm font-semibold">
            {isSuccess
              ? "Payment settled and booking confirmed"
              : isFailed
                ? "Payment declined - seats were released"
                : "Outcome still being resolved server-side"}
          </p>
          <p className="mt-0.5 text-sm opacity-80">
            {payment.message}
            {isPending && payment.resolve_at
              ? ` Authoritative resolution expected ${relativeFromNow(payment.resolve_at)}.`
              : ""}
          </p>
        </div>
        <StatusPill status={payment.status} kind="payment" />
      </div>

      {notice ? <InfoBanner title="Reconciliation" tone="cyan">{<p>{notice}</p>}</InfoBanner> : null}
      {notice ? <div className="h-4" /> : null}

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          {/* state machine */}
          <Card>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-cyan-300" aria-hidden />
                Payment state machine
              </span>
              <Badge variant="secondary" className="font-mono text-[0.65rem]">
                INITIATED → PENDING → SUCCESS / FAILED
              </Badge>
            </div>
            <CardContent className="pt-5">
              <ol className="space-y-1">
                {payment.timeline.map((step, index) => {
                  const isLast = index === payment.timeline.length - 1;
                  return (
                    <li key={`${step.state}-${index}`} className="flex gap-4">
                      <div className="flex flex-col items-center">
                        <span
                          className={cn(
                            "grid h-8 w-8 shrink-0 place-items-center rounded-full border",
                            step.done
                              ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
                              : "border-white/12 bg-white/[0.04] text-muted-foreground",
                          )}
                        >
                          {step.done ? (
                            <CheckCircle2 className="h-4 w-4" aria-hidden />
                          ) : (
                            <CircleDashed className="h-4 w-4" aria-hidden />
                          )}
                        </span>
                        {!isLast ? (
                          <span
                            className={cn("my-1 w-px flex-1", step.done ? "bg-cyan-400/30" : "bg-white/10")}
                            aria-hidden
                          />
                        ) : null}
                      </div>
                      <div className={cn("pb-5", isLast && "pb-0")}>
                        <p className={cn("font-mono text-sm font-semibold", step.done ? "text-foreground" : "text-muted-foreground")}>
                          {step.state}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {step.done ? formatDateTime(step.at) : "not reached"}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>

              {isPending ? (
                <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-cyan-300" aria-hidden />
                  <div className="flex-1">
                    <p className="text-sm font-medium">Waiting on the ledger</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {payment.next_action}
                      {payment.do_not_retry
                        ? " Do not resubmit this payment - a duplicate request returns this same transaction."
                        : ""}
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-3">
                <Button disabled={busy} onClick={() => reconcile(true)}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  Reconcile now
                </Button>
                {isPending ? (
                  <Button variant="secondary" disabled={busy} onClick={() => reconcile(false)}>
                    Poll the ledger
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* transaction detail */}
          <Card>
            <div className="border-b border-white/10 px-5 py-3.5">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Transaction
              </span>
            </div>
            <CardContent className="space-y-1 pt-5">
              <DetailRow label="Reference" value={<span className="font-mono">{payment.reference}</span>} />
              <DetailRow label="Status" value={<StatusPill status={payment.status} kind="payment" />} />
              <DetailRow label="Amount" value={<span className="font-mono">{formatInr(payment.amount)}</span>} />
              <DetailRow label="Gateway ref" value={<span className="font-mono text-xs">{payment.gateway_ref ?? "-"}</span>} />
              <DetailRow label="Attempts" value={payment.attempts} />
              <DetailRow label="Reconciled" value={payment.reconciled ? "yes" : "no"} />
              <Separator />
              <DetailRow label="Created" value={formatDateTime(payment.created_at)} />
              <DetailRow label="Updated" value={formatDateTime(payment.updated_at)} />
              <DetailRow label="Resolved" value={formatDateTime(payment.resolved_at)} />
              <DetailRow label="Server latency" value={<span className="font-mono">{payment.latency_ms} ms</span>} />
              <Separator />
              <DetailRow
                label="Idempotency key"
                value={
                  <span className="max-w-[12rem] truncate font-mono text-xs" title={payment.idempotency_key}>
                    {payment.idempotency_key}
                  </span>
                }
              />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {payment.failure_reason ? (
            <InfoBanner title="Failure reason" tone="rose">
              <p>{payment.failure_reason}</p>
            </InfoBanner>
          ) : null}

          {payment.reconciliation_notes ? (
            <InfoBanner title="Reconciliation notes" tone="amber">
              <p>{payment.reconciliation_notes}</p>
            </InfoBanner>
          ) : null}

          <Card className="p-5">
            <p className="kicker">Reliability guarantee</p>
            <ul className="mt-3 space-y-2.5 text-sm text-muted-foreground">
              <Guarantee text="A browser timeout never marks a payment as failed." />
              <Guarantee text="Duplicate requests collapse onto one transaction via a unique idempotency key." />
              <Guarantee text="Booking confirmation follows the server's authoritative outcome, never the UI." />
              <Guarantee text="Unresolved transactions are reconciled by a background worker." />
            </ul>
          </Card>

          <Card className="p-5">
            <p className="kicker">Related</p>
            <div className="mt-3 space-y-2">
              <Link
                to={`/bookings/${payment.reservation_id}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm transition-colors hover:border-cyan-400/30"
              >
                <span className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-cyan-300" aria-hidden />
                  Reservation &amp; passengers
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
              </Link>
              <Link
                to="/payments"
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm transition-colors hover:border-cyan-400/30"
              >
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-cyan-300" aria-hidden />
                  All transactions
                </span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium">{value}</span>
    </div>
  );
}

function Guarantee({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300/80" aria-hidden />
      <span className="leading-relaxed">{text}</span>
    </li>
  );
}
