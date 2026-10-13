/**
 * Issue #568 — the tenant-wide "apply the default working time to existing employees" flow.
 *
 * Why this module exists. On 04.10.2026 the one-step bulk apply turned an individual 16 h Mo-Do
 * contract into 40 h Mo-Fr, retroactively, without a preview or a confirmation. Agreed working time
 * is contract content (§ 611a BGB): a bulk apply is a data-entry convenience for a change that was
 * AGREED, never a decision by itself. A change of an essential condition must be communicated at
 * the latest on the day it takes effect (§ 3 Satz 1 NachwG), so a bulk change never takes effect
 * retroactively.
 *
 * The rules, each in one place (D-01 .. D-05):
 *   - The set of employees a bulk apply may touch is computed by the SERVER (`classifyBulkApplyCandidates`),
 *     from the stored tenant defaults, the proposed values, the workforce and every contract row.
 *     The client only selects inside that set.
 *   - Individual contracts (a contract that differs from the stored defaults) are never selected
 *     by default (`defaultSelected`), they have to be ticked explicitly.
 *   - The preview carries a fingerprint (`bulkApplyFingerprint`) over everything the classification
 *     read; the apply recomputes it inside its own transaction and refuses a stale one.
 *   - The effective date is a month-first, never before the tenant-local today and never more than
 *     12 months ahead (`effectiveFromWindow` / `checkEffectiveFrom`).
 *
 * The preview route and the apply path (`api/settings.ts`) both call this module, so a preview can
 * never promise something the apply would compute differently. The module is PURE: no Prisma, no
 * Fastify, no clock — `today` is always a parameter. Business-rule rejections are returned or thrown
 * as `BulkApplyRejection` and mapped to an explicit reply code by the caller, never to a Zod issue.
 */
import { createHash } from "node:crypto";
import { isMonthFirstDate, MONTH_FIRST_ERROR, snapToMonthFirstUtc } from "./month-first-date";
import { normalizeWorkDays, type PerDayHours } from "./calculate-work-days";
// Pure date formatter of the Arbeitszeitkonto timezone module — the one place a tenant-local
// calendar day is derived from an instant (Issue #568 review WR-01).
import { dateStrInTz } from "../working-time-account";

// ── German messages ──────────────────────────────────────────────────────────────────────────

export const BULK_APPLY_STALE_MESSAGE =
  "Die Vorschau ist veraltet – Mitarbeiter, Verträge oder Vorgaben haben sich geändert. Bitte die Vorschau neu laden und erneut bestätigen.";
export const BULK_APPLY_SELECTION_REQUIRED_MESSAGE =
  "Die Übernahme auf bestehende Mitarbeiter braucht die bestätigte Vorschau: Bitte die Vorschau öffnen, Mitarbeiter auswählen und bestätigen.";

export type BulkApplyRejectionCode =
  | "BULK_APPLY_SELECTION_REQUIRED"
  | "BULK_APPLY_NOT_MONTH_FIRST"
  | "BULK_APPLY_RETROACTIVE"
  | "BULK_APPLY_TOO_FAR"
  | "BULK_APPLY_PREVIEW_STALE";

/** A business-rule refusal of the preview or the apply; the caller maps it to `{ error, code }`. */
export class BulkApplyRejection extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: BulkApplyRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "BulkApplyRejection";
  }
}

// ── numbers ──────────────────────────────────────────────────────────────────────────────────

/**
 * Both sides of every numeric compare go through this: the columns have scale 2, so an unrounded
 * body value (7.555) would never equal the stored 7.56 and a contract could never "match".
 */
export function num2(v: unknown): number {
  return Math.round(Number(v) * 100) / 100;
}

// ── value shapes ─────────────────────────────────────────────────────────────────────────────

/** The working-time part of the tenant defaults, as plain numbers (the `tenantConfigSchema` names). */
export interface WorkingTimeDefaults {
  defaultWeeklyHours: number;
  defaultMondayHours: number;
  defaultTuesdayHours: number;
  defaultWednesdayHours: number;
  defaultThursdayHours: number;
  defaultFridayHours: number;
  defaultSaturdayHours: number;
  defaultSundayHours: number;
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
  defaultWorkDays: number[];
}

