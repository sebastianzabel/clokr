// Shared Types zwischen API und Web

export type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";
export type FederalState =
  | "NIEDERSACHSEN"
  | "BAYERN"
  | "BERLIN"
  | "BRANDENBURG"
  | "BREMEN"
  | "HAMBURG"
  | "HESSEN"
  | "MECKLENBURG_VORPOMMERN"
  | "NORDRHEIN_WESTFALEN"
  | "RHEINLAND_PFALZ"
  | "SAARLAND"
  | "SACHSEN"
  | "SACHSEN_ANHALT"
  | "SCHLESWIG_HOLSTEIN"
  | "THUERINGEN"
  | "BADEN_WUERTTEMBERG";

export type TimeEntrySource = "NFC" | "MOBILE" | "MANUAL" | "CORRECTION";
export type LeaveRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type AbsenceType = "SICK" | "SICK_CHILD" | "SPECIAL_LEAVE" | "UNPAID_LEAVE" | "OTHER";
export type OvertimePlanStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

export interface Employee {
  id: string;
  tenantId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  exitDate?: string;
  nfcCardId?: string;
}

export interface TimeEntry {
  id: string;
  employeeId: string;
  date: string;
  startTime: string;
  endTime?: string;
  breakMinutes: number;
  source: TimeEntrySource;
  note?: string;
  isLocked: boolean;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  days: number;
  halfDay: boolean;
  status: LeaveRequestStatus;
  note?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface OvertimeAccount {
  id: string;
  employeeId: string;
  balanceHours: number;
  status: "NORMAL" | "ELEVATED" | "CRITICAL";
  threshold: number;
}

export interface ApiError {
  error: string;
  statusCode: number;
}

// ─────────────────────────────────────────────
// WorkEvent (v1.9 — Phase 77 schema + Phase 79 endpoints)
// ─────────────────────────────────────────────
//
// The split between /work-events/mine and /work-events is STRUCTURAL — these
// two types are intentionally NOT assignment-compatible in EITHER direction.
// Mixing them at a call site (e.g. fetching /mine and trying to read
// `.employee.firstName`) produces a TypeScript compile error. This is the
// type-level half of the v1.8.12 leak-class fix (the runtime half is the
// endpoint split itself — see apps/api/src/routes/work-events.ts).
//
// REVISION (W5 — Phase 79 plan-checker BLOCKER): the previous one-way
// structural boundary (Mine missing `employee`) allowed Tenant → Mine
// assignment because Tenant items have a superset of Mine's required fields.
// We close this by adding an OPTIONAL `__brand` discriminant on each list-item
// type. The brand is optional so existing runtime payloads (without a brand
// field) still satisfy both types — but TypeScript's literal-type comparison
// of `__brand?: 'mine'` vs `__brand?: 'tenant'` blocks cross-assignment of
// named-type variables.
//
// Frontend usage (Phase 82):
//   const data = await api.get<WorkEventListMine>("/api/v1/work-events/mine");
//   const team = await api.get<WorkEventListTenant>("/api/v1/work-events");
// Calling api.get<WorkEventListMine>("/api/v1/work-events") (mixed up) does
// NOT crash at runtime, but the response will fail to typecheck downstream
// when code accesses `.employee` on a non-existent field — surfacing the bug
// at compile time.

export type WorkEventType =
  | "VOCATIONAL_SCHOOL"
  | "FIELD_SERVICE"
  | "BUSINESS_TRIP"
  | "TRAINING"
  | "OTHER";

export type WorkEventSource = "PATTERN" | "MANUAL" | "AUTO";

/** Shared base — fields present on every WorkEvent response item. */
export interface WorkEventBase {
  id: string;
  employeeId: string;
  type: WorkEventType;
  source: WorkEventSource;
  /** ISO date YYYY-MM-DD. */
  date: string;
  workedMinutes: number;
  /** NULL when MONTHLY_HOURS schedule type (Phase 63 D-04). */
  expectedMinutes: number | null;
  /** Discriminated-union payload — type narrowed by `type` field. */
  payload: unknown;
  note: string | null;
}

/**
 * Response item for GET /api/v1/work-events/mine.
 *
 * Does NOT include the `employee` sub-object — the caller is always reading
 * their own rows and doesn't need their own name back.
 *
 * REVISION (W5): the optional `__brand?: 'mine'` discriminant makes this
 * type NOMINALLY distinct from WorkEventListTenantItem. The brand is OPTIONAL
 * so runtime payloads (which never include a `__brand` field) still satisfy
 * the type. But variable-to-variable assignment between the two named types
 * is blocked by TypeScript's literal-type comparison.
 */
export type WorkEventListMineItem = WorkEventBase & {
  readonly __brand?: "mine";
};

/** Full response payload of GET /api/v1/work-events/mine. */
export type WorkEventListMine = WorkEventListMineItem[];

/**
 * Response item for GET /api/v1/work-events (management).
 *
 * Includes the `employee` sub-object with firstName / lastName / employeeNumber
 * — the caller is a manager looking at the team and needs to identify rows
 * by employee. Tenant-scoped.
 *
 * REVISION (W5): the optional `__brand?: 'tenant'` discriminant makes this
 * type NOMINALLY distinct from WorkEventListMineItem. Mismatched assignment
 * (Tenant → Mine or Mine → Tenant) fails on the literal `__brand` field.
 */
export interface WorkEventListTenantItem extends WorkEventBase {
  employee: {
    firstName: string;
    lastName: string;
    employeeNumber: string;
  };
  readonly __brand?: "tenant";
}

/** Full response payload of GET /api/v1/work-events (management). */
export type WorkEventListTenant = WorkEventListTenantItem[];
