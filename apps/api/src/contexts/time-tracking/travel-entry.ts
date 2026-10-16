/**
 * travel-entry.ts — Issue #92 (Phase 92b), D-05/D-06.
 *
 * The ONE place the travel write rule lives. A travel entry is the time an employee spends on the
 * way from one salon to another on the same day. It is an ordinary closed WORK row whose kind
 * TRAVEL is DERIVED here from the destination (`travelToSalonId`) and never sent by a client; the
 * day kernels (`entryDurations`, `evaluateDayBreaks`), the T1/T2 saldo facade and the
 * working-time account read it like any other closed WORK entry and need no change.
 *
 * Law: a trip between two work sites during the working day on the employer's instruction is
 * working time (§ 2 Abs. 1 ArbZG; BAG 12.12.2012 – 5 AZR 355/12, Rn. 16), the way from home to the
 * first work site and back is not. The validator therefore admits a travel entry only BETWEEN two
 * entries of the same day: one in the departure salon directly before it and one in the arrival
 * salon directly after it. The way from or to home has no such neighbour and is refused.
 *
 * Why the departure salon is `salonId`: the salon of an entry is where the entry's time belongs
 * to for everything that already reads `salonId` (reach, salon view, holiday location); the
 * arrival salon is the new, additional fact `travelToSalonId`.
 *
 * Salon validation is never re-implemented here (CLAUDE.md #68): the departure salon goes through
 * the route's own `resolveEntrySalon` call, the arrival salon through the same building block
 * inside {@link validateTravelEntry}, so a foreign and an unknown id are one code path and answer
 * byte-identically (T-100-09). No package or module gate is read: recording working time is a
 * legal duty (92b-CONTEXT D-08, packages-legal-core isolation of #566).
 */
import type { Prisma, TimeEntry } from "@clokr/db";
import { resolveAccessReach, type AccessContext } from "../platform";
import { findEntriesOfDay } from "./day-entries";
import { dayCoverage } from "./day-scope";
import { listDayBreaksOfDay } from "./day-break-store";
import { intervalsOverlap } from "./day-break-rule";
import { resolveEntrySalon } from "./entry-salon";

// ── Codes and German texts (the only place they are spelled) ──────────────────────────────────
export const TRAVEL_KIND_DERIVED_CODE = "TRAVEL_KIND_DERIVED";
export const TRAVEL_KIND_DERIVED_MESSAGE =
  "Fahrzeit wird über den Zielsalon erfasst, nicht über die Tätigkeitsart.";
export const TRAVEL_SALONS_REQUIRED_CODE = "TRAVEL_SALONS_REQUIRED";
export const TRAVEL_SALONS_REQUIRED_MESSAGE =
  "Für eine Fahrzeit sind Abfahrts- und Zielsalon anzugeben.";
export const TRAVEL_SAME_SALON_CODE = "TRAVEL_SAME_SALON";
export const TRAVEL_SAME_SALON_MESSAGE = "Abfahrts- und Zielsalon müssen verschieden sein.";
export const TRAVEL_SHAPE_CODE = "TRAVEL_SHAPE";
export const TRAVEL_SHAPE_MESSAGE =
  "Eine Fahrzeit hat Beginn und Ende und enthält keine Pausen und keine Tätigkeitsanteile.";
export const TRAVEL_NOT_BETWEEN_SALON_ENTRIES_CODE = "TRAVEL_NOT_BETWEEN_SALON_ENTRIES";
export const TRAVEL_NOT_BETWEEN_SALON_ENTRIES_MESSAGE =
  "Fahrzeit kann nur zwischen einem Eintrag im Abfahrtssalon und einem Eintrag im Zielsalon desselben Tages erfasst werden. Der Weg von zu Hause oder nach Hause ist keine Arbeitszeit.";
export const TRAVEL_NOT_AS_RETRO_REQUEST_CODE = "TRAVEL_NOT_AS_RETRO_REQUEST";
export const TRAVEL_NOT_AS_RETRO_REQUEST_MESSAGE =
  "Fahrzeit kann nicht als Zeitnachtrag beantragt werden. Bitte wenden Sie sich an Ihre Führungskraft.";