/**
 * Mirrors the `TenantConfig` column defaults in `packages/db/prisma/schema.prisma`
 * (`defaultWeeklyHours` 40, `default{Mon..Fri}Hours` 8, `default{Sat,Sun}Hours` 0,
 * `overtimeThreshold` 60, `allowOvertimePayout` false, `defaultWorkDays` [1..5]) — what a tenant
 * without a config row has.
 */
export const SCHEMA_WORKING_TIME_DEFAULTS: WorkingTimeDefaults = {
  defaultWeeklyHours: 40,
  defaultMondayHours: 8,
  defaultTuesdayHours: 8,
  defaultWednesdayHours: 8,
  defaultThursdayHours: 8,
  defaultFridayHours: 8,
  defaultSaturdayHours: 0,
  defaultSundayHours: 0,
  overtimeThreshold: 60,
  allowOvertimePayout: false,
  defaultWorkDays: [1, 2, 3, 4, 5],
};

/** The terms a contract row carries that the bulk apply writes (what preview shows as before/after). */
export interface ContractValues {
  weeklyHours: number | null;
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
  workDays: number[];
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
}

/** A stored `WorkSchedule` row; Decimal columns arrive as Prisma `Decimal` and are typed `unknown`. */
export interface BulkScheduleRow {
  id: string;
  type: string;
  validFrom: Date;
  weeklyHours: unknown;
  mondayHours: unknown;
  tuesdayHours: unknown;
  wednesdayHours: unknown;
  thursdayHours: unknown;
  fridayHours: unknown;
  saturdayHours: unknown;
  sundayHours: unknown;
  overtimeThreshold: unknown;
  allowOvertimePayout: boolean;
  workDays: number[];
  overtimeMode: string;
  maxNegativeBalanceMinutes: number | null;
}

export interface BulkEmployeeInput {
  id: string;
  firstName: string;
  lastName: string;
  employeeNumber: string;
  workSchedules: BulkScheduleRow[];
}

/** The stored `TenantConfig` fields the bulk apply reads (all Decimal-like values are `unknown`). */
export interface StoredWorkingTimeRow {
  defaultWeeklyHours: unknown;
  defaultMondayHours: unknown;
  defaultTuesdayHours: unknown;
  defaultWednesdayHours: unknown;
  defaultThursdayHours: unknown;
  defaultFridayHours: unknown;
  defaultSaturdayHours: unknown;
  defaultSundayHours: unknown;
  overtimeThreshold: unknown;
  allowOvertimePayout: boolean;
  defaultWorkDays: number[];
}

/** The working-time keys of a request body (preview or PUT); every key is optional. */
export type ProposedWorkingTimeBody = Partial<WorkingTimeDefaults>;

/** The stored defaults of a tenant as plain numbers; no config row means the schema defaults (O4). */
export function storedWorkingTimeDefaults(row: StoredWorkingTimeRow | null): WorkingTimeDefaults {
  if (!row) return { ...SCHEMA_WORKING_TIME_DEFAULTS, defaultWorkDays: [1, 2, 3, 4, 5] };
  return {
    defaultWeeklyHours: num2(row.defaultWeeklyHours),
    defaultMondayHours: num2(row.defaultMondayHours),
    defaultTuesdayHours: num2(row.defaultTuesdayHours),
    defaultWednesdayHours: num2(row.defaultWednesdayHours),
    defaultThursdayHours: num2(row.defaultThursdayHours),
    defaultFridayHours: num2(row.defaultFridayHours),
    defaultSaturdayHours: num2(row.defaultSaturdayHours),
    defaultSundayHours: num2(row.defaultSundayHours),
    overtimeThreshold: num2(row.overtimeThreshold),
    allowOvertimePayout: row.allowOvertimePayout,
    defaultWorkDays: [...row.defaultWorkDays],
  };
}

/**
 * The proposed defaults: the request values merged over the STORED tenant defaults. An omitted key
 * keeps the stored value — never the employee's value, never a hard-coded 40/8 (O4).
 */
