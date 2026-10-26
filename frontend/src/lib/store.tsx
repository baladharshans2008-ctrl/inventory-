import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PassengerInput, Payment, Reservation } from "./types";

/**
 * Booking session state.
 *
 * Persisted to localStorage on purpose: the virtual queue is
 * server-authoritative, so a browser refresh must be able to resume the same
 * request instead of creating a duplicate one. The queue request key and the
 * reservation idempotency key survive reloads for exactly that reason.
 */

const STORAGE_KEY = "railflow.session.v1";

export interface SearchParams {
  from: string;
  to: string;
  date: string;
  travelClass: string;
  passengers: number;
}

export interface BookingDraft {
  scheduleId: number | null;
  travelClass: string;
  passengers: PassengerInput[];
  contactEmail: string;
  contactPhone: string;
  /** Idempotency key for the booking request - stable across retries. */
  idempotencyKey: string;
}

export interface SessionState {
  search: SearchParams;
  draft: BookingDraft;
  /** Server-issued admission token, if the booking had to queue. */
  queueToken: string | null;
  /** Stable key so re-joining the queue never creates a second slot. */
  queueRequestKey: string | null;
  reservation: Reservation | null;
  payment: Payment | null;
}

function defaultState(): SessionState {
  return {
    search: {
      from: "MAS",
      to: "SBC",
      date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      travelClass: "SL",
      passengers: 1,
    },
    draft: {
      scheduleId: null,
      travelClass: "SL",
      passengers: [{ name: "", age: 30, gender: "Other", berth_preference: "No Preference" }],
      contactEmail: "",
      contactPhone: "",
      idempotencyKey: "",
    },
    queueToken: null,
    queueRequestKey: null,
    reservation: null,
    payment: null,
  };
}

function load(): SessionState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      search: { ...base.search, ...(parsed.search || {}) },
      draft: { ...base.draft, ...(parsed.draft || {}) },
    };
  } catch {
    return defaultState();
  }
}

interface SessionContextValue {
  session: SessionState;
  update: (patch: Partial<SessionState>) => void;
  updateDraft: (patch: Partial<BookingDraft>) => void;
  updateSearch: (patch: Partial<SearchParams>) => void;
  setPassengerCount: (count: number) => void;
  updatePassenger: (index: number, patch: Partial<PassengerInput>) => void;
  /** Returns the existing key, generating one if this is a new attempt. */
  ensureIdempotencyKey: () => string;
  ensureQueueRequestKey: () => string;
  reset: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const GENDERS = ["Male", "Female", "Other"];
const BERTHS = ["No Preference", "Lower", "Middle", "Upper", "Side Lower", "Side Upper"];

export function newIdempotencyKey(): string {
  return `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* storage full or unavailable - the session still works in memory */
    }
  }, [session]);

  const update = useCallback((patch: Partial<SessionState>) => {
    setSession((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateDraft = useCallback((patch: Partial<BookingDraft>) => {
    setSession((prev) => ({ ...prev, draft: { ...prev.draft, ...patch } }));
  }, []);

  const updateSearch = useCallback((patch: Partial<SearchParams>) => {
    setSession((prev) => ({ ...prev, search: { ...prev.search, ...patch } }));
  }, []);

  const setPassengerCount = useCallback((count: number) => {
    setSession((prev) => {
      const passengers = [...prev.draft.passengers];
      while (passengers.length < count) {
        passengers.push({ name: "", age: 30, gender: "Other", berth_preference: "No Preference" });
      }
      return {
        ...prev,
        search: { ...prev.search, passengers: count },
        draft: { ...prev.draft, passengers: passengers.slice(0, count) },
      };
    });
  }, []);

  const updatePassenger = useCallback((index: number, patch: Partial<PassengerInput>) => {
    setSession((prev) => {
      const passengers = prev.draft.passengers.map((p, i) => (i === index ? { ...p, ...patch } : p));
      return { ...prev, draft: { ...prev.draft, passengers } };
    });
  }, []);

  const ensureIdempotencyKey = useCallback(() => {
    if (session.draft.idempotencyKey) return session.draft.idempotencyKey;
    const key = newIdempotencyKey();
    updateDraft({ idempotencyKey: key });
    return key;
  }, [session.draft.idempotencyKey, updateDraft]);

  const ensureQueueRequestKey = useCallback(() => {
    if (session.queueRequestKey) return session.queueRequestKey;
    const key = `qk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    update({ queueRequestKey: key });
    return key;
  }, [session.queueRequestKey, update]);

  const reset = useCallback(() => setSession(defaultState()), []);

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      update,
      updateDraft,
      updateSearch,
      setPassengerCount,
      updatePassenger,
      ensureIdempotencyKey,
      ensureQueueRequestKey,
      reset,
    }),
    [
      session,
      update,
      updateDraft,
      updateSearch,
      setPassengerCount,
      updatePassenger,
      ensureIdempotencyKey,
      ensureQueueRequestKey,
      reset,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export { GENDERS, BERTHS };