export const TRAVEL_OVERLAPS_DAY_BREAK_CODE = "TRAVEL_OVERLAPS_DAY_BREAK";
export const TRAVEL_OVERLAPS_DAY_BREAK_MESSAGE =
  "Die Fahrzeit überschneidet sich mit einer erfassten Pause dieses Tages.";
export const TRAVEL_KIND_IMMUTABLE_CODE = "TRAVEL_KIND_IMMUTABLE";
export const TRAVEL_KIND_IMMUTABLE_MESSAGE =
  "Ein Eintrag kann nachträglich weder in eine Fahrzeit noch aus einer Fahrzeit umgewandelt werden. Bitte löschen Sie den Eintrag und legen Sie ihn neu an.";
export const TRAVEL_NEEDS_NEIGHBOUR_CODE = "TRAVEL_NEEDS_NEIGHBOUR";
export const TRAVEL_NEEDS_NEIGHBOUR_MESSAGE =
  "Dieser Eintrag ist Abfahrts- oder Ankunftseintrag einer Fahrzeit. Bitte ändern oder löschen Sie zuerst die Fahrzeit.";

/** A refusal with the exact status and body the route answers. */
export type TravelRefusal = {
  ok: false;
  status: 400 | 404 | 409;
  body: { error: string; code?: string };
};

const refusal = (status: 400 | 409, code: string, error: string): TravelRefusal => ({
  ok: false,
  status,
  body: { error, code },
});

/**
 * Thrown from inside a writer transaction when {@link validateTravelEntry} refuses, so the
 * transaction rolls back and the route can answer the refusal's exact status and body.
 */
export class TravelRefusalError extends Error {
  constructor(readonly refusal: TravelRefusal) {
    super(refusal.body.error);
    this.name = "TravelRefusalError";
  }
}

/** The request fields {@link classifyTravelWrite} reads. */
export type TravelWriteBody = {
  salonId?: string;
  travelToSalonId?: string;
  endTime?: string | null;
  breakMinutes?: number;
  breaks?: readonly unknown[];
  activityKind?: string;
  activityShares?: readonly unknown[];
};

export type TravelClassification =
  TravelRefusal | { ok: true; travel: false } | { ok: true; travel: true; travelToSalonId: string };

/**
 * Pure: does this request body record a travel entry, and is its shape admissible? (D-06)
 *
 * - A client `activityKind` TRAVEL is refused in EVERY body: the kind is derived from the
 *   destination, so the database CHECK never has to answer it.
 * - No `travelToSalonId` → an ordinary entry (`travel: false`).
 * - With one: both salons must be named and differ; the entry needs a start and an end and carries
 *   no break minutes, no break slots, no activity kind and no activity shares (an empty list is
 *   harmless and tolerated, because a form sends one when nothing was entered).
 */
export function classifyTravelWrite(body: TravelWriteBody): TravelClassification {
  if (body.activityKind === "TRAVEL") {
    return refusal(400, TRAVEL_KIND_DERIVED_CODE, TRAVEL_KIND_DERIVED_MESSAGE);
  }
  if (body.travelToSalonId === undefined) return { ok: true, travel: false };
  if (body.salonId === undefined) {
    return refusal(400, TRAVEL_SALONS_REQUIRED_CODE, TRAVEL_SALONS_REQUIRED_MESSAGE);
  }
  if (body.salonId === body.travelToSalonId) {
    return refusal(400, TRAVEL_SAME_SALON_CODE, TRAVEL_SAME_SALON_MESSAGE);
  }
  if (
    body.endTime === undefined ||
    body.endTime === null ||
    (body.breakMinutes ?? 0) > 0 ||
    (body.breaks?.length ?? 0) > 0 ||
    body.activityKind !== undefined ||
    (body.activityShares?.length ?? 0) > 0
  ) {
    return refusal(400, TRAVEL_SHAPE_CODE, TRAVEL_SHAPE_MESSAGE);
  }
  return { ok: true, travel: true, travelToSalonId: body.travelToSalonId };
}