export function mergeProposedDefaults(
  stored: WorkingTimeDefaults,
  body: ProposedWorkingTimeBody,
): WorkingTimeDefaults {
  const merged: WorkingTimeDefaults = { ...stored, defaultWorkDays: [...stored.defaultWorkDays] };
  const numberKeys = [
    "defaultWeeklyHours",
    "defaultMondayHours",
    "defaultTuesdayHours",
    "defaultWednesdayHours",
    "defaultThursdayHours",
    "defaultFridayHours",
    "defaultSaturdayHours",
    "defaultSundayHours",
    "overtimeThreshold",
  ] as const;
  for (const key of numberKeys) {
    const value = body[key];
    if (value !== undefined) merged[key] = num2(value);
  }
  if (body.allowOvertimePayout !== undefined) merged.allowOvertimePayout = body.allowOvertimePayout;
  if (body.defaultWorkDays !== undefined) merged.defaultWorkDays = [...body.defaultWorkDays];
  return merged;
}

function perDayHoursOf(d: WorkingTimeDefaults): PerDayHours {
  return {
    mondayHours: d.defaultMondayHours,
    tuesdayHours: d.defaultTuesdayHours,
    wednesdayHours: d.defaultWednesdayHours,
    thursdayHours: d.defaultThursdayHours,
    fridayHours: d.defaultFridayHours,
    saturdayHours: d.defaultSaturdayHours,
    sundayHours: d.defaultSundayHours,
  };
}

/** What the bulk apply would write: the proposed defaults as a contract. */
export function proposedContractValues(proposed: WorkingTimeDefaults): ContractValues {
  return {
    weeklyHours: num2(proposed.defaultWeeklyHours),
    mondayHours: num2(proposed.defaultMondayHours),
    tuesdayHours: num2(proposed.defaultTuesdayHours),
    wednesdayHours: num2(proposed.defaultWednesdayHours),
    thursdayHours: num2(proposed.defaultThursdayHours),
    fridayHours: num2(proposed.defaultFridayHours),
    saturdayHours: num2(proposed.defaultSaturdayHours),
    sundayHours: num2(proposed.defaultSundayHours),
    workDays: normalizeWorkDays(undefined, perDayHoursOf(proposed), proposed.defaultWorkDays),
    overtimeThreshold: num2(proposed.overtimeThreshold),
    allowOvertimePayout: proposed.allowOvertimePayout,
  };
}

function contractValuesOfRow(row: BulkScheduleRow): ContractValues {
  return {
    weeklyHours:
      row.weeklyHours === null || row.weeklyHours === undefined ? null : num2(row.weeklyHours),
    mondayHours: num2(row.mondayHours),
    tuesdayHours: num2(row.tuesdayHours),
    wednesdayHours: num2(row.wednesdayHours),
    thursdayHours: num2(row.thursdayHours),
    fridayHours: num2(row.fridayHours),
    saturdayHours: num2(row.saturdayHours),
    sundayHours: num2(row.sundayHours),
    workDays: [...row.workDays],
    overtimeThreshold: num2(row.overtimeThreshold),
    allowOvertimePayout: row.allowOvertimePayout,
  };
}

/**
 * The compare list of D-03: weekly hours, the seven day-hours, the overtime threshold and the
 * payout flag (the `workDays` set is compared separately, see `sameTerms`). A legacy null
 * `weeklyHours` is `null` here and equals nothing — it is never coerced to 0.
 */
function compareList(v: ContractValues): (number | boolean | null)[] {
  return [
    v.weeklyHours,
    v.mondayHours,
    v.tuesdayHours,
    v.wednesdayHours,
    v.thursdayHours,
    v.fridayHours,
    v.saturdayHours,
    v.sundayHours,
    v.overtimeThreshold,
    v.allowOvertimePayout,
  ];
}

