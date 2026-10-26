import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeftRight, CalendarDays, Filter, Info, Search, TrainFront, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { InfoBanner } from "@/components/States";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/hooks";
import { classLabel } from "@/lib/format";
import { useSession } from "@/lib/store";

const CLASS_OPTIONS = ["1A", "2A", "3A", "SL", "CC", "EC"];

export default function SearchTrains() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { session, updateSearch } = useSession();

  const stations = useAsync(() => api.stations(), []);
  const routes = useAsync(() => api.routes(), []);

  const [from, setFrom] = useState(params.get("from") || session.search.from);
  const [to, setTo] = useState(params.get("to") || session.search.to);
  const [date, setDate] = useState(session.search.date);
  const [travelClass, setTravelClass] = useState(session.search.travelClass);
  const [passengers, setPassengers] = useState(session.search.passengers);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    updateSearch({ from, to, date, travelClass, passengers });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, date, travelClass, passengers]);

  const stationsSorted = useMemo(
    () => (stations.data?.stations ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [stations.data],
  );

  const sameStation = from === to && touched;

  function swap() {
    setFrom(to);
    setTo(from);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (from === to) {
      setTouched(true);
      return;
    }
    const qs = new URLSearchParams({
      from,
      to,
      date,
      class: travelClass,
      pax: String(passengers),
    });
    navigate(`/trains?${qs.toString()}`);
  }

  const minDate = new Date().toISOString().slice(0, 10);

  return (
    <div className="container pb-16">
      <PageHeader
        kicker="Step 1 of 4 - Search"
        title="Find a fictional train"
        description="Availability always comes from the live database inventory, never from a cached guess. Pick a route, a date and a class to continue."
      />

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-white/10 bg-white/[0.02] px-5 py-3 text-sm text-muted-foreground">
            All trains, stations and fares on this platform are invented for the prototype.
          </div>
          <CardContent className="pt-6">
            <form onSubmit={submit} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
                <div className="space-y-2">
                  <Label htmlFor="from">From</Label>
                  {stations.loading ? (
                    <Skeleton className="h-10 w-full rounded-lg" />
                  ) : (
                    <NativeSelect id="from" value={from} onChange={(e) => setFrom(e.target.value)}>
                      {stationsSorted.map((station) => (
                        <option key={station.code} value={station.code}>
                          {station.name} ({station.code})
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </div>

                <div className="flex items-end justify-center pb-1">
                  <Button type="button" variant="secondary" size="icon" onClick={swap} aria-label="Swap stations">
                    <ArrowLeftRight className="h-4 w-4" aria-hidden />
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="to">To</Label>
                  {stations.loading ? (
                    <Skeleton className="h-10 w-full rounded-lg" />
                  ) : (
                    <NativeSelect id="to" value={to} onChange={(e) => setTo(e.target.value)}>
                      {stationsSorted.map((station) => (
                        <option key={station.code} value={station.code}>
                          {station.name} ({station.code})
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </div>
              </div>

              {sameStation ? (
                <p className="text-sm text-rose-300">Origin and destination must be different stations.</p>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="date">Travel date</Label>
                  <div className="relative">
                    <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="date"
                      type="date"
                      className="pl-9"
                      min={minDate}
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="class">Class</Label>
                  <NativeSelect
                    id="class"
                    value={travelClass}
                    onChange={(e) => setTravelClass(e.target.value)}
                  >
                    {CLASS_OPTIONS.map((code) => (
                      <option key={code} value={code}>
                        {code} - {classLabel(code)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="passengers">Passengers</Label>
                  <NativeSelect
                    id="passengers"
                    value={passengers}
                    onChange={(e) => setPassengers(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5, 6].map((count) => (
                      <option key={count} value={count}>
                        {count} passenger{count > 1 ? "s" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button type="submit" size="lg">
                  <Search className="h-4 w-4" aria-hidden />
                  Search trains
                </Button>
                <Button asChild variant="ghost">
                  <Link to="/">Back to home</Link>
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-cyan-300" aria-hidden />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Popular routes
              </h2>
            </div>
            <div className="mt-4 space-y-2">
              {routes.loading
                ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)
                : (routes.data?.routes ?? []).slice(0, 6).map((route) => (
                    <button
                      key={`${route.from.code}-${route.to.code}`}
                      type="button"
                      onClick={() => {
                        setFrom(route.from.code);
                        setTo(route.to.code);
                      }}
                      className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm transition-colors hover:border-cyan-400/30 hover:bg-white/[0.06]"
                    >
                      <span className="font-mono text-xs">
                        {route.from.code} → {route.to.code}
                      </span>
                      <Badge variant="secondary" className="text-[0.65rem]">
                        {route.schedules} trains
                      </Badge>
                    </button>
                  ))}
            </div>
            {routes.error ? <p className="mt-3 text-xs text-rose-300">{routes.error.message}</p> : null}
          </Card>

          <InfoBanner title="How availability is computed" tone="cyan">
            <p className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                The search endpoint subtracts confirmed and held seats from physical seat rows at request time.
                A class shows <span className="font-mono">RAC only</span> or{" "}
                <span className="font-mono">Not available</span> based on the real counters, so two browsers
                never disagree.
              </span>
            </p>
          </InfoBanner>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" aria-hidden />
              You are searching for {passengers} passenger{passengers > 1 ? "s" : ""}
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <TrainFront className="h-4 w-4" aria-hidden />
              Max 6 seats per booking request
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
