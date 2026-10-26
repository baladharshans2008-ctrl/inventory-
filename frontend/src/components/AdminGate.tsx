import { Link } from "react-router-dom";
import { AlertTriangle, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { getAdminKey, setAdminKey } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";

/**
 * Operations and Simulation screens read real backend telemetry, which the API
 * protects behind the admin key. This gate stores the key locally; it is never
 * sent anywhere except the RailFlow API.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(getAdminKey());
  const [draft, setDraft] = useState(getAdminKey());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setKey(getAdminKey());
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (trimmed.length < 6) {
      setError("The admin key must be at least 6 characters. The default demo key is shown below.");
      return;
    }
    setAdminKey(trimmed);
    setKey(trimmed);
    setError(null);
  }

  if (key) {
    return (
      <div>
        <div className="container pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm text-emerald-100/90">
              <ShieldCheck className="h-4 w-4" aria-hidden />
              Administrative session active - telemetry is read from the live backend.
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdminKey("");
                setKey("");
                setDraft("");
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="container py-10">
      <PageHeader
        kicker="Administrative area"
        title="Operational access"
        description="The reliability dashboard and the simulation lab expose internal telemetry and can trigger load tests, so the API protects them with an admin key."
      />
      <div className="paper mt-8 max-w-xl rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-lift">
        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-cyan-600" aria-hidden />
            <h2 className="text-base font-semibold">Enter the admin key</h2>
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-key" className="text-slate-600">
              Admin key
            </Label>
            <Input
              id="admin-key"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="railflow-demo-admin-key"
              className="bg-slate-50 text-slate-900 placeholder:text-slate-400"
            />
          </div>
          {error ? <p className="text-sm text-rose-600">{error}</p> : null}
          <Button type="submit" className="w-full">
            Unlock operations
          </Button>
        </form>

        <div className="mt-5 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Development default
          </p>
          <p className="mt-1 leading-relaxed">
            The backend ships with <code className="rounded bg-amber-100 px-1 font-mono">railflow-demo-admin-key</code>.
            Override it with the <code className="font-mono">ADMIN_API_KEY</code> environment variable before
            exposing the service to anyone.
          </p>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          The key is stored in this browser&apos;s local storage only. Need to explore the booking flow instead?{" "}
          <Link to="/search" className="font-medium text-cyan-700 hover:underline">
            Search trains
          </Link>
          .
        </p>
      </div>
      <Badge variant="secondary" className="mt-6">
        Endpoint: GET /api/admin/metrics requires the X-Admin-Key header
      </Badge>
    </div>
  );
}