/** Set equality of two weekday lists (order and duplicates do not matter). */
function sameWorkDaySet(a: readonly number[], b: readonly number[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every((day) => setB.has(day));
}

/**
 * Two contracts carry the same terms when the compare list AND the `workDays` set agree (Issue #568
 * review IN-01). A legacy FIXED row whose `workDays` diverges from its day-hours (Phase 95b: such
 * rows are never "corrected" silently) therefore equals neither the stored defaults nor the
 * proposal: it is an individual contract the admin has to tick explicitly, and a bulk apply never
 * skips it as "already matches" while quietly rewriting its `workDays`. The defaults' `workDays`
 * are `normalizeWorkDays` of the default day-hours — the derivation the write itself uses.
 */
function sameTerms(a: ContractValues, b: ContractValues): boolean {
  if (a.weeklyHours === null || b.weeklyHours === null) return false;
  const la = compareList(a);
  const lb = compareList(b);
  return la.every((value, i) => value === lb[i]) && sameWorkDaySet(a.workDays, b.workDays);
}

// ── effective date window (D-05, O5) ─────────────────────────────────────────────────────────

export interface EffectiveFromWindow {
  /** "YYYY-MM-DD" — the 1st of the next tenant-local month, or today when today is the 1st. */
  earliest: string;
  /** "YYYY-MM-DD" — the 1st of the tenant-local month 12 months ahead. */
  latest: string;
  /** Every month-first from `earliest` to `latest`, ascending. */
  allowed: string[];
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The effective dates a bulk apply may use. `todayLocal` is the UTC-midnight date of the
 * TENANT-local calendar day (`todayInTz`); the earliest is the month-first rule `"up"` applied to
 * it — exactly the 1st of next month, or today on a 1st (D-05, § 3 Satz 1 NachwG).
 */
export function effectiveFromWindow(todayLocal: Date): EffectiveFromWindow {
  const earliestDate = snapToMonthFirstUtc(todayLocal, "up");
  const latestDate = new Date(
    Date.UTC(todayLocal.getUTCFullYear(), todayLocal.getUTCMonth() + 12, 1),
  );
  const allowed: string[] = [];
  for (
    let cursor = earliestDate;
    cursor.getTime() <= latestDate.getTime();
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  ) {
    allowed.push(dayString(cursor));
  }
  return { earliest: dayString(earliestDate), latest: dayString(latestDate), allowed };
}

function germanDate(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}.${m}.${y}`;
}

/** True for a real calendar day written "YYYY-MM-DD" (rejects 2026-13-01 and 2026-02-31). */
function isRealCalendarDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dayString(d) === value;
}

/** Null when `value` is an allowed effective date, otherwise the refusal (order: shape, earliest, latest). */
export function checkEffectiveFrom(value: string, todayLocal: Date): BulkApplyRejection | null {
  if (!isRealCalendarDay(value) || !isMonthFirstDate(value)) {
    return new BulkApplyRejection(400, "BULK_APPLY_NOT_MONTH_FIRST", MONTH_FIRST_ERROR);
  }
  const window = effectiveFromWindow(todayLocal);
  if (value < window.earliest) {
    return new BulkApplyRejection(
      400,
      "BULK_APPLY_RETROACTIVE",
      `Eine Übernahme auf bestehende Verträge darf nicht rückwirkend gelten (§ 3 NachwG: Änderungen müssen spätestens am Tag ihrer Wirksamkeit mitgeteilt werden). Frühestmöglich ist der ${germanDate(window.earliest)}.`,
    );
  }
  if (value > window.latest) {
    return new BulkApplyRejection(
      400,
      "BULK_APPLY_TOO_FAR",
      `Das Datum darf höchstens 12 Monate in der Zukunft liegen (spätestens der ${germanDate(window.latest)}).`,
    );
  }
  return null;
}

// ── classification (D-03, O1) ────────────────────────────────────────────────────────────────

export type CandidateCategory = "MATCHES_DEFAULTS" | "INDIVIDUAL" | "NO_CONTRACT";
export type NonCandidateReason =
  | "FUTURE_CONTRACT"
  | "SAME_MONTH_MODEL_SWITCH"
  | "CONTRACT_AT_DATE_EXISTS"
  | "OTHER_SCHEDULE_TYPE"
  | "ALREADY_MATCHES_NEW";

/** Precedence order of the non-candidate reasons (also the order of the response groups). */
export const NON_CANDIDATE_REASONS: readonly NonCandidateReason[] = [
  "FUTURE_CONTRACT",
  "SAME_MONTH_MODEL_SWITCH",
  "CONTRACT_AT_DATE_EXISTS",
  "OTHER_SCHEDULE_TYPE",
  "ALREADY_MATCHES_NEW",
];

export interface EmployeeRef {
  employeeId: string;
  name: string;
  employeeNumber: string;
}

export interface BulkCandidate extends EmployeeRef {
  category: CandidateCategory;
  defaultSelected: boolean;
  before: (ContractValues & { type: string; validFrom: string }) | null;
  after: ContractValues;
  /** The contract the comparison used (full row): the audit oldValue and the carry-over source. */
  comparedRow: BulkScheduleRow | null;
}

export interface NonCandidateGroup {
  reason: NonCandidateReason;
  count: number;
  employees: EmployeeRef[];
}

/** One line per classified employee, candidate or not — the fingerprint's input. */
interface ClassifiedEntry {
  employeeId: string;
  comparedRow: BulkScheduleRow | null;
  tag: string;
}

export interface BulkApplyClassification {
  candidates: BulkCandidate[];
  nonCandidates: NonCandidateGroup[];
  entries: ClassifiedEntry[];
}

function byValidFromDescThenId(a: BulkScheduleRow, b: BulkScheduleRow): number {
  const diff = b.validFrom.getTime() - a.validFrom.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function classifyBulkApplyCandidates(input: {
  employees: BulkEmployeeInput[];
  stored: WorkingTimeDefaults;
  proposed: WorkingTimeDefaults;
  /** "YYYY-MM-DD" */
  effectiveFrom: string;
  /**
   * The tenant timezone. A contract's `validFrom` is an instant (a hire contract can be stored as
   * the previous UTC day's 23:00 for a Europe/Berlin hire on the 1st) and is compared with
   * `effectiveFrom` by its tenant-LOCAL calendar day — never by its UTC day (Issue #568 review WR-01).
   */
  timeZone: string;
}): BulkApplyClassification {
  const { employees, stored, proposed, effectiveFrom, timeZone } = input;
  const storedContract = proposedContractValues(stored);
  const after = proposedContractValues(proposed);
  const candidates: BulkCandidate[] = [];
  const groups = new Map<NonCandidateReason, EmployeeRef[]>();
  const entries: ClassifiedEntry[] = [];

  for (const employee of employees) {
    const ref: EmployeeRef = {
      employeeId: employee.id,
      name: `${employee.firstName} ${employee.lastName}`,
      employeeNumber: employee.employeeNumber,
    };
    const rows = [...employee.workSchedules].sort(byValidFromDescThenId);
    const dayOf = (row: BulkScheduleRow) => dateStrInTz(row.validFrom, timeZone);
    // The compared row: the newest contract that is valid at `effectiveFrom`.
    const comparedRow = rows.find((row) => dayOf(row) <= effectiveFrom) ?? null;

    let reason: NonCandidateReason | null = null;
    const atDate = rows.filter((row) => dayOf(row) === effectiveFrom);
    if (rows.some((row) => dayOf(row) > effectiveFrom)) {
      reason = "FUTURE_CONTRACT";
    } else if (atDate.some((row) => row.type !== "FIXED_SCHEDULE")) {
      reason = "SAME_MONTH_MODEL_SWITCH";
    } else if (atDate.length > 0) {
      reason = "CONTRACT_AT_DATE_EXISTS";
    } else if (comparedRow && comparedRow.type !== "FIXED_SCHEDULE") {
      reason = "OTHER_SCHEDULE_TYPE";
    }
    const beforeValues = comparedRow ? contractValuesOfRow(comparedRow) : null;
    if (reason === null && beforeValues && sameTerms(beforeValues, after)) {
      reason = "ALREADY_MATCHES_NEW";
    }

    if (reason !== null) {
      const list = groups.get(reason) ?? [];
      list.push(ref);
      groups.set(reason, list);
      entries.push({ employeeId: employee.id, comparedRow, tag: reason });
      continue;
    }

    let category: CandidateCategory;
    if (!comparedRow || !beforeValues) category = "NO_CONTRACT";
    else if (sameTerms(beforeValues, storedContract)) category = "MATCHES_DEFAULTS";
    else category = "INDIVIDUAL";

    candidates.push({
      ...ref,
      category,
      defaultSelected: category !== "INDIVIDUAL",
      before:
        comparedRow && beforeValues
          ? { ...beforeValues, type: comparedRow.type, validFrom: dayOf(comparedRow) }
          : null,
      after,
      comparedRow,
    });
    entries.push({ employeeId: employee.id, comparedRow, tag: category });
  }

  const sortKey = new Map(
    employees.map((e) => [e.id, `${e.lastName}\u0000${e.firstName}\u0000${e.id}`]),
  );
  const byName = (a: EmployeeRef, b: EmployeeRef) => {
    const keyA = sortKey.get(a.employeeId) ?? "";
    const keyB = sortKey.get(b.employeeId) ?? "";
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  };
  candidates.sort(byName);

  const nonCandidates: NonCandidateGroup[] = [];
  for (const reason of NON_CANDIDATE_REASONS) {
    const list = groups.get(reason);
    if (!list || list.length === 0) continue;
    list.sort(byName);
    nonCandidates.push({ reason, count: list.length, employees: list });
  }
  return { candidates, nonCandidates, entries };
}

// ── fingerprint (D-04) ───────────────────────────────────────────────────────────────────────

const FINGERPRINT_VERSION = "clokr-bulk-apply-v1";

function defaultsArray(d: WorkingTimeDefaults): (number | number[])[] {
  return [
    num2(d.defaultWeeklyHours),
    num2(d.defaultMondayHours),
    num2(d.defaultTuesdayHours),
    num2(d.defaultWednesdayHours),
    num2(d.defaultThursdayHours),
    num2(d.defaultFridayHours),
    num2(d.defaultSaturdayHours),
    num2(d.defaultSundayHours),
    num2(d.overtimeThreshold),
    d.allowOvertimePayout ? 1 : 0,
    [...d.defaultWorkDays].sort((a, b) => a - b),
  ];
}

function rowArray(row: BulkScheduleRow | null): unknown[] | null {
  if (!row) return null;
  const v = contractValuesOfRow(row);
  return [
    row.type,
    dayString(row.validFrom),
    ...compareList(v),
    [...v.workDays].sort((a, b) => a - b),
    row.overtimeMode,
    row.maxNegativeBalanceMinutes,
  ];
}

/**
 * sha256 over a fixed-ORDER array (no object keys, so key order cannot matter): the version tag,
 * the tenant, the effective date, the stored defaults, the proposal and every classified employee
 * — candidates AND non-candidates, sorted by id — with the compared contract's id and values, so
 * an in-place edit of a contract row flips it too.
 */
export function bulkApplyFingerprint(input: {
  tenantId: string;
  effectiveFrom: string;
  stored: WorkingTimeDefaults;
  proposed: WorkingTimeDefaults;
  classification: BulkApplyClassification;
}): string {
  const employees = [...input.classification.entries]
    .sort((a, b) => (a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0))
    .map((entry) => [
      entry.employeeId,
      entry.comparedRow ? entry.comparedRow.id : null,
      entry.tag,
      rowArray(entry.comparedRow),
    ]);
  const canonical = JSON.stringify([
    FINGERPRINT_VERSION,
    input.tenantId,
    input.effectiveFrom,
    defaultsArray(input.stored),
    defaultsArray(input.proposed),
    employees,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

// ── apply helpers ────────────────────────────────────────────────────────────────────────────

/**
 * An id outside the server's own candidate set — another tenant, a non-candidate, an unknown id —
 * is the same refusal as a stale preview (D-02): nothing is written.
 */
export function checkBulkSelection(
  candidates: readonly { employeeId: string }[],
  ids: readonly string[],
): BulkApplyRejection | null {
  const allowed = new Set(candidates.map((c) => c.employeeId));
  if (ids.some((id) => !allowed.has(id))) {
    return new BulkApplyRejection(409, "BULK_APPLY_PREVIEW_STALE", BULK_APPLY_STALE_MESSAGE);
  }
  return null;
}

/**
 * The `WorkSchedule` create data (without `employeeId`) of one applied employee. `overtimeMode` and
 * `maxNegativeBalanceMinutes` are carried over from the compared contract (column defaults when
 * there is none): the bulk apply must not reset a contract term the preview does not show.
 */
export function bulkScheduleData(
  proposed: WorkingTimeDefaults,
  effectiveFrom: string,
  comparedRow: BulkScheduleRow | null,
) {
  const values = proposedContractValues(proposed);
  return {
    type: "FIXED_SCHEDULE" as const,
    weeklyHours: values.weeklyHours,
    mondayHours: values.mondayHours,
    tuesdayHours: values.tuesdayHours,
    wednesdayHours: values.wednesdayHours,
    thursdayHours: values.thursdayHours,
    fridayHours: values.fridayHours,
    saturdayHours: values.saturdayHours,
    sundayHours: values.sundayHours,
    overtimeThreshold: values.overtimeThreshold,
    allowOvertimePayout: values.allowOvertimePayout,
    workDays: values.workDays,
    validFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
    ...(comparedRow
      ? {
          overtimeMode: comparedRow.overtimeMode,
          maxNegativeBalanceMinutes: comparedRow.maxNegativeBalanceMinutes,
        }
      : {}),
  };
}
