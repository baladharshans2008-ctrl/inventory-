import type {
  ApiErrorPayload,
  AppEvent,
  AvailabilityResponse,
  CorrectnessSuite,
  Dashboard,
  HealthResponse,
  MetaResponse,
  Payment,
  PresetsResponse,
  QueueDepth,
  QueueEntry,
  Reservation,
  ScheduleInfo,
  SimulationEventRecord,
  SimulationRun,
  SimulationSummary,
  Station,
  TrainSearchResponse,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") || "/api";

/* ------------------------------------------------------------------ */
/* client identity                                                     */
/* ------------------------------------------------------------------ */
const CLIENT_KEY = "railflow.client_id";

function clientId(): string {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = `web_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

const ADMIN_KEY_STORAGE = "railflow.admin_key";

export function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_STORAGE) || "";
}

export function setAdminKey(value: string): void {
  if (value) localStorage.setItem(ADMIN_KEY_STORAGE, value);
  else localStorage.removeItem(ADMIN_KEY_STORAGE);
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */
export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isQueueRequired(): boolean {
    return this.status === 429 && this.code === "queue_required";
  }
}

function normaliseError(status: number, body: unknown): ApiError {
  const payload = body as ApiErrorPayload | undefined;
  if (payload?.error?.message) {
    return new ApiError(status, payload.error.code || "error", payload.error.message, payload.error.details || {});
  }
  // FastAPI's own validation errors use { detail: ... }
  const detail = (body as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") {
    return new ApiError(status, "http_error", detail);
  }
  if (detail && typeof detail === "object" && "error" in (detail as Record<string, unknown>)) {
    const inner = (detail as ApiErrorPayload).error;
    return new ApiError(status, inner.code || "error", inner.message, inner.details || {});
  }
  return new ApiError(status, "http_error", `Request failed with status ${status}`);
}

/* ------------------------------------------------------------------ */
/* core request                                                        */
/* ------------------------------------------------------------------ */
interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  admin?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, admin = false, signal } = options;
  const headers: Record<string, string> = {
    "X-Client-ID": clientId(),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (admin) headers["X-Admin-Key"] = getAdminKey();

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(
      0,
      "network_error",
      "Could not reach the RailFlow API. Is the backend running on port 8000?",
    );
  }

  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;

  if (!response.ok) {
    throw normaliseError(response.status, parsed);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */
export const api = {
  base: API_BASE,

  meta: () => request<MetaResponse>("/meta"),
  health: () => request<HealthResponse>("/health"),

  stations: () => request<{ count: number; stations: Station[] }>("/stations"),
  routes: () =>
    request<{ routes: { from: { code: string; name?: string }; to: { code: string; name?: string }; schedules: number }[] }>(
      "/routes",
    ),

  searchTrains: (params: {
    from: string;
    to: string;
    date: string;
    travelClass?: string;
    passengers?: number;
    availableOnly?: boolean;
  }) => {
    const qs = new URLSearchParams({
      from: params.from,
      to: params.to,
      date: params.date,
      passengers: String(params.passengers ?? 1),
    });
    if (params.travelClass) qs.set("travel_class", params.travelClass);
    if (params.availableOnly) qs.set("available_only", "true");
    return request<TrainSearchResponse>(`/trains?${qs.toString()}`);
  },

  availability: (scheduleId: number, seatPreview = 96) =>
    request<AvailabilityResponse>(`/trains/${scheduleId}/availability?seat_preview=${seatPreview}`),

  /* --- queue -------------------------------------------------------- */
  joinQueue: (payload: {
    schedule_id: number;
    travel_class: string;
    passenger_count: number;
    request_key: string;
  }) => request<{ created: boolean; queue: QueueEntry }>("/queue/join", { method: "POST", body: payload }),

  queueStatus: () => request<{ queue: QueueDepth; saturated: boolean }>("/queue/status"),
  queueEntry: (token: string) => request<{ queue: QueueEntry }>(`/queue/${token}`),
  injectSurge: (payload: { count: number; schedule_id: number; travel_class: string }) =>
    request<{ injected: number; queue: QueueDepth; simulated: boolean }>("/queue/demo-surge", {
      method: "POST",
      body: payload,
      admin: true,
    }),
  clearQueueDemo: () =>
    request<{ cleared: number; queue: QueueDepth; simulated: boolean }>("/queue/demo-clear", {
      method: "POST",
      admin: true,
    }),
  promoteQueue: (limit = 10) =>
    request<{ promoted: number; queue: QueueDepth }>(`/queue/promote?limit=${limit}`, {
      method: "POST",
      admin: true,
    }),

  /* --- reservations ------------------------------------------------- */
  createReservation: (payload: {
    schedule_id: number;
    travel_class: string;
    passengers: { name: string; age: number; gender: string; berth_preference: string }[];
    idempotency_key: string;
    queue_token?: string | null;
    contact_email?: string | null;
    contact_phone?: string | null;
  }) =>
    request<{ created: boolean; message: string; hold_minutes: number; reservation: Reservation; latency_ms: number }>(
      "/reservations",
      { method: "POST", body: payload },
    ),

  listReservations: (params: { pnr?: string; limit?: number; includeSimulations?: boolean } = {}) => {
    const qs = new URLSearchParams({ limit: String(params.limit ?? 25) });
    if (params.pnr) qs.set("pnr", params.pnr);
    if (params.includeSimulations) qs.set("include_simulations", "true");
    return request<{ count: number; reservations: Reservation[] }>(`/reservations?${qs.toString()}`);
  },

  getReservation: (id: string) => request<{ reservation: Reservation }>(`/reservations/${id}`),

  cancelReservation: (id: string) =>
    request<{ released: boolean; reservation: Reservation }>(`/reservations/${id}/cancel`, { method: "POST" }),

  /* --- payments ----------------------------------------------------- */
  simulatePayment: (payload: { reservation_id: string; idempotency_key: string; scenario?: string; delay_ms?: number }) =>
    request<{ created: boolean; duplicate: boolean; message: string; payment: Payment; latency_ms: number }>(
      "/payments/simulate",
      { method: "POST", body: payload },
    ),

  getPayment: (id: string) => request<{ payment: Payment }>(`/payments/${id}`),

  listPayments: (params: { reservationId?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams({ limit: String(params.limit ?? 25) });
    if (params.reservationId) qs.set("reservation_id", params.reservationId);
    return request<{ count: number; payments: Payment[] }>(`/payments?${qs.toString()}`);
  },

  reconcilePayment: (id: string, force = false) =>
    request<{ previous_status: string; resolved: boolean; summary: string; payment: Payment }>(
      `/payments/${id}/reconcile?force=${force}`,
      { method: "POST" },
    ),

  /* --- admin / operations ------------------------------------------- */
  dashboard: (window: "5m" | "15m" | "60m" | "180m" = "15m") =>
    request<Dashboard>(`/admin/metrics?window=${window}`, { admin: true }),

  events: (params: { limit?: number; eventType?: string; severity?: string } = {}) => {
    const qs = new URLSearchParams({ limit: String(params.limit ?? 60) });
    if (params.eventType) qs.set("event_type", params.eventType);
    if (params.severity) qs.set("severity", params.severity);
    return request<{ count: number; events: AppEvent[] }>(`/admin/events?${qs.toString()}`, { admin: true });
  },

  eventTypes: () =>
    request<{ types: { event_type: string; count: number }[] }>("/admin/event-types", { admin: true }),

  inventoryOverview: () =>
    request<{
      count: number;
      inventory: {
        schedule_id: number;
        travel_class: string;
        total_seats: number;
        available: number;
        held: number;
        confirmed: number;
      }[];
    }>("/admin/inventory", { admin: true }),

  consistency: (scheduleId: number) =>
    request<{ schedule_id: number; ok: boolean; checks: { name: string; passed: boolean; detail: string }[] }>(
      `/admin/inventory/${scheduleId}/consistency`,
      { admin: true },
    ),

  /* --- simulation lab ----------------------------------------------- */
  presets: () => request<PresetsResponse>("/simulations/presets", { admin: true }),

  runSimulation: (payload: {
    scenario: string;
    mode: string;
    concurrent_requests?: number;
    available_seats?: number;
    seats_per_request?: number;
    arrival_rate_per_second?: number;
    payment_failure_pct?: number;
    payment_delay_ms?: number;
    network_timeout_pct?: number;
    hold_seconds?: number;
    duplicate_retry_pct?: number;
    seed?: number;
  }) =>
    request<{ run_id: string; status: string; config: Record<string, unknown>; message: string }>("/simulations/run", {
      method: "POST",
      body: payload,
      admin: true,
    }),

  runs: (limit = 10) => request<{ runs: SimulationRun[] }>(`/simulations/runs?limit=${limit}`, { admin: true }),

  getRun: (id: string) =>
    request<{ run: SimulationRun; progress_pct: number }>(`/simulations/${id}`, { admin: true }),

  runEvents: (id: string, afterSeq = 0, limit = 200) =>
    request<{ count: number; events: SimulationEventRecord[]; last_seq: number }>(
      `/simulations/${id}/events?after_seq=${afterSeq}&limit=${limit}`,
      { admin: true },
    ),

  runResults: (id: string) =>
    request<{
      run_id: string;
      status: string;
      results_ready: boolean;
      results?: SimulationSummary;
      message?: string;
      progress?: number;
      total_requests?: number;
    }>(`/simulations/${id}/results`, { admin: true }),

  correctnessInfo: () =>
    request<{
      suite: string;
      tests: { id: string; name: string; detail: string }[];
      run_with: string;
    }>("/simulations/correctness", { admin: true }),

  runCorrectness: (tests?: string) =>
    request<CorrectnessSuite>(`/simulations/correctness${tests ? `?tests=${tests}` : ""}`, {
      method: "POST",
      admin: true,
    }),
};

/* ------------------------------------------------------------------ */
/* SSE helper for the live dashboard                                    */
/* ------------------------------------------------------------------ */
export function openDashboardStream(
  onMetrics: (payload: Dashboard & { new_events?: AppEvent[] }) => void,
  onStatus?: (status: "open" | "error") => void,
  window = "15m",
): EventSource {
  const key = getAdminKey();
  const url = `${API_BASE}/admin/stream?window=${window}&key=${encodeURIComponent(key)}`;
  const source = new EventSource(url);
  source.addEventListener("metrics", (event) => {
    try {
      onMetrics(JSON.parse((event as MessageEvent).data));
    } catch {
      /* ignore malformed frame */
    }
  });
  source.onopen = () => onStatus?.("open");
  source.onerror = () => onStatus?.("error");
  return source;
}

export function newKey(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export type { ScheduleInfo };
