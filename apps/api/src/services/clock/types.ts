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
};

export type ConflictReason =
  | "ALREADY_CLOCKED_IN"
  | "NOT_CLOCKED_IN"
  | "LEAVE_APPROVED"
  | "MONTH_LOCKED"
  // Phase 118 (D-03): die Tageszeile ist an einen noch PENDING Zeitnachtrag (Phase 96)
  // gekoppelt — ein Antrag, keine Stempelung. Ehrlicher 409 statt eines irrefuehrenden
  // "Bereits eingestempelt". Wird NICHT von `decide()` erzeugt, sondern vom Resolver VOR
  // dem State-Bau (D-05: die State-Machine bleibt eine reine Funktion ohne DB-Wissen).
  | "RETRO_PENDING";

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
