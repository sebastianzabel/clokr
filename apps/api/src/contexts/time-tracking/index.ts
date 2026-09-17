/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Zeiterfassung's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance` — `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across a facade. Reading functions carry
 * `deletedAt: null`; the named compliance functions (DSGVO Art. 17 anonymisation, hard delete,
 * retention archival) deliberately omit it and say so in their own docblock — a blanket guard
 * would be a compliance regression, not an improvement.
 *
 * Wave 4 (Plan 08) — `TimeEntry`/`Break` (T1-T12, plus the T2 regrouping — see
 * `./facade/time-entries.ts`'s own module header). Wave 4 (Plan 09, closing) — `PresenceDevice`
 * (see `./facade/presence-devices.ts`'s own module header). Zeiterfassung is converted whole.
 */
export {
  getValidWorkedEntriesInRange,
  getWorkedEntriesInRange,
  getRecordedWorkEntriesInRange,
  getClaimedEntryDatesInRange,
  countLockedEntries,
  getInvalidEntries,
  getEntryActivityFeed,
  revalidateLeaveCancellationEntries,
  lockEntriesForMonth,
  unlockEntriesForMonth,
  archiveEntriesBefore,
  clearEntryNotesForEmployee,
  hardDeleteTimeDataForEmployee,
  createImportedTimeEntry,
  type ImportedTimeEntryData,
} from "./facade/time-entries";
export {
  listPresenceDevices,
  findPresenceDeviceByMac,
  createPresenceDevice,
  getPresenceDevice,
  deletePresenceDevice,
  type CreatePresenceDeviceData,
} from "./facade/presence-devices";

// ── ArbZG §4 break-constant values (issue #246, E-6) ─────────────────────────────────────────
// Declared public: a constant carries no query semantics, no soft-delete guard, no tenant scope
// — the number itself IS the invariant, so a value re-export needs no facade function around it.
export {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
} from "./break-constants";

// ── Phase 101B (Issue #101, wave 8) — the remaining time-tracking deep imports widened onto ────
// this surface so no production file outside `contexts/time-tracking` reaches into a leaf module
// directly any more, except the one permanent register site (E-2; see
// `apps/api/scripts/context-boundary-import-exceptions.json`).
//
// getEffectiveSchedule is DEFINED in ./entry-invariants (the leaf plan 04 lifted it into) —
// sourced from there, never from ./api/time-entries, so this index never has to publish a route
// module's whole import set.
export { getEffectiveSchedule } from "./entry-invariants";
export { getEffectiveBreakDuration } from "./break-effective";
export type { BreakEmployeeShape, BreakTenantConfigShape } from "./break-effective";
export { resolvePresenceState, isObligatedWorkday, isDayDue } from "./presence";
export type { PresenceEntry, PresenceLeave, PresenceAbsence } from "./presence";
export {
  findUnconfirmedBreakDays,
  unconfirmedDaysFromEntries,
} from "./find-unconfirmed-break-days";

// validateTimeEntryInvariants is deliberately NOT exported here. Its only caller outside this
// context is platform/api/imports.ts, which is E-2 in ADR 0001 Eintrag H — the importer writing
// directly into time-tracking, a defect Block 2 (#102-#104) replaces with an event. Exporting it
// would make that import legal and would delete the only mechanical marker the defect has.
// This surface publishes ./entry-invariants, a leaf module, never ./api/time-entries — Phase 101B
// plan 04 lifted these helpers out of the route file for exactly that reason.
