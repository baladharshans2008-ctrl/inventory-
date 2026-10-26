/** Presentation helpers. All timestamps from the API are naive UTC ISO strings. */

function asUtcDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Backend stores naive UTC; append Z when no timezone is present.
  const normalised = /[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalised);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return new Intl.NumberFormat("en-IN").format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(digits)}%`;
}

export function formatClock(value: string | null | undefined): string {
  const date = asUtcDate(value);
  if (!date) return "-";
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function formatTime(value: string | null | undefined): string {
  const date = asUtcDate(value);
  if (!date) return "-";
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  const date = asUtcDate(value);
  if (!date) return "-";
  return `${date.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} ${date.toLocaleTimeString(
    "en-IN",
    { hour: "2-digit", minute: "2-digit", hour12: false },
  )}`;
}

export function relativeFromNow(value: string | null | undefined): string {
  const date = asUtcDate(value);
  if (!date) return "-";
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const suffix = deltaSeconds >= 0 ? "from now" : "ago";
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86400)}d ${suffix}`;
}

/** mm:ss countdown label from a number of seconds. */
export function countdownLabel(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function classLabel(code: string): string {
  const map: Record<string, string> = {
    "1A": "AC First Class",
    "2A": "AC 2 Tier",
    "3A": "AC 3 Tier",
    SL: "Sleeper",
    CC: "AC Chair Car",
    EC: "Executive Chair Car",
  };
  return map[code] ?? code;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
