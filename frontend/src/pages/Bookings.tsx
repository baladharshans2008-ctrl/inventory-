import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  Ban,
  CalendarDays,
  CheckCircle2,
  Copy,
  CreditCard,
  History,
  Hourglass,
  Loader2,
  RefreshCw,
  Search,
  Ticket,
  Timer,
  TrainFront,
  TriangleAlert,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, InfoBanner } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { CountdownTimer } from "@/components/CountdownTimer";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync, useCopy } from "@/lib/hooks";
import { classLabel, formatDate, formatDateTime, formatInr } from "@/lib/format";
import type { Reservation } from "@/lib/types";
import { useSession } from "@/lib/store";

export default function Bookings() {
  const { reservationId } = useParams();
  return reservationId ? <ReservationDetail id={reservationId} /> : <BookingHistory />;
}

/* ================================================================== */
/* History                                                             */
/* ================================================================== */
function BookingHistory() {
  const [params, setParams] = useSearchParams();
  const [pnrInput, setPnrInput] = useState(params.get("pnr") ?? "");
  const [pnr, setPnr] = useState(params.get("pnr") ?? "");

  const list = useAsync(() => api.listReservations({ pnr: pnr || undefined, limit: 30 }), [pnr]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = pnrInput.trim().toUpperCase();
    setPnr(value);
    setParams(value ? { pnr: value } : {});
  }

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Booking history"
        title="Your bookings on this browser"
        description="Every reservation is looked up from the authoritative database. Search by the PNR generated when your seats were held."
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/payments">
                <Wallet className="h-4 w-4" aria-hidden />
                Payment status
              </Link>
            </Button>
            <Button asChild>
              <Link to="/search">
                <Ticket className="h-4 w-4" aria-hidden />
                New booking
              </Link>
            </Button>
          </>
        }
      />

      <Card className="p-5">
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={pnrInput}
              onChange={(e) => setPnrInput(e.target.value)}
              placeholder="Search by PNR, e.g. RF12345678"
              className="pl-9 uppercase"
            />
          </div>
          <Button type="submit">Search</Button>
          {pnr ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setPnr("");
                setPnrInput("");
                setParams({});
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      </Card>

      <div className="mt-6">
        {list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}

        {list.loading ? (
          <Card className="p-6">
            <TableSkeleton rows={4} />
          </Card>
        ) : null}

        {!list.loading && !list.error && (list.data?.count ?? 0) === 0 ? (
          <EmptyState
            icon={History}
            title={pnr ? `No booking found for ${pnr}` : "No bookings yet"}
            description="Hold seats on a train and your reservation will appear here with its status, seats and fare."
            action={
              <Button asChild className="mt-2">
                <Link to="/search">Search trains</Link>
              </Button>
            }
          />
        ) : null}

        <div className="space-y-3">
          {list.data?.reservations.map((reservation) => (
            <Link
              key={reservation.reservation_id}
              to={`/bookings/${reservation.reservation_id}`}
              className="block rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-all hover:border-cyan-400/30 hover:bg-white/[0.06]"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
                    <TrainFront className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="font-semibold leading-tight">{reservation.schedule.train.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {reservation.schedule.train.number} · PNR {reservation.pnr}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                        {formatDate(reservation.schedule.travel_date)}
                      </span>
                      <span className="font-mono">
                        {reservation.schedule.from.code} → {reservation.schedule.to.code}
                      </span>
                      <span className="font-mono">{reservation.travel_class}</span>
                      <span className="flex items-center gap-1.5">
                        <Users className="h-3.5 w-3.5" aria-hidden />
                        {reservation.passenger_count}
                      </span>
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusPill status={reservation.status} kind="reservation" />
                  <span className="font-mono text-sm font-semibold">{formatInr(reservation.total_fare)}</span>
                  {reservation.status === "HELD" && reservation.hold_expires_at ? (
                    <CountdownTimer expiresAt={reservation.hold_expires_at} compact />
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Detail / confirmation                                               */
/* ================================================================== */
function ReservationDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { session, update } = useSession();
  const { copied, copy } = useCopy();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);

  const detail = useAsync(() => api.getReservation(id), [id]);
  const reservation: Reservation | null = detail.data?.reservation ?? null;

  useEffect(() => {
    if (detail.data?.reservation) update({ reservation: detail.data.reservation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const payments = useAsync(() => api.listPayments({ reservationId: id, limit: 10 }), [id, reservation?.status]);

  async function startPayment(scenario: string) {
    if (!reservation) return;
    setBusy(scenario);
    setActionError(null);
    try {
      const key = `pay_${reservation.reservation_id}_${scenario}_${Math.random().toString(36).slice(2, 8)}`;
      const response = await api.simulatePayment({
        reservation_id: reservation.reservation_id,
        idempotency_key: key,
        scenario,
        delay_ms: scenario === "delayed_success" ? 2500 : scenario === "timeout" ? 1500 : 200,
      });
      update({ payment: response.payment });
      navigate(`/payments/${response.payment.payment_id}`);
    } catch (err) {
      setActionError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!reservation) return;
    setBusy("cancel");
    setActionError(null);
    try {
      await api.cancelReservation(reservation.reservation_id);
      await detail.refresh();
    } catch (err) {
      setActionError(err as Error);
    } finally {
      setBusy(null);
    }
  }

  if (detail.error) {
    return (
      <div className="container py-10">
        <ErrorState error={detail.error} onRetry={detail.refresh} />
        <Button asChild variant="secondary" className="mt-4">
          <Link to="/bookings">Back to bookings</Link>
        </Button>
      </div>
    );
  }

  if (detail.loading || !reservation) {
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

  const isHeld = reservation.status === "HELD";
  const isConfirmed = reservation.status === "CONFIRMED";

  return (
    <div className="container pb-16">
      <PageHeader
        kicker={isConfirmed ? "Booking confirmed" : isHeld ? "Seats held - payment pending" : "Booking closed"}
        title={`PNR ${reservation.pnr}`}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{reservation.schedule.train.name}</span>
            <span className="font-mono text-xs">
              {reservation.schedule.from.code} → {reservation.schedule.to.code}
            </span>
            <span>{formatDate(reservation.schedule.travel_date)}</span>
            <span className="font-mono text-xs">{reservation.travel_class}</span>
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => copy(reservation.pnr)}>
              {copied ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              {copied ? "Copied" : "Copy PNR"}
            </Button>
            <Button variant="ghost" onClick={() => detail.refresh()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh
            </Button>
          </>
        }
      />

      {isHeld ? (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] px-5 py-4">
          <Hourglass className="h-5 w-5 text-amber-300" aria-hidden />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-100">
              Your seats are held but not confirmed yet
            </p>
            <p className="mt-0.5 text-sm text-amber-100/80">
              Complete the simulated payment before the hold expires. When the timer hits zero the expiry worker
              returns these seats to inventory automatically - exactly once.
            </p>
          </div>
          <CountdownTimer expiresAt={reservation.hold_expires_at} onExpire={() => detail.refresh()} />
        </div>
      ) : null}

      {isConfirmed ? (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.07] px-5 py-4">
          <CheckCircle2 className="h-5 w-5 text-emerald-300" aria-hidden />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-100">Booking confirmed</p>
            <p className="mt-0.5 text-sm text-emerald-100/80">
              Payment reconciled successfully at {formatDateTime(reservation.confirmed_at)}. Your seats are now
              permanently allocated to this reservation.
            </p>
          </div>
        </div>
      ) : null}

      {!isHeld && !isConfirmed ? (
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-4">
          <Ban className="h-5 w-5 text-slate-300" aria-hidden />
          <div>
            <p className="text-sm font-semibold">This booking is no longer active</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Status {reservation.status}
              {reservation.release_reason ? ` (${reservation.release_reason})` : ""} at{" "}
              {formatDateTime(reservation.released_at)}. The seats were returned to inventory.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-6">
          <Card>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-cyan-300" aria-hidden />
                Passengers &amp; seats
              </span>
              <Badge variant="secondary">{reservation.passenger_count} travellers</Badge>
            </div>
            <CardContent className="pt-5">
              <div className="space-y-2.5">
                {reservation.passengers.map((passenger, index) => (
                  <div
                    key={`${passenger.name}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.07] font-mono text-xs">
                        {index + 1}
                      </span>
                      <div>
                        <p className="text-sm font-medium">{passenger.name || "Unnamed passenger"}</p>
                        <p className="text-xs text-muted-foreground">
                          {passenger.age} yrs · {passenger.gender} · {passenger.berth_preference}
                        </p>
                      </div>
                    </div>
                    <Badge variant={passenger.seat_number ? "default" : "secondary"} className="font-mono">
                      {passenger.seat_number ?? "unassigned"}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Wallet className="h-4 w-4 text-cyan-300" aria-hidden />
                Payment attempts
              </span>
              <Badge variant="secondary">Simulated gateway</Badge>
            </div>
            <CardContent className="pt-5">
              {payments.loading ? (
                <TableSkeleton rows={2} />
              ) : (payments.data?.count ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No payment attempt yet for this reservation.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {payments.data?.payments.map((payment) => (
                    <Link
                      key={payment.payment_id}
                      to={`/payments/${payment.payment_id}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 transition-colors hover:border-cyan-400/30"
                    >
                      <div>
                        <p className="font-mono text-sm">{payment.reference}</p>
                        <p className="text-xs text-muted-foreground">
                          {payment.scenario} · attempt {payment.attempts} · {formatDateTime(payment.created_at)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusPill status={payment.status} kind="payment" />
                        <span className="font-mono text-sm">{formatInr(payment.amount)}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="border-b border-white/10 px-5 py-3.5">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Reservation
              </span>
            </div>
            <CardContent className="space-y-2 pt-5 text-sm">
              <DetailRow label="Status" value={<StatusPill status={reservation.status} />} />
              <DetailRow label="PNR" value={<span className="font-mono">{reservation.pnr}</span>} />
              <DetailRow label="Class" value={`${reservation.travel_class} - ${classLabel(reservation.travel_class)}`} />
              <DetailRow label="Seats" value={<span className="font-mono">{reservation.seat_numbers.join(", ") || "-"}</span>} />
              <DetailRow label="Total fare" value={<span className="font-mono">{formatInr(reservation.total_fare)}</span>} />
              <Separator />
              <DetailRow label="Created" value={formatDateTime(reservation.created_at)} />
              <DetailRow
                label="Hold expires"
                value={reservation.hold_expires_at ? formatDateTime(reservation.hold_expires_at) : "-"}
              />
              <DetailRow label="Reservation ID" value={<span className="font-mono text-xs">{reservation.reservation_id.slice(0, 12)}…</span>} />
              <Separator />
              <DetailRow
                label="Idempotency key"
                value={
                  <span className="max-w-[10rem] truncate font-mono text-xs" title={reservation.idempotency_key}>
                    {reservation.idempotency_key}
                  </span>
                }
              />
            </CardContent>
          </Card>

          {isHeld ? (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-2 border-b border-white/10 px-5 py-3.5">
                <CreditCard className="h-4 w-4 text-cyan-300" aria-hidden />
                <span className="text-sm font-semibold">Simulated payment</span>
              </div>
              <CardContent className="space-y-3 pt-5">
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Choose an outcome to demonstrate how each failure mode is handled. No real money is involved.
                </p>
                {actionError ? <ErrorState error={actionError} /> : null}
                <Button
                  className="w-full"
                  size="lg"
                  disabled={busy !== null}
                  onClick={() => startPayment("success")}
                >
                  {busy === "success" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                  Pay now - success
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy !== null}
                  onClick={() => startPayment("timeout")}
                >
                  {busy === "timeout" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Timer className="h-4 w-4" aria-hidden />}
                  Simulate gateway timeout
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy !== null}
                  onClick={() => startPayment("delayed_success")}
                >
                  {busy === "delayed_success" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                  Simulate delayed response
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={busy !== null}
                  onClick={() => startPayment("failure")}
                >
                  {busy === "failure" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <TriangleAlert className="h-4 w-4" aria-hidden />}
                  Simulate declined payment
                </Button>
                <Separator />
                <Button
                  variant="ghost"
                  className="w-full text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                  disabled={busy !== null}
                  onClick={cancel}
                >
                  {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Ban className="h-4 w-4" aria-hidden />}
                  Cancel booking and release seats
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <InfoBanner title="Crash-resistant by design" tone="cyan">
            <p>
              Reload this page at any time: the hold timer, seats and status are all recomputed from the server.
              Nothing about your reservation lives only in the browser.
            </p>
          </InfoBanner>

          {session.payment ? (
            <Card className="p-5">
              <p className="kicker">Last payment session</p>
              <Link
                to={`/payments/${session.payment.payment_id}`}
                className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm transition-colors hover:border-cyan-400/30"
              >
                <span className="font-mono">{session.payment.reference}</span>
                <StatusPill status={session.payment.status} kind="payment" />
              </Link>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
