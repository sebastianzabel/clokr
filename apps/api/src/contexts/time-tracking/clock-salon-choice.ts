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
 * Rule, in this order (D-02/D-11, Issue #70 — a day may hold several entries):
 * 1. Today has a RUNNING entry → no choice; the answer names the salon of the open entry. The salon
 *    is named only in a multi-salon tenant (#64: a single-salon tenant never sees salon wording).
 * 2. Today has only FINISHED entries → `fixedSalon` is the salon of the closed entry ending last
 *    (what a plain re-clock continues, deactivated or not), and in a multi-salon tenant a second
 *    salon may be chosen, which starts a NEW entry: the active salons except that one are offered,
 *    unless the employee's current and future assignments name exactly that one salon. The pattern
 *    salon of today is preselected when it is one of the offered salons.
 * 3. Today has no entry → the #87 rules unchanged: not a multi-salon tenant → nothing to offer;
 *    otherwise the pattern salon is preselected when it is an active salon, and the choice is offered
 *    unless the current and future assignments name exactly that one salon.
 * 4. The salon list is only returned when a choice is offered (Art. 5 Abs. 1 lit. c DSGVO).
 */
import type { Prisma } from "@clokr/db";
import {
  currentAndFutureAssignmentSalonIds,
  findSalon,
  isMultiSalonTenant,
  listSalons,
  salonForDay,
} from "../platform";
import { findEntriesOfDay, latestEndingClosed, openEntryOf } from "./day-entries";

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

/** An active salon of the tenant as the answer lists it: name (de), then id. */
type SalonOption = { id: string; name: string };

const byNameThenId = (a: SalonOption, b: SalonOption) =>
  a.name.localeCompare(b.name, "de") || (a.id < b.id ? -1 : 1);

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

  // Decision (Issue #70, D-02/D-11): the row a clock event acts on is picked by the shared selectors
  // of day-entries.ts (open row first, else the closed row ending last) — never by a local rule.
  const dayEntries = await findEntriesOfDay(db, { tenantId, employeeId, date: today });
  const running = openEntryOf(dayEntries);
  const dayEntry = running ?? latestEndingClosed(dayEntries);
  if (dayEntry && !multiSalon) return nothingOffered;

  // The entry's own salon, deactivated or not — it is the entry's history.
  let fixedSalon: SalonOption | null = null;
  if (dayEntry) {
    const salon = await findSalon(db, tenantId, dayEntry.salonId);
    fixedSalon = salon ? { id: salon.id, name: salon.name } : null;
    // A running day offers nothing: the open entry names the salon.
    if (running) return { ...nothingOffered, fixedSalon };
  }

  if (!multiSalon) return nothingOffered;

  const allActive = (await listSalons(db, tenantId, { includeInactive: false }))
    .map((salon) => ({ id: salon.id, name: salon.name }))
    .sort(byNameThenId);
  const activeIds = new Set(allActive.map((salon) => salon.id));
  // On a finished day the salon a plain re-clock continues is not offered a second time.
  const active = fixedSalon ? allActive.filter((salon) => salon.id !== fixedSalon.id) : allActive;
  const offeredIds = new Set(active.map((salon) => salon.id));

  const pattern = await salonForDay(db, tenantId, employeeId, now);
  const named = (await currentAndFutureAssignmentSalonIds(db, tenantId, employeeId, now)).filter(
    (id) => activeIds.has(id),
  );
  // A deactivated pattern salon is never preselected: nothing can be clocked into it. On a finished
  // day the pattern salon is preselected only when it is one of the offered salons.
  const preselectedSalonId =
    pattern && activeIds.has(pattern.salonId) && offeredIds.has(pattern.salonId)
      ? pattern.salonId
      : null;

  // "Nothing to choose": the assignments name exactly one salon and it is the one already in use —
  // the fixed salon of a finished day, else the preselected pattern salon.
  const offerChoice =
    active.length > 0 &&
    !(named.length === 1 && named[0] === (fixedSalon ? fixedSalon.id : preselectedSalonId));
  return {
    offerChoice,
    preselectedSalonId,
    salons: offerChoice ? active : [],
    fixedSalon,
  };
}