/** The columns of a day row the anchor rule and the orphan detection read. */
export type TravelDayRow = Pick<
  TimeEntry,
  | "id"
  | "type"
  | "activityKind"
  | "salonId"
  | "travelToSalonId"
  | "startTime"
  | "endTime"
  | "invalidReasonCode"
>;

/** The travel entry about to be written (or kept, on an update): `id` excludes it from its own day. */
export type TravelCandidate = {
  id?: string;
  startTime: Date;
  endTime: Date;
  salonId: string;
  travelToSalonId: string;
};

/**
 * The rows that can anchor a travel entry (T3): the non-deleted WORK rows of the day that are not
 * travel rows themselves and not a pending Zeitnachtrag. A pending Zeitnachtrag is not yet a
 * recorded statement (its rejection or withdrawal soft-deletes it), so it never anchors; a row
 * that is invalid for another reason (missing clock-out, pending leave cancellation) is recorded
 * attendance and does. The caller passes rows that are already non-deleted.
 */
function anchorRows(dayRows: readonly TravelDayRow[], excludeId?: string): TravelDayRow[] {
  return dayRows.filter(
    (r) =>
      r.type === "WORK" &&
      r.activityKind !== "TRAVEL" &&
      r.invalidReasonCode !== "RETRO_APPROVAL_PENDING" &&
      r.id !== excludeId,
  );
}

/**
 * Pure (T3): is the candidate sandwiched between an entry of the departure salon and an entry of
 * the arrival salon of the same day?
 *
 * Among the anchor rows (see {@link anchorRows}):
 * - the predecessor is the closed row with the latest `endTime` at or before the candidate's start
 *   (ties: the later start, then the larger id — deterministic whatever order the list has);
 * - the successor is the row with the earliest `startTime` at or after the candidate's end (ties:
 *   the smaller id); it may still be OPEN, because a running clock-in in the arrival salon is a
 *   real entry.
 *
 * The predecessor's salon must be the departure salon and the successor's salon the arrival salon.
 */
function isAnchored(anchors: readonly TravelDayRow[], candidate: TravelCandidate): boolean {
  const startMs = candidate.startTime.getTime();
  const endMs = candidate.endTime.getTime();

  let predecessor: TravelDayRow | null = null;
  for (const row of anchors) {
    if (row.endTime === null || row.endTime.getTime() > startMs) continue;
    if (
      predecessor === null ||
      row.endTime.getTime() > predecessor.endTime!.getTime() ||
      (row.endTime.getTime() === predecessor.endTime!.getTime() &&
        (row.startTime.getTime() > predecessor.startTime.getTime() ||
          (row.startTime.getTime() === predecessor.startTime.getTime() && row.id > predecessor.id)))
    ) {
      predecessor = row;
    }
  }

  let successor: TravelDayRow | null = null;
  for (const row of anchors) {
    if (row.startTime.getTime() < endMs) continue;
    if (
      successor === null ||
      row.startTime.getTime() < successor.startTime.getTime() ||
      (row.startTime.getTime() === successor.startTime.getTime() && row.id < successor.id)
    ) {
      successor = row;
    }
  }

  return (
    predecessor !== null &&
    successor !== null &&
    predecessor.salonId === candidate.salonId &&
    successor.salonId === candidate.travelToSalonId
  );
}

/**
 * Pure (T3): the write rule for ONE travel candidate against the day's rows — a refusal
 * (409 `TRAVEL_NOT_BETWEEN_SALON_ENTRIES`) when it is not anchored. This is a write rule about
 * neighbouring entries; it decides no gap and never touches the day kernel (`day-break-rule.ts`).
 * Travel rows are skipped as neighbours, so a chain A → B → C of two travel entries is validated
 * against the real work entries around each leg.
 */
