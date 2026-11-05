/**
 * travel-offer.ts — Issue #660.
 *
 * The ONE place the travel offer of the day check is built: for an unclear cross-salon gap
 * (`certainty` UNCLEAR, "Fahrzeit oder Pause?") the day check offers to record the gap as a trip,
 * and the action is the unchanged `POST /api/v1/time-entries` travel path (Issue #92).
 *
 * This module decides nothing the write does not re-decide. The offer is assembled from the pieces
 * of the travel write rule itself: the kernel's own gap list (never recomputed here), the pure
 * anchor check {@link validateTravelAnchors}, the one reach predicate {@link travelWriteCoversDay}
 * and the one explicit-salon rule `resolveEntrySalon`. A gap qualifies only when
 *
 *  - it lies between two entries of DIFFERENT salons (the entry before is the departure, the entry
 *    after the arrival) and the day carries an UNCLEAR placement finding,
 *  - no recorded day break overlaps it (the half-open rule the write asks of the database),
 *  - neither neighbour is a recorded trip or a pending Zeitnachtrag (a gap touching a trip is
 *    answered by that trip; a pending row is no recorded statement),
 *  - the caller may write the trip (create right, reach over EVERY entry of the day) and, on the
 *    person's own day, the day lies inside the retro window (a trip is never a Zeitnachtrag),
 *  - both salons are active salons of the tenant.
 *
 * A client that sends an offer back is still judged by the write rule, which checks the anchors,
 * the overlap and the day breaks - not that the interval equals the gap it was computed from. The
 * web therefore re-loads the day check right before writing and posts only an offer that is still
 * served (identical interval and salon pair); the rest of the race and every other refusal are the
 * write rule's answer. This module issues no Prisma call of its own and never
 * reads a figure file: the day kernels, the saldo and the reports do not know it exists.
 */
import type { FastifyInstance } from "fastify";
import type { PermissionReach, AccessContext } from "../platform";
import { listSalons } from "../platform";
import { intervalsOverlap, type DayBreakEvaluation, type DayBreakInterval } from "./day-break-rule";
import { findEntriesOfDay, hasPendingRetroMarker } from "./day-entries";
import { resolveEntrySalon } from "./entry-salon";
import { computeRetroLimitStr, getRetroEntryWindowDays } from "./retro-config";
import { travelWriteCoversDay, validateTravelAnchors } from "./travel-entry";

/** One offer: the exact gap interval, departure and arrival salon (ids are control values, names display). */
export type TravelOffer = {
  startTime: Date;
  endTime: Date;
  departureSalonId: string;
  arrivalSalonId: string;
  departureSalonName: string;
  arrivalSalonName: string;
};

/** Request-level inputs; the lazy reads inside are memoised so a range pays for them at most once. */
export type TravelOfferContext = {
  db: FastifyInstance["prisma"];
  tenantId: string;
  /** The employee whose days are checked. */
  employeeId: string;
  access: AccessContext;
  callerEmployeeId: string | null;
  /** The caller's `time-entry:create` reach, `null` when they hold none. */
  createReach: PermissionReach | null;
  /** Tenant time zone (only used for the retro window of the person's own day). */
  tz: string;
  /** Active salons of the tenant, id -> name; read at most once per request. */
  salonNames: () => Promise<ReadonlyMap<string, string>>;
  /** Earliest day (`YYYY-MM-DD`, tenant time) the person may still write themself; read at most once. */
  retroLimit: () => Promise<string>;
};

export function createTravelOfferContext(
  input: Omit<TravelOfferContext, "salonNames" | "retroLimit">,
): TravelOfferContext {
  let names: Promise<ReadonlyMap<string, string>> | undefined;
  let limit: Promise<string> | undefined;
  return {
    ...input,
    salonNames: () => {
      names ??= listSalons(input.db, input.tenantId, { includeInactive: false }).then(
        (salons) => new Map(salons.map((s) => [s.id, s.name])),
      );
      return names;
    },
    retroLimit: () => {
      limit ??= getRetroEntryWindowDays(input.db, input.tenantId).then((days) =>
        computeRetroLimitStr(input.tz, days),
      );
      return limit;
    },
  };
}

