import { api, ApiError } from "./api";
import type { Reservation } from "./types";
import type { BookingDraft } from "./store";

export interface BookingResult {
  ok: true;
  reservation: Reservation;
  created: boolean;
  message: string;
  latencyMs: number;
}

export interface BookingConflict {
  ok: false;
  reason: "queue_required" | "seat_unavailable" | "invalid" | "error";
  error: ApiError;
}

/**
 * Submits the booking draft to the authoritative endpoint.
 *
 * The idempotency key lives in the session, so pressing the button twice - or
 * retrying after a network failure - returns the original reservation instead
 * of creating a second booking.
 */
export async function submitReservation(
  draft: BookingDraft,
  idempotencyKey: string,
  queueToken?: string | null,
): Promise<BookingResult | BookingConflict> {
  if (!draft.scheduleId) {
    return {
      ok: false,
      reason: "invalid",
      error: new ApiError(400, "invalid_request", "Select a train before booking."),
    };
  }
  const passengers = draft.passengers.map((p) => ({
    name: p.name.trim(),
    age: Number(p.age),
    gender: p.gender,
    berth_preference: p.berth_preference,
  }));

  if (passengers.some((p) => p.name.length === 0 || !p.age || p.age < 1)) {
    return {
      ok: false,
      reason: "invalid",
      error: new ApiError(400, "invalid_request", "Every passenger needs a name and a valid age."),
    };
  }

  try {
    const response = await api.createReservation({
      schedule_id: draft.scheduleId,
      travel_class: draft.travelClass,
      passengers,
      idempotency_key: idempotencyKey,
      queue_token: queueToken ?? null,
      contact_email: draft.contactEmail || null,
      contact_phone: draft.contactPhone || null,
    });
    return {
      ok: true,
      reservation: response.reservation,
      created: response.created,
      message: response.message,
      latencyMs: response.latency_ms,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.isQueueRequired) return { ok: false, reason: "queue_required", error: err };
      if (err.status === 409) return { ok: false, reason: "seat_unavailable", error: err };
      if (err.status === 422 || err.status === 400) return { ok: false, reason: "invalid", error: err };
      return { ok: false, reason: "error", error: err };
    }
    throw err;
  }
}

export function isComplete(draft: BookingDraft): boolean {
  return (
    draft.passengers.length > 0 &&
    draft.passengers.every((p) => p.name.trim().length > 1 && Number(p.age) >= 1 && Number(p.age) <= 120)
  );
}
