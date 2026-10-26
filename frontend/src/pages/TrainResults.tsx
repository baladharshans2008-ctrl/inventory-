import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  CalendarDays,
  Clock,
  Info,
  MapPin,
  Route,
  Search,
  Ticket,
  TrainFront,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState, ErrorState, InfoBanner } from "@/components/States";
import { StatusPill } from "@/components/StatusPill";
import { SeatMap, SeatSummaryBar } from "@/components/SeatMap";
import { Skeleton, TableSkeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { classLabel, formatDate, formatInr, formatNumber } from "@/lib/format";
import type { ClassAvailability, ScheduleInfo } from "@/lib/types";
import { useSession } from "@/lib/store";

export default function TrainResults() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { session, updateSearch, updateDraft } = useSession();

  const from = params.get("from") || session.search.from;
  const to = params.get("to") || session.search.to;
  const date = params.get("date") || session.search.date;
  const travelClass = params.get("class") || session.search.travelClass;
  const pax = Number(params.get("pax") || session.search.passengers);

  const [selectedClass, setSelectedClass] = useState(travelClass);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [chosen, setChosen] = useState<{ scheduleId: number; travelClass: string } | null>(null);

  const search = useAsync(
    () =>
      api.searchTrains({
        from,
        to,
        date,
        travelClass: selectedClass,
        passengers: pax,
        availableOnly,
      }),
    [from, to, date, selectedClass, pax, availableOnly],
  );

  useEffect(() => {
    updateSearch({ from, to, date, travelClass: selectedClass, passengers: pax });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, date, selectedClass, pax]);

  const results = search.data?.results ?? [];
  const totalSeatsAvailable = useMemo(
    () => results.reduce((sum, item) => sum + (item.selected_class?.available_count ?? 0), 0),
    [results],
  );

  const preview = useAsync(
    () => (expanded ? api.availability(expanded) : Promise.resolve(null)),
    [expanded],
  );

  function continueToBooking() {
    if (!chosen) return;
    updateDraft({ scheduleId: chosen.scheduleId, travelClass: chosen.travelClass });
    navigate(`/book/${chosen.scheduleId}?class=${chosen.travelClass}&pax=${pax}`);
  }

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Step 2 of 4 - Results"
        title={`${from} → ${to}`}
        description={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="h-4 w-4" aria-hidden />
              {formatDate(date)}
            </span>
            <span className="flex items-center gap-1.5">
              <Users className="h-4 w-4" aria-hidden />
              {pax} passenger{pax > 1 ? "s" : ""}
            </span>
            <span className="flex items-center gap-1.5">
              <Info className="h-4 w-4" aria-hidden />
              {search.data ? `${search.data.count} train(s) found` : "searching..."}
            </span>
          </span>
        }
        actions={
          <>
            <Button asChild variant="secondary">
              <Link to="/search">
                <Search className="h-4 w-4" aria-hidden />
                Modify search
              </Link>
            </Button>
            <Button disabled={!chosen} onClick={continueToBooking}>
              <Ticket className="h-4 w-4" aria-hidden />
              Continue
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Tabs value={selectedClass} onValueChange={setSelectedClass}>
          <TabsList className="flex-wrap">
            {["1A", "2A", "3A", "SL", "CC", "EC"].map((code) => (
              <TabsTrigger key={code} value={code}>
                {code}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-3">
          <Button
            variant={availableOnly ? "default" : "secondary"}
            size="sm"
            onClick={() => setAvailableOnly((v) => !v)}
          >
            Available only
          </Button>
          <Badge variant="secondary">
            <Route className="h-3 w-3" aria-hidden />
            {formatNumber(totalSeatsAvailable)} seats in {selectedClass}
          </Badge>
        </div>
      </div>

      {search.error ? <ErrorState error={search.error} onRetry={search.refresh} /> : null}

      {search.loading ? (
        <Card className="p-6">
          <TableSkeleton rows={3} />
        </Card>
      ) : null}

      {!search.loading && !search.error && results.length === 0 ? (
        <EmptyState
          icon={TrainFront}
          title="No trains found on this route and date"
          description="The seeded timetable covers three days from today. Try a different date, or pick one of the popular routes on the search page."
          action={
            <Button asChild className="mt-2" variant="secondary">
              <Link to="/search">Change search</Link>
            </Button>
          }
        />
      ) : null}

      <div className="space-y-4">
        {results.map((schedule) => (
          <ResultRow
            key={schedule.schedule_id}
            schedule={schedule}
            requestedClass={selectedClass}
            passengers={pax}
            chosen={chosen}
            onChoose={(cls) => setChosen({ scheduleId: schedule.schedule_id, travelClass: cls })}
            expanded={expanded === schedule.schedule_id}
            onToggleExpand={() =>
              setExpanded((prev) => (prev === schedule.schedule_id ? null : schedule.schedule_id))
            }
          />
        ))}
      </div>

      {expanded !== null ? (
        <Card className="mt-6 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-cyan-300" aria-hidden />
              <h3 className="text-base font-semibold">
                Physical seat map -{" "}
                <span className="font-mono text-sm text-cyan-300">
                  {preview.data?.schedule.train.number ?? "..."}
                </span>
              </h3>
            </div>
            {preview.data ? (
              <Badge variant="secondary">
                Snapshot at {new Date().toLocaleTimeString("en-IN", { hour12: false })}
              </Badge>
            ) : null}
          </div>

          {preview.loading ? (
            <div className="mt-5 grid grid-cols-8 gap-2">
              {Array.from({ length: 24 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : preview.data ? (
            <div className="mt-5 space-y-6">
              <SeatSummaryBar
                total={preview.data.snapshot.classes.find((c) => c.travel_class === selectedClass)?.total_seats ?? 0}
                available={preview.data.snapshot.classes.find((c) => c.travel_class === selectedClass)?.available_count ?? 0}
                held={preview.data.snapshot.classes.find((c) => c.travel_class === selectedClass)?.held_count ?? 0}
                confirmed={preview.data.snapshot.classes.find((c) => c.travel_class === selectedClass)?.confirmed_count ?? 0}
              />
              <SeatMap seats={preview.data.seats[selectedClass] ?? []} />
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Preview unavailable.</p>
          )}
        </Card>
      ) : null}

      <InfoBanner title="Seat maps are never optimistic" tone="cyan">
        <p>
          The grid above is read directly from the seat rows that the allocation transaction locks with{" "}
          <span className="font-mono">SELECT ... FOR UPDATE</span>. Colours reflect persisted status, so a
          seat that turns amber is genuinely held by another booking right now.
        </p>
      </InfoBanner>
    </div>
  );
}

function ResultRow({
  schedule,
  requestedClass,
  passengers,
  chosen,
  onChoose,
  expanded,
  onToggleExpand,
}: {
  schedule: ScheduleInfo;
  requestedClass: string;
  passengers: number;
  chosen: { scheduleId: number; travelClass: string } | null;
  onChoose: (travelClass: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const selected = chosen?.scheduleId === schedule.schedule_id ? chosen.travelClass : null;

  return (
    <Card className="overflow-hidden transition-colors hover:border-cyan-400/20">
      <CardContent className="grid gap-6 pt-6 lg:grid-cols-[1.3fr_1.4fr_auto]">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/20 bg-cyan-400/[0.08] text-cyan-300">
              <TrainFront className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <p className="font-semibold leading-tight">{schedule.train.name}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {schedule.train.number} · {schedule.train.type}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-4">
            <div>
              <p className="font-mono text-xl font-semibold tabular-nums">{schedule.departure_time}</p>
              <p className="font-mono text-xs text-muted-foreground">{schedule.from.code}</p>
            </div>
            <div className="flex flex-1 flex-col items-center">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" aria-hidden />
                {schedule.duration_label}
              </span>
              <span className="my-1 h-px w-full bg-gradient-to-r from-cyan-400/40 via-white/15 to-cyan-400/40" aria-hidden />
              <span className="text-[0.65rem] text-muted-foreground">{formatNumber(schedule.distance_km)} km</span>
            </div>
            <div className="text-right">
              <p className="font-mono text-xl font-semibold tabular-nums">{schedule.arrival_time}</p>
              <p className="font-mono text-xs text-muted-foreground">{schedule.to.code}</p>
            </div>
          </div>
          {schedule.overnight ? (
            <Badge variant="secondary" className="mt-3">
              Overnight journey
            </Badge>
          ) : null}
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Class availability
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {schedule.classes.map((cls) => (
              <ClassChip
                key={cls.travel_class}
                cls={cls}
                passengers={passengers}
                requested={cls.travel_class === requestedClass}
                selected={cls.travel_class === selected}
                onSelect={() => onChoose(cls.travel_class)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col justify-center gap-2 lg:w-40">
          <Button
            variant={selected ? "default" : "secondary"}
            disabled={!selected}
            onClick={onToggleExpand}
          >
            {expanded ? "Hide seats" : "View seats"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChoose(requestedClass);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Select {requestedClass}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ClassChip({
  cls,
  passengers,
  requested,
  selected,
  onSelect,
}: {
  cls: ClassAvailability;
  passengers: number;
  requested: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const enough = cls.available_count >= passengers;
  const disabled = cls.available_count <= 0;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={[
        "rounded-xl border px-3 py-2.5 text-left transition-all",
        selected
          ? "border-cyan-400/60 bg-cyan-400/[0.12] shadow-[0_10px_28px_-16px_rgba(6,182,212,0.9)]"
          : disabled
            ? "cursor-not-allowed border-white/8 bg-white/[0.02] opacity-55"
            : "border-white/10 bg-white/[0.03] hover:border-cyan-400/30 hover:bg-white/[0.06]",
        requested && !selected ? "ring-1 ring-inset ring-sky-400/30" : "",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold">{cls.travel_class}</span>
        <StatusPill status={cls.availability_status} kind="availability" />
      </div>
      <p className="mt-1 truncate text-[0.68rem] text-muted-foreground">{classLabel(cls.travel_class)}</p>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
        <span className={enough ? "text-emerald-300" : "text-amber-300"}>
          {cls.available_count} available
        </span>
        <span className="font-mono text-foreground/80">{formatInr(cls.fare)}</span>
      </div>
    </button>
  );
}