export function validateTravelAnchors(
  dayRows: readonly TravelDayRow[],
  candidate: TravelCandidate,
): { ok: true } | TravelRefusal {
  if (isAnchored(anchorRows(dayRows, candidate.id), candidate)) return { ok: true };
  return refusal(
    409,
    TRAVEL_NOT_BETWEEN_SALON_ENTRIES_CODE,
    TRAVEL_NOT_BETWEEN_SALON_ENTRIES_MESSAGE,
  );
}

/**
 * Pure (T6): the ids of the live travel rows of a day that are NOT anchored, in id order. A travel
 * row is a closed WORK row of kind TRAVEL with a destination; the anchor rule is the one of
 * {@link validateTravelAnchors}.
 */
export function travelRowsOrphanedBy(rows: readonly TravelDayRow[]): string[] {
  const anchors = anchorRows(rows);
  const orphans: string[] = [];
  for (const row of rows) {
    if (
      row.type !== "WORK" ||
      row.activityKind !== "TRAVEL" ||
      row.travelToSalonId === null ||
      row.endTime === null ||
      row.invalidReasonCode === "RETRO_APPROVAL_PENDING"
    ) {
      continue;
    }
    const anchored = isAnchored(anchors, {
      startTime: row.startTime,
      endTime: row.endTime,
      salonId: row.salonId,
      travelToSalonId: row.travelToSalonId,
    });
    if (!anchored) orphans.push(row.id);
  }
  return orphans.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The facts of the entry a neighbour check judges (the entry a write would leave behind). */
export type NeighbourWriteRow = {
  /** The stored id when the write rewrites a stored row; absent for a create. */
  id?: string;
  startTime: Date;
  /** `null` for an open entry: it can be a successor anchor, never a predecessor. */
  endTime: Date | null;
  salonId: string;
  type: TimeEntry["type"];
  invalidReasonCode: TimeEntry["invalidReasonCode"];
};

/**
 * Issue #92, T6 (hard block, research Q2): refuse a write that would leave a travel entry of the
 * day without the entries it lies between. A dangling trip would silently count as working time
 * between nothing and nothing — the opposite of the bug this phase fixes — so it is a 409
 * `TRAVEL_NEEDS_NEIGHBOUR` (thrown as {@link TravelRefusalError}, the writer transaction rolls
 * back), never a warning.
 *
 * `without` is the id of the stored row the write removes or rewrites; `with` is the row the write
 * leaves behind (a create, or the resulting state of an update). The day is read ONCE and the
 * write is applied in memory: drop `without`, add `with`. A write that stays on its date is ONE
 * call carrying both (W3); only a write that moves an entry to another date makes TWO calls — the
 * old date with `without`, the new date with `with`. A travel row that was already unanchored before
 * the write (a state no route can produce) does not block an unrelated correction: only travel
 * rows the write would NEWLY orphan are refused.
 *
 * Callers (all inside the writer transaction, after `lockEmployeeForEntryWrite` and next to the
 * 70b overlap re-check, so a concurrent travel POST and a neighbour write are serialised):
 * POST of any non-travel entry on every branch, PUT of a non-travel entry, DELETE, the Zeitnachtrag
 * approval (ONE call: the coupled row's stored state as `without`, its released and possibly
 * corrected state as `with` — the approval never moves the date), the revalidate correction, and
 * the CSV import (`with`). A travel entry itself is judged by {@link validateTravelEntry}.
 *
 * Why no other writer needs the hook: a clock START at an instant after a travel row but before
 * its successor creates an open row that, under the 70b `checkOverlap`, runs to the end of its
 * date and therefore overlaps the successor — refused as ENTRY_OVERLAP; REOPEN and STOP never move
 * a start; consolidation never merges across a travel row (92b-03); a rejected or withdrawn
 * Zeitnachtrag only removes a pending row, which never anchors.
 */
export async function checkTravelNeighbours(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    employeeId: string;
    /** The UTC-midnight `Date` of the calendar day, as stored in `TimeEntry.date`. */
    date: Date;
    without?: string;
    with?: NeighbourWriteRow;
  },
): Promise<void> {
  const stored = await findEntriesOfDay(tx, {
    tenantId: params.tenantId,
    employeeId: params.employeeId,
    date: params.date,
  });
  const before = new Set(travelRowsOrphanedBy(stored));

  const after: TravelDayRow[] = stored.filter(
    (r) => r.id !== params.without && r.id !== params.with?.id,
  );
  if (params.with) {
    after.push({
      id: params.with.id ?? "candidate-row",
      type: params.with.type,
      activityKind: "UNSPECIFIED",
      salonId: params.with.salonId,
      travelToSalonId: null,
      startTime: params.with.startTime,
      endTime: params.with.endTime,
      invalidReasonCode: params.with.invalidReasonCode,
    });
  }
  const newlyOrphaned = travelRowsOrphanedBy(after).filter((id) => !before.has(id));
  if (newlyOrphaned.length > 0) {
    throw new TravelRefusalError(
      refusal(409, TRAVEL_NEEDS_NEIGHBOUR_CODE, TRAVEL_NEEDS_NEIGHBOUR_MESSAGE),
    );
  }
}

