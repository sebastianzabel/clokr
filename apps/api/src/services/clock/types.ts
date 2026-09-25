// Phase 76.2 (ARCH-V19-01) — Shared types for the source-agnostic clock-event resolver.
// Per CONTEXT.md D-01: lives in services/clock/ as the first occupant of the services/ folder.
import type { TimeEntry } from "@clokr/db";

export type ClockIntent = "AUTO" | "IN" | "OUT";

export type Actor =
  | { type: "USER"; userId: string }
  | { type: "TERMINAL"; terminalApiKeyId: string }
  | { type: "API_KEY"; apiKeyId: string }
  | { type: "SYSTEM" };

// Note: `source` is `string` (not the Prisma TimeEntrySource enum) so that the
// future-source.test.ts can feed a synthetic 'SYNTHETIC' value through the
// resolver without a schema change. Architectural enforcement of D-05 #10.
//
// Phase 307 Plan 01 (D-01 corrected) — `interactive` and why it exists:
//
// 1. `source` is NOT the current caller's channel on every route. On `/:id/clock-out`
//    (time-entries.ts's build site) it is read as `entry.source` — the channel that CREATED
//    this row, not the one closing it now. Branching the debounce guard on `event.source`
//    would therefore answer "how did this entry come to exist", not "who is clicking
//    'Ausstempeln' right now" — the wrong question for a double-tap guard.
// 2. `interactive` is set by the ADAPTER, never derived by the resolver, because only the
//    adapter knows which channel the CURRENT request arrived on. The resolver reads this one
//    property and does not enumerate sources — future-source.test.ts's guarantee ("adding a
//    sixth source is one new adapter file, no resolver changes") stays intact.
// 3. `interactive` is OPTIONAL on purpose, not for convenience: future-source.test.ts builds a
//    ClockEvent literal without this field and must not be relaxed (its own docstring forbids
//    it). A missing value takes the SAME branch as `interactive: false` — pre-Phase-307
//    behaviour, never the riskier one. Forgetting to set it yields the conservative outcome.
// 4. All five `TimeEntrySource` values (NFC, MOBILE, MANUAL, CORRECTION, WIFI) are covered by
//    this without enumerating any of them here: what matters is the channel of THIS call, not
//    the value stored in the row, so `CORRECTION` needs no special case either.
export type ClockEvent = {
  employeeId: string;
  tenantId: string;
  source: string;
  intent: ClockIntent;
  timestamp: Date;
  date: Date;
  dateStr: string;
  note?: string;
  actor: Actor;
  interactive?: boolean;
};

export type ConflictReason =
  | "ALREADY_CLOCKED_IN"
  | "NOT_CLOCKED_IN"
  | "LEAVE_APPROVED"
  | "MONTH_LOCKED"
  // Phase 118 (D-03): this day's row is coupled to a still-PENDING Zeitnachtrag
  // (Phase 96) — a request, not a punch. An honest 409 instead of a misleading
  // "already clocked in". NOT produced by `decide()`, but by the resolver BEFORE
  // building state (D-05: the state machine stays a pure function with no DB
  // knowledge).
  | "RETRO_PENDING"
  // Phase 68b (issue #68, D-08): the employee has no salon for the day and the tenant has no
  // active salon to fall back to — a new entry cannot carry the required salonId. NOT produced
  // by `decide()`, but by the resolver's START branch before it writes anything.
  | "NO_ACTIVE_SALON";

export type ClockState =
  | { kind: "NO_OPEN_ENTRY" }
  | { kind: "OPEN_ENTRY"; entryId: string; source: string }
  | { kind: "CLOSED_SAME_DAY_ENTRY"; entryId: string; endTime: Date; isLocked: boolean }; // D-01

export type ClockDecision =
  | { kind: "START" }
  | { kind: "STOP"; entryId: string }
  | { kind: "REOPEN"; entryId: string } // D-01
  | { kind: "CONFIRM"; entryId: string }
  | { kind: "CONFLICT"; reason: ConflictReason };

export type ClockResolution =
  | { kind: "CLOCKED_IN"; entry: TimeEntry; audit: { id: string } }
  | { kind: "CLOCKED_OUT"; entry: TimeEntry; audit: { id: string } }
  | { kind: "CONSOLIDATED"; entry: TimeEntry; breakId: string; audit: { id: string } }
  | { kind: "CONFIRMED"; entryId: string; audit: { id: string } }
  | { kind: "DEBOUNCE_NOOP" } // D-02: 60s double-tap guard — STOP within 60s of START is a NO-OP
  | { kind: "CONFLICT"; reason: ConflictReason };
