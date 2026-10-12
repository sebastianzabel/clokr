/**
 * Issue #87 (Phase 87b-03), D-02/D-11 — the ONE place the clock-salon decision lives.
 *
 * What the web clock shows about the salon — the preselected pattern salon, whether a choice is
 * offered at all, the salons to choose from, or the salon today's entry is fixed to — is decided
 * here and nowhere else. The web renders this answer and computes no rule.
 *
 * Reads the Unterbau only through `../platform` (salon pattern, assignments, salon list, the
 * multi-salon rule of #64) and today's entries only through `findEntriesOfDay`. This file lives
 * outside `facade/`, like `entry-salon.ts`, so it is not a facade function.
 *
 * The weekly pattern is a PRESELECTION, never truth: a deviation from it is not an error, so
 * nothing in here marks one.
 *
 * Rule, in this order (D-11):
 * 1. Today already has an entry → no choice, the answer names the salon that entry is fixed to
 *    (the row a re-clock would reopen: the open row, else the closed row ending last). The salon
 *    is named only in a multi-salon tenant (#64: a single-salon tenant never sees salon wording).
 * 2. Not a multi-salon tenant → nothing to offer.
 * 3. Otherwise: the pattern salon of today is preselected when it is an active salon; the choice
 *    is offered unless the employee's current and future assignments name exactly that one salon.
 * 4. The salon list is only returned when a choice is offered (Art. 5 Abs. 1 lit. c DSGVO).
 */
import type { Prisma, TimeEntry } from "@clokr/db";
import {
  currentAndFutureAssignmentSalonIds,
  findSalon,
  isMultiSalonTenant,
  listSalons,
  salonForDay,
} from "../platform";
import { findEntriesOfDay } from "./day-entries";

export type ClockSalonChoice = {
  offerChoice: boolean;
  preselectedSalonId: string | null;
  salons: { id: string; name: string }[];
  fixedSalon: { id: string; name: string } | null;
};

export type ClockSalonChoiceInput = {
  tenantId: string;
  employeeId: string;
  /** The request instant — the pattern is asked for this instant's tenant-local day. */
  now: Date;
  /** UTC-midnight of the tenant-local calendar day, as `todayInTz(tz)` returns it. */
  today: Date;
};

/** The row a re-clock would act on: the open row, else the closed row with the latest end. */
function entryOfDay(entries: TimeEntry[]): TimeEntry | null {
  const open = entries.find((e) => e.endTime === null);
  if (open) return open;
  return entries.reduce<TimeEntry | null>(
    (best, e) => (e.endTime !== null && (best === null || e.endTime > best.endTime!) ? e : best),
    null,
  );
}

export async function clockSalonChoice(
  db: Prisma.TransactionClient,
  input: ClockSalonChoiceInput,
): Promise<ClockSalonChoice> {
  const { tenantId, employeeId, now, today } = input;
  const nothingOffered = {
    offerChoice: false,
    preselectedSalonId: null,
    salons: [],
    fixedSalon: null,
  } satisfies ClockSalonChoice;

  const multiSalon = await isMultiSalonTenant(db, tenantId);

  // MULTI-ENTRY: with several entries per day (#70) a second salon would start a new entry instead of being fixed to this one.
  const dayEntry = entryOfDay(await findEntriesOfDay(db, { tenantId, employeeId, date: today }));
  if (dayEntry) {
    if (!multiSalon) return nothingOffered;
    // The entry's own salon, deactivated or not — it is the entry's history.
    const salon = await findSalon(db, tenantId, dayEntry.salonId);
    return {
      ...nothingOffered,
      fixedSalon: salon ? { id: salon.id, name: salon.name } : null,
    };
  }

  if (!multiSalon) return nothingOffered;

  const active = (await listSalons(db, tenantId, { includeInactive: false }))
    .map((salon) => ({ id: salon.id, name: salon.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1));
  const activeIds = new Set(active.map((salon) => salon.id));

  const pattern = await salonForDay(db, tenantId, employeeId, now);
  const named = (await currentAndFutureAssignmentSalonIds(db, tenantId, employeeId, now)).filter(
    (id) => activeIds.has(id),
  );
  // A deactivated pattern salon is never preselected: nothing can be clocked into it.
  const preselectedSalonId = pattern && activeIds.has(pattern.salonId) ? pattern.salonId : null;

  const offerChoice = !(named.length === 1 && named[0] === preselectedSalonId);
  return {
    offerChoice,
    preselectedSalonId,
    salons: offerChoice ? active : [],
    fixedSalon: null,
  };
}