/** The request fields {@link classifyTravelUpdate} reads (the PUT body). */
export type TravelUpdateBody = {
  salonId?: string;
  travelToSalonId?: string;
  endTime?: string | null;
  breakMinutes?: number;
  breaks?: readonly unknown[];
  activityKind?: string;
  activityShares?: readonly unknown[];
};

/** The stored fields {@link classifyTravelUpdate} compares the body against. */
export type TravelUpdateExisting = {
  activityKind: string;
  salonId: string;
  travelToSalonId: string | null;
};

/**
 * Pure (D-06): may this PUT body change this stored entry? A travel entry is immutable in KIND:
 * its times, note and both salons can change, but it never becomes another kind and no other entry
 * becomes travel (`TRAVEL_KIND_IMMUTABLE`); a client `activityKind` TRAVEL is refused everywhere
 * (`TRAVEL_KIND_DERIVED`, the kind is derived from the destination); a travel entry stays closed,
 * carries no break and no activity share (`TRAVEL_SHAPE`) and keeps two different salons
 * (`TRAVEL_SAME_SALON`). `travel` tells the route whether the stored row is a travel row.
 */
export function classifyTravelUpdate(
  body: TravelUpdateBody,
  existing: TravelUpdateExisting,
): TravelRefusal | { ok: true; travel: boolean } {
  if (body.activityKind === "TRAVEL") {
    return refusal(400, TRAVEL_KIND_DERIVED_CODE, TRAVEL_KIND_DERIVED_MESSAGE);
  }
  const isTravel = existing.activityKind === "TRAVEL";
  if (!isTravel) {
    if (body.travelToSalonId !== undefined) {
      return refusal(400, TRAVEL_KIND_IMMUTABLE_CODE, TRAVEL_KIND_IMMUTABLE_MESSAGE);
    }
    return { ok: true, travel: false };
  }
  if (body.activityKind !== undefined) {
    return refusal(400, TRAVEL_KIND_IMMUTABLE_CODE, TRAVEL_KIND_IMMUTABLE_MESSAGE);
  }
  if (
    (body.activityShares?.length ?? 0) > 0 ||
    (body.breakMinutes ?? 0) > 0 ||
    (body.breaks?.length ?? 0) > 0 ||
    ("endTime" in body && !body.endTime)
  ) {
    return refusal(400, TRAVEL_SHAPE_CODE, TRAVEL_SHAPE_MESSAGE);
  }
  const departure = body.salonId ?? existing.salonId;
  const arrival = body.travelToSalonId ?? existing.travelToSalonId;
  if (departure === arrival) {
    return refusal(400, TRAVEL_SAME_SALON_CODE, TRAVEL_SAME_SALON_MESSAGE);
  }
  return { ok: true, travel: true };
}

/** The permissions a travel write is judged under (the reach of the write over the whole day). */
export type TravelWritePermission =
  | "time-entry:create:ZUGEWIESEN"
  | "time-entry:update:ZUGEWIESEN"
  | "time-entry:revalidate:ZUGEWIESEN";

