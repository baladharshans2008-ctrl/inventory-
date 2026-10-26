import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarDays,
  Info,
  Loader2,
  Lock,
  ShieldCheck,
  Ticket,
  TrainFront,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState, InfoBanner } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { classLabel, formatDate, formatInr } from "@/lib/format";
import { BERTHS, GENDERS, useSession } from "@/lib/store";
import { isComplete, submitReservation } from "@/lib/booking";

export default function BookingForm() {
  const { scheduleId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { session, update, updateDraft, updatePassenger, setPassengerCount, ensureIdempotencyKey } = useSession();

  const id = Number(scheduleId);
  const travelClass = params.get("class") || session.draft.travelClass || session.search.travelClass;
  const pax = Number(params.get("pax") || session.search.passengers);

  const availability = useAsync(() => api.availability(id), [id]);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState<Awaited<ReturnType<typeof submitReservation>> | null>(null);

  useEffect(() => {
    updateDraft({ scheduleId: id, travelClass });
    setPassengerCount(pax);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, travelClass, pax]);

  const schedule = availability.data?.schedule;
  const cls = useMemo(
    () => availability.data?.snapshot.classes.find((c) => c.travel_class === travelClass),
    [availability.data, travelClass],
  );

  const draft = session.draft;
  const totalFare = (cls?.base_fare ?? 0) * draft.passengers.length;
  const ready = isComplete(draft) && !!cls && (cls?.available_count ?? 0) >= draft.passengers.length;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setAttempt(null);
    const key = ensureIdempotencyKey();
    const result = await submitReservation(draft, key, session.queueToken);
    setAttempt(result);
    setSubmitting(false);

    if (result.ok) {
      update({ reservation: result.reservation, payment: null });
      navigate(`/bookings/${result.reservation.reservation_id}`);
      return;
    }
    if (result.reason === "queue_required") {
      navigate("/queue");
    }
  }

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Step 3 of 4 - Passenger details"
        title="Who is travelling?"
        description="Seats are held the moment you submit. Complete the simulated payment before the hold window closes, or the seats return to inventory automatically."
        actions={
          <Button asChild variant="secondary">
            <Link to={`/trains?from=${session.search.from}&to=${session.search.to}&date=${session.search.date}&class=${travelClass}&pax=${pax}`}>
              Back to results
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* ---------------- form (light surface) ---------------- */}
        <div className="paper rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-lift">
          {availability.error ? (
            <ErrorState error={availability.error} onRetry={availability.refresh} />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-cyan-600" aria-hidden />
                  <h2 className="text-lg font-semibold text-slate-900">
                    {draft.passengers.length} passenger{draft.passengers.length > 1 ? "s" : ""}
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="pax-count" className="text-slate-500">
                    Change count
                  </Label>
                  <NativeSelect
                    id="pax-count"
                    value={draft.passengers.length}
                    onChange={(e) => setPassengerCount(Number(e.target.value))}
                    className="h-8 w-20 bg-white text-slate-900"
                  >
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>

              <div className="space-y-4">
                {draft.passengers.map((passenger, index) => (
                  <div key={index} className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-cyan-600 text-xs font-bold text-white">
                        {index + 1}
                      </span>
                      <span className="text-sm font-semibold text-slate-700">Passenger {index + 1}</span>
                      {index === 0 ? <Badge variant="secondary" className="bg-slate-200 text-slate-700">Lead passenger</Badge> : null}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
                        <Label htmlFor={`name-${index}`} className="text-slate-500">
                          Full name
                        </Label>
                        <Input
                          id={`name-${index}`}
                          value={passenger.name}
                          onChange={(e) => updatePassenger(index, { name: e.target.value })}
                          placeholder="Passenger name"
                          className="bg-white text-slate-900 placeholder:text-slate-400"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`age-${index}`} className="text-slate-500">
                          Age
                        </Label>
                        <Input
                          id={`age-${index}`}
                          type="number"
                          min={1}
                          max={120}
                          value={passenger.age}
                          onChange={(e) => updatePassenger(index, { age: Number(e.target.value) })}
                          className="bg-white text-slate-900"
                          required
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`gender-${index}`} className="text-slate-500">
                          Gender
                        </Label>
                        <NativeSelect
                          id={`gender-${index}`}
                          value={passenger.gender}
                          onChange={(e) => updatePassenger(index, { gender: e.target.value })}
                          className="bg-white text-slate-900"
                        >
                          {GENDERS.map((g) => (
                            <option key={g} value={g}>
                              {g}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`berth-${index}`} className="text-slate-500">
                          Berth preference
                        </Label>
                        <NativeSelect
                          id={`berth-${index}`}
                          value={passenger.berth_preference}
                          onChange={(e) => updatePassenger(index, { berth_preference: e.target.value })}
                          className="bg-white text-slate-900"
                        >
                          {BERTHS.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Contact (optional)</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-cyan-700 hover:bg-cyan-50"
                  onClick={() => setPassengerCount(Math.min(6, draft.passengers.length + 1))}
                  disabled={draft.passengers.length >= 6}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  Add passenger
                </Button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="text-slate-500">
                    Email (for booking lookup)
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={draft.contactEmail}
                    onChange={(e) => updateDraft({ contactEmail: e.target.value })}
                    placeholder="you@example.com"
                    className="bg-white text-slate-900 placeholder:text-slate-400"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="phone" className="text-slate-500">
                    Mobile number
                  </Label>
                  <Input
                    id="phone"
                    value={draft.contactPhone}
                    onChange={(e) => updateDraft({ contactPhone: e.target.value })}
                    placeholder="+91 90000 00000"
                    className="bg-white text-slate-900 placeholder:text-slate-400"
                  />
                </div>
              </div>

              {attempt && !attempt.ok ? (
                <div className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                  <p className="flex items-center gap-2 font-semibold">
                    <AlertCircle className="h-4 w-4" aria-hidden />
                    {attempt.reason === "seat_unavailable"
                      ? "Those seats were taken"
                      : attempt.reason === "queue_required"
                        ? "Booking service at capacity"
                        : "Booking rejected"}
                  </p>
                  <p className="mt-1 leading-relaxed">{attempt.error.message}</p>
                  {attempt.reason === "queue_required" ? (
                    <Button asChild size="sm" className="mt-3">
                      <Link to="/queue">
                        Join the virtual queue
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : null}

              <Separator className="bg-slate-200" />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-2 text-xs text-slate-500">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden />
                  Idempotency key ensures a double click never books twice.
                </p>
                <Button type="submit" size="lg" disabled={!ready || submitting}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Ticket className="h-4 w-4" aria-hidden />}
                  {submitting ? "Holding seats..." : "Hold seats & continue"}
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* ---------------- summary ---------------- */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Journey summary
              </span>
              <Ticket className="h-4 w-4 text-cyan-300" aria-hidden />
            </div>
            <CardContent className="space-y-4 pt-5">
              {availability.loading || !schedule ? (
                <div className="space-y-3">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-20 w-full rounded-xl" />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
                      <TrainFront className="h-5 w-5" aria-hidden />
                    </span>
                    <div>
                      <p className="font-semibold leading-tight">{schedule.train.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{schedule.train.number}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div>
                      <p className="font-mono text-lg font-semibold">{schedule.departure_time}</p>
                      <p className="font-mono text-xs text-muted-foreground">{schedule.from.code}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                    <div className="text-right">
                      <p className="font-mono text-lg font-semibold">{schedule.arrival_time}</p>
                      <p className="font-mono text-xs text-muted-foreground">{schedule.to.code}</p>
                    </div>
                  </div>

                  <div className="space-y-2 text-sm">
                    <Row label="Travel date" value={
                      <span className="flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        {formatDate(schedule.travel_date)}
                      </span>
                    } />
                    <Row label="Class" value={<span className="font-mono">{travelClass}</span>} />
                    <Row label="Class name" value={classLabel(travelClass)} />
                    <Row label="Duration" value={schedule.duration_label} />
                    <Row label="Distance" value={`${schedule.distance_km} km`} />
                  </div>

                  <Separator />

                  <div className="space-y-2 text-sm">
                    <Row
                      label="Availability"
                      value={cls ? <StatusPill status={cls.available_count > 0 ? (cls.available_count >= draft.passengers.length ? "AVAILABLE" : "LIMITED") : "NOT_AVAILABLE"} kind="availability" /> : "-"}
                    />
                    <Row label="Seats requested" value={String(draft.passengers.length)} />
                    <Row label="Fare per seat" value={formatInr(cls?.base_fare)} mono />
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-cyan-400/20 bg-cyan-400/[0.07] px-4 py-3">
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Wallet className="h-4 w-4 text-cyan-300" aria-hidden />
                      Total fare
                    </span>
                    <span className="font-mono text-lg font-bold text-cyan-100">{formatInr(totalFare)}</span>
                  </div>

                  {cls && cls.available_count < draft.passengers.length ? (
                    <p className="text-xs text-amber-200">
                      Only {cls.available_count} seat(s) left in {travelClass}. Reduce the passenger count or choose
                      another class.
                    </p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <InfoBanner title="What happens when you submit" tone="cyan">
            <ol className="ml-4 list-decimal space-y-1">
              <li>The API takes a row lock on the class counter inside one transaction.</li>
              <li>Seats are claimed with a conditional UPDATE; a lost race returns a 409 conflict.</li>
              <li>Your seats become HELD for the hold window and a countdown starts.</li>
              <li>Payment confirmation moves them to CONFIRMED; expiry returns them to AVAILABLE.</li>
            </ol>
          </InfoBanner>

          <Card className="p-5">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock className="h-4 w-4 text-cyan-300" aria-hidden />
              This prototype never collects real payment details and never issues a real ticket.
            </p>
            <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5" aria-hidden />
              {session.queueToken ? (
                <>
                  Admission token present:{" "}
                  <span className="font-mono text-foreground">{session.queueToken}</span>
                </>
              ) : (
                "No queue token yet - if the service is saturated the API will ask you to queue."
              )}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono tabular-nums" : "font-medium"}>{value}</span>
    </div>
  );
}
