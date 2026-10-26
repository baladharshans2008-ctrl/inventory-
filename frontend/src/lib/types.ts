/** Shared types - these mirror the FastAPI serialisers exactly. */

export type ReservationStatus = "HELD" | "CONFIRMED" | "EXPIRED" | "RELEASED" | "FAILED";
export type PaymentStatus = "INITIATED" | "PENDING" | "RECONCILING" | "SUCCESS" | "FAILED";
export type QueueStatus = "WAITING" | "READY" | "PROCESSING" | "CONSUMED" | "EXPIRED";
export type SeatStatus = "AVAILABLE" | "HELD" | "CONFIRMED";
export type AvailabilityLabel = "AVAILABLE" | "LIMITED" | "RAC_ONLY" | "NOT_AVAILABLE";

export interface Station {
  code: string;
  name: string;
  city: string;
  state: string;
  zone: string;
}

export interface TrainInfo {
  id: number;
  number: string;
  name: string;
  type: string;
}

export interface ClassAvailability {
  travel_class: string;
  total_seats: number;
  available_count: number;
  held_count: number;
  confirmed_count: number;
  fare: number;
  availability_status: AvailabilityLabel;
}

export interface ScheduleInfo {
  schedule_id: number;
  travel_date: string;
  train: TrainInfo;
  from: { code: string; name?: string };
  to: { code: string; name?: string };
  departure_time: string;
  arrival_time: string;
  duration_minutes: number;
  duration_label: string;
  distance_km: number;
  overnight: boolean;
  classes: ClassAvailability[];
  selected_class: ClassAvailability | null;
  is_simulation: boolean;
}

export interface TrainSearchResponse {
  query: {
    from: string;
    to: string;
    date: string;
    travel_class: string | null;
    passengers: number;
  };
  count: number;
  searched_schedules: number;
  results: ScheduleInfo[];
  data_source: string;
}

export interface SeatPreview {
  seat_number: string;
  seat_type: string;
  status: SeatStatus;
  held_until: string | null;
}

export interface AvailabilityResponse {
  schedule: ScheduleInfo;
  seat_preview_limit: number;
  seats: Record<string, SeatPreview[]>;
  snapshot: {
    schedule_id: number;
    classes: {
      travel_class: string;
      total_seats: number;
      available_count: number;
      held_count: number;
      confirmed_count: number;
      base_fare: number;
      seats_by_status: Record<string, number>;
    }[];
  };
}

export interface PassengerInput {
  name: string;
  age: number;
  gender: string;
  berth_preference: string;
}

export interface Passenger extends PassengerInput {
  seat_number: string | null;
}

export interface Reservation {
  reservation_id: string;
  pnr: string;
  status: ReservationStatus;
  schedule: ScheduleInfo;
  travel_class: string;
  passenger_count: number;
  total_fare: number;
  seat_numbers: string[];
  hold_expires_at: string | null;
  hold_seconds_remaining: number;
  idempotency_key: string;
  queue_token: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  confirmed_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  is_simulation: boolean;
  passengers: Passenger[];
}

export interface QueueDepth {
  waiting: number;
  admitted: number;
  capacity: number;
  admission_rate_per_second: number;
  occupancy_pct: number;
}

export interface QueueEntry {
  token: string;
  request_key: string;
  status: QueueStatus;
  position: number;
  position_at_join: number;
  requests_ahead: number;
  estimated_wait_seconds: number;
  estimate_is_approximate: boolean;
  queue_depth: QueueDepth;
  capacity: number;
  admission_rate_per_second: number;
  joined_at: string;
  admitted_at: string | null;
  expires_at: string | null;
  schedule_id: number;
  travel_class: string;
  passenger_count: number;
  note: string;
  expired: boolean;
}

export interface PaymentTimelineStep {
  state: string;
  at: string;
  done: boolean;
}

export interface Payment {
  payment_id: string;
  reference: string;
  reservation_id: string;
  pnr: string | null;
  amount: number;
  status: PaymentStatus;
  scenario: string;
  gateway_ref: string | null;
  simulated: boolean;
  attempts: number;
  reconciled: boolean;
  reconciliation_notes: string | null;
  failure_reason: string | null;
  message: string;
  latency_ms: number;
  resolve_at: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  next_action: string;
  do_not_retry: boolean;
  timeline: PaymentTimelineStep[];
  idempotency_key: string;
}

