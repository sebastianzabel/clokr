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
import { findEntriesOfDay } from "./day-entries";
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

/** The columns of a day row the anchor rule reads. */
type AnchorRow = Pick<
  TimeEntry,
  "id" | "type" | "activityKind" | "salonId" | "startTime" | "endTime"
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
 * Pure (T3): is the candidate sandwiched between an entry of the departure salon and an entry of
 * the arrival salon of the same day?
 *
 * Among the day's WORK rows that are NOT travel rows and not the candidate itself:
 * - the predecessor is the closed row with the latest `endTime` at or before the candidate's start
 *   (ties: the later start, then the larger id — deterministic whatever order the list has);
 * - the successor is the row with the earliest `startTime` at or after the candidate's end (ties:
 *   the smaller id); it may still be OPEN, because a running clock-in in the arrival salon is a
 *   real entry.
 *
 * The predecessor's salon must be the departure salon and the successor's salon the arrival salon.
 * This is a write rule about neighbouring entries; it decides no gap and never touches the day
 * kernel (`day-break-rule.ts`). Travel rows are skipped as neighbours, so a chain A → B → C of two
 * travel entries is validated against the real work entries around each leg.
 */
export function validateTravelAnchors(
  dayRows: readonly AnchorRow[],
  candidate: TravelCandidate,
): { ok: true } | TravelRefusal {
  const work = dayRows.filter(
    (r) => r.type === "WORK" && r.activityKind !== "TRAVEL" && r.id !== candidate.id,
  );
  const startMs = candidate.startTime.getTime();
  const endMs = candidate.endTime.getTime();

  let predecessor: AnchorRow | null = null;
  for (const row of work) {
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

  let successor: AnchorRow | null = null;
  for (const row of work) {
    if (row.startTime.getTime() < endMs) continue;
    if (
      successor === null ||
      row.startTime.getTime() < successor.startTime.getTime() ||
      (row.startTime.getTime() === successor.startTime.getTime() && row.id < successor.id)
    ) {
      successor = row;
    }
  }

  if (
    predecessor === null ||
    successor === null ||
    predecessor.salonId !== candidate.salonId ||
    successor.salonId !== candidate.travelToSalonId
  ) {
    return refusal(
      409,
      TRAVEL_NOT_BETWEEN_SALON_ENTRIES_CODE,
      TRAVEL_NOT_BETWEEN_SALON_ENTRIES_MESSAGE,
    );
  }
  return { ok: true };
}

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
};

/**
 * The write rule of a travel entry, run inside the writer transaction after the Employee row lock
 * and the overlap re-check: the arrival salon (through `resolveEntrySalon`, the one place of the
 * explicit-salon rule) and then the neighbour anchors of the day. It reads nothing else.
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
  return validateTravelAnchors(dayRows, {
    id: input.excludeEntryId,
    startTime: input.startTime,
    endTime: input.endTime,
    salonId: input.salonId,
    travelToSalonId: input.travelToSalonId,
  });
}