export type ValidateTravelEntryInput = {
  tenantId: string;
  employeeId: string;
  /** The UTC-midnight `Date` of the tenant-local calendar day, as stored in `TimeEntry.date`. */
  date: Date;
  startTime: Date;
  endTime: Date;
  /** The departure salon — already validated by the route's own `resolveEntrySalon` call. */
  salonId: string;
  travelToSalonId: string;
  /** The travel entry being updated, excluded from its own day. */
  excludeEntryId?: string;
  /**
   * Validate the arrival salon (exists in the tenant and is active). Always on create; on an update
   * only when the destination changed, so a salon deactivated after the trip never blocks a time or
   * note correction of an old travel entry.
   */
  validateArrivalSalon: boolean;
  /** The caller of the write (reach and "is it their own day"). */
  access: AccessContext;
  callerEmployeeId: string | null;
  /** The permission the route checked for this write; its reach must cover EVERY entry of the day. */
  permission: TravelWritePermission;
  /**
   * The 404 text the route already answers for a target outside the caller's reach, so the
   * refusal is indistinguishable from a target that does not exist.
   */
  outOfReachMessage: string;
};

/**
 * The write rule of a travel entry, run inside the writer transaction after the Employee row lock
 * and the overlap re-check. In this order, so an out-of-reach caller never learns anything about
 * the day:
 *
 *  1. salons — the arrival salon through `resolveEntrySalon` (the one place of the explicit-salon
 *     rule; 404 for a foreign and an unknown id alike, 400 for a deactivated one);
 *  2. reach — the person themself, or a writer whose ZUGEWIESEN reach covers EVERY non-deleted
 *     entry of the day (`dayCoverage` = "all", the rule of the day-break routes: a travel entry
 *     ties two entries of the day together, so it is a statement about the day). Otherwise the
 *     refusal is the route's own not-found answer for an unreachable target — never a 409 that
 *     would reveal whether an out-of-reach entry exists;
 *  3. T3 — the anchors (departure `salonId` directly before, arrival `travelToSalonId` directly
 *     after; a pending Zeitnachtrag never anchors);
 *  4. T4 — no overlap with a recorded DayBreak of the day (a DayBreak lives in a gap, and a
 *     recorded trip fills it; D-09).
 *
 * Why the departure salon is `salonId`: see the module docblock.
 */
export async function validateTravelEntry(
  db: Prisma.TransactionClient,
  input: ValidateTravelEntryInput,
): Promise<{ ok: true } | TravelRefusal> {
  if (input.validateArrivalSalon) {
    const arrival = await resolveEntrySalon(db, {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      startTime: input.startTime,
      explicitSalonId: input.travelToSalonId,
    });
    if (!arrival.ok) {
      return { ok: false, status: arrival.status as 400 | 404, body: arrival.body };
    }
  }
  const dayRows = await findEntriesOfDay(db, {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    date: input.date,
  });

  if (input.employeeId !== input.callerEmployeeId) {
    const reach = await resolveAccessReach(db, input.access, input.permission);
    const coverage = await dayCoverage(
      db,
      input.tenantId,
      reach,
      dayRows.map((r) => ({ salonId: r.salonId, employeeId: r.employeeId, date: r.date })),
    );
    if (coverage !== "all") {
      return { ok: false, status: 404, body: { error: input.outOfReachMessage } };
    }
  }

  const anchored = validateTravelAnchors(dayRows, {
    id: input.excludeEntryId,
    startTime: input.startTime,
    endTime: input.endTime,
    salonId: input.salonId,
    travelToSalonId: input.travelToSalonId,
  });
  if (!anchored.ok) return anchored;

  const dayBreaks = await listDayBreaksOfDay(db, {
    tenantId: input.tenantId,
    employeeId: input.employeeId,
    date: input.date,
  });
  const interval = { startTime: input.startTime, endTime: input.endTime };
  if (dayBreaks.some((b) => intervalsOverlap(b, interval))) {
    return refusal(409, TRAVEL_OVERLAPS_DAY_BREAK_CODE, TRAVEL_OVERLAPS_DAY_BREAK_MESSAGE);
  }
  return { ok: true };
}