export interface AppEvent {
  id: number;
  event_type: string;
  message: string;
  severity: "info" | "warning" | "error";
  request_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface ServiceStatus {
  component: string;
  status: string;
  detail: string;
  simulated: boolean;
}

export interface MetricsSeriesPoint {
  bucket: string;
  requests: number;
  successful: number;
  failed: number;
  conflicts: number;
  duplicates_blocked: number;
  queue_depth: number;
  queue_admitted: number;
  rps: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  payment_success: number;
  payment_failed: number;
  payment_pending: number;
  pending_reconciliations: number;
  seats_available: number;
  bookings_confirmed: number;
}

export interface Dashboard {
  generated_at: string;
  window_minutes: number;
  demo_mode: boolean;
  live: {
    queue_depth: number;
    queue_admitted: number;
    queue_capacity: number;
    queue_occupancy_pct: number;
    seats_available: number;
    active_holds: number;
    bookings_confirmed: number;
    pending_reconciliations: number;
    expired_queue_tokens: number;
    sampled_at: string;
  };
  totals: {
    booking_requests: number;
    successful_bookings: number;
    failed_bookings: number;
    conflicts_prevented: number;
    duplicates_blocked: number;
    seats_released: number;
    payment_success: number;
    payment_failed: number;
    payment_pending: number;
    queue_admissions: number;
    queue_joins: number;
    rate_limit_blocks: number;
    events_recorded: number;
  };
  latency: {
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    samples: number;
    source: string;
  };
  event_type_counts: Record<string, number>;
  series: MetricsSeriesPoint[];
  services: ServiceStatus[];
  active_simulation: {
    run_id: string;
    scenario: string;
    mode: string;
    progress: number;
    total_requests: number;
    progress_pct: number;
  } | null;
  notes: string[];
}

export interface SimulationPreset {
  id: string;
  label: string;
  description: string;
  config: {
    label: string;
    concurrent_requests: number;
    available_seats: number;
    seats_per_request: number;
    arrival_rate_per_second: number;
    payment_failure_pct: number;
    payment_delay_ms: number;
    network_timeout_pct: number;
    hold_seconds: number;
    duplicate_retry_pct: number;
    scenario: string;
  };
}

export interface PresetsResponse {
  presets: SimulationPreset[];
  bounds: Record<string, { min: number; max: number }>;
  modes: { id: string; label: string; description: string }[];
  notes: string[];
}

export interface SimulationRun {
  run_id: string;
  scenario: string;
  scenario_label: string;
  mode: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  progress: number;
  total_requests: number;
  config: Record<string, unknown>;
  summary: SimulationSummary | Record<string, never>;
  schedule_id: number | null;
  seed: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface VerdictCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SimulationSummary {
  run_id: string;
  scenario: string;
  scenario_label: string;
  mode: string;
  config: Record<string, unknown>;
  total_requests: number;
  successful_bookings: number;
  held_bookings: number;
  rejected_or_queued: number;
  conflicts_prevented: number;
  duplicate_retries: number;
  duplicates_handled_safely: number;
  duplicate_bookings_created: number;
  payments: { success: number; failed: number; pending: number; reconciled: number };
  payment_failures: number;
  payment_recoveries: number;
  seats_before: number;
  seats_after: number;
  seats_consumed: number;
  oversold_by: number;
  confirmed_seat_rows: number;
  duration_seconds: number;
  throughput_rps: number;
  latency: {
    samples: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    source: string;
  };
  consistency: {
    schedule_id: number;
    ok: boolean;
    checks: { name: string; passed: boolean; detail: string }[];
  };
  verdict_checks: VerdictCheck[];
  consistency_checks_passed: boolean;
  outcome_breakdown: Record<string, number>;
  expected_max_bookings: number;
  notes: string[];
}

export interface SimulationEventRecord {
  seq: number;
  event_type: string;
  message: string;
  severity: string;
  latency_ms: number | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CorrectnessResult {
  id: string;
  name: string;
  goal: string;
  passed: boolean;
  expected: string;
  actual: string;
  duration_ms: number;
  [key: string]: unknown;
}

export interface CorrectnessSuite {
  suite: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  total: number;
  passed: number;
  failed: number;
  results: CorrectnessResult[];
}

export interface HealthResponse {
  status: string;
  app: string;
  version: string;
  time: string;
  demo_mode: boolean;
  components: {
    database: { status: string; backend?: string };
    cache: { backend: string; connected: boolean; mode: string; simulated: boolean };
    workers: { running: boolean; loops: Record<string, unknown>; simulated: boolean };
    simulation_engine: { status: string; simulated: boolean };
  };
  checks: ServiceStatus[];
}

export interface MetaResponse {
  app_name: string;
  app_version: string;
  demo_mode: boolean;
  database_backend: string;
  cache_backend: string;
  queue_capacity: number;
  queue_admission_rate: number;
  hold_minutes: number;
  class_capacity: Record<string, number>;
  seeded_seats: number;
  disclaimer: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