/** The offers of one full-detail, unlocked day, in kernel gap order; `[]` whenever there is none. */
export async function travelOffersOfDay(
  ctx: TravelOfferContext,
  day: {
    dateKey: string;
    /** UTC-midnight `Date` of the day, as stored in `TimeEntry.date`. */
    date: Date;
    evaluation: DayBreakEvaluation;
    dayBreaks: readonly DayBreakInterval[];
  },
): Promise<TravelOffer[]> {
  // The route gate of POST /time-entries: the own day needs the create right at any reach, another
  // person's day needs reach ZUGEWIESEN.
  if (ctx.createReach === null) return [];
  const isOwnDay = ctx.employeeId === ctx.callerEmployeeId;
  if (!isOwnDay && ctx.createReach !== "ZUGEWIESEN") return [];

  if (!day.evaluation.placement.findings.some((f) => f.certainty === "UNCLEAR")) return [];
  const candidates = day.evaluation.gaps.filter(
    (g) => g.crossSalon && !day.dayBreaks.some((b) => intervalsOverlap(b, g)),
  );
  if (candidates.length === 0) return [];

  // The person's own day outside the retro window would be refused by the write (403
  // RETRO_WINDOW_EXCEEDED), and a trip is never a Zeitnachtrag; another person's day is exempt.
  if (isOwnDay && day.dateKey < (await ctx.retroLimit())) return [];

  const dayRows = await findEntriesOfDay(ctx.db, {
    tenantId: ctx.tenantId,
    employeeId: ctx.employeeId,
    date: day.date,
  });
  const mayWrite = await travelWriteCoversDay(ctx.db, {
    tenantId: ctx.tenantId,
    employeeId: ctx.employeeId,
    access: ctx.access,
    callerEmployeeId: ctx.callerEmployeeId,
    permission: "time-entry:create:ZUGEWIESEN",
    dayRows,
  });
  if (!mayWrite) return [];

  const offers: TravelOffer[] = [];
  for (const gap of candidates) {
    const previous = dayRows.find((r) => r.id === gap.previousEntryId);
    const next = dayRows.find((r) => r.id === gap.nextEntryId);
    if (!previous || !next) continue;
    if (previous.activityKind === "TRAVEL" || next.activityKind === "TRAVEL") continue;
    if (hasPendingRetroMarker(previous) || hasPendingRetroMarker(next)) continue;

    const anchored = validateTravelAnchors(dayRows, {
      startTime: gap.startTime,
      endTime: gap.endTime,
      salonId: previous.salonId,
      travelToSalonId: next.salonId,
    });
    if (!anchored.ok) continue;

    // Both salons must pass the one explicit-salon rule (same tenant, active), else the write
    // would answer 400 SALON_INACTIVE.
    let salonsOk = true;
    for (const salonId of [previous.salonId, next.salonId]) {
      const resolved = await resolveEntrySalon(ctx.db, {
        tenantId: ctx.tenantId,
        employeeId: ctx.employeeId,
        startTime: gap.startTime,
        explicitSalonId: salonId,
      });
      if (!resolved.ok) salonsOk = false;
    }
    if (!salonsOk) continue;

    const names = await ctx.salonNames();
    const departureSalonName = names.get(previous.salonId);
    const arrivalSalonName = names.get(next.salonId);
    if (departureSalonName === undefined || arrivalSalonName === undefined) continue;

    offers.push({
      startTime: gap.startTime,
      endTime: gap.endTime,
      departureSalonId: previous.salonId,
      arrivalSalonId: next.salonId,
      departureSalonName,
      arrivalSalonName,
    });
  }
  return offers;
}
