// Wire types of the operator API (Issue #89). Mirrors the metadata-only DTOs of
// `contexts/platform/api/operator/{tenants,salons}.ts`; the console shows master data only.
import type { FederalState } from "@clokr/types";
import type { TenantModule } from "$lib/packages/tenant-modules";

/** Booked packages of a tenant as the operator API reports them (Phase 566). */
export interface OperatorTenantPackages {
  bookedModules: TenantModule[];
  salonQuota: number;
  /** Number of active salons; display only (the warning when the limit lies below it). */
  activeSalonCount: number;
}

/** Body of `PUT /operator/tenants/:id/packages`; the strict API schema accepts exactly these keys. */
export interface SetTenantPackagesBody {
  bookedModules: TenantModule[];
  salonQuota: number;
}

export interface OperatorTenant {
  id: string;
  name: string;
  slug: string;
  federalState: FederalState;
  createdAt: string;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  packages: OperatorTenantPackages;
}

/** Totals block of `GET /operator/dashboard` (Issue #90): counts only. */
export interface OperatorDashboardTotals {
  tenants: number;
  activeTenants: number;
  deactivatedTenants: number;
  activeSalons: number;
  activeEmployees: number;
  inactiveTenants: number;
}

/** One tenant's aggregate metrics (Issue #90): numbers and one calendar day, never a person. */
export interface OperatorDashboardTenant {
  id: string;
  name: string;
  slug: string;
  deactivatedAt: string | null;
  activeSalons: number;
  totalSalons: number;
  activeEmployees: number;
  /** `YYYY-MM-DD` (UTC day) of the tenant's most recent sign-in, or null when there never was one. */
  lastActivityAt: string | null;
  inactive: boolean;
}

/** Wire type of `GET /operator/dashboard` (Issue #90, aggregates only). */
export interface OperatorDashboard {
  /** The server's inactivity threshold in days; the console never hard-codes it. */
  inactivityDays: number;
  totals: OperatorDashboardTotals;
  tenants: OperatorDashboardTenant[];
}

/** One weekday of the opening hours; `day` 0 = Montag … 6 = Sonntag (API order). */
export interface OpeningHoursDay {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
}

/** The coupling choices of the salon form: no coupling, or Phorest (D-11: nothing else is offered). */
export type CouplingProvider = "NONE" | "PHOREST";

export interface OperatorCoupling {
  provider: string;
  externalBranchId: string;
}

export interface OperatorSalon {
  id: string;
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  openingHours: OpeningHoursDay[];
  federalState: FederalState;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  isDefault: boolean;
  coupling: OperatorCoupling | null;
}

/** Step 1 of the sign-in: the short-lived challenge that step 2 redeems. */
export interface OperatorChallenge {
  challengeToken: string;
  /** Seconds the challenge stays valid. */
  expiresIn: number;
}

/** Exactly one second factor per verify call (the API refuses both or neither). */
export type OperatorFactor = { code: string } | { recoveryCode: string };

export interface OperatorAccessGrant {
  accessToken: string;
  /** Seconds the access token stays valid (no refresh exists). */
  expiresIn: number;
}

export interface OperatorMe {
  id: string;
  email: string;
  displayName: string;
  lastLoginAt: string | null;
}

/** Body of `POST /operator/tenants`; the strict API schema accepts exactly these keys. */
export interface CreateTenantBody {
  name: string;
  slug: string;
  federalState: FederalState;
  timezone?: string;
  admin: {
    email: string;
    firstName: string;
    lastName: string;
    employeeNumber?: string;
  };
}

/** 201 body of `POST /operator/tenants`. The invitation token is never part of it (T-88-52). */
export interface CreateTenantResult {
  tenant: OperatorTenant;
  defaultSalonId: string;
  adminEmployeeId: string;
  invitationMailSent: boolean;
}

/** 200 body of `POST /operator/tenants/:id/resend-admin-invitation`; the token is never part of it. */
export interface ResendInvitationResult {
  invitationMailSent: boolean;
}

/** The coupling object of a salon write: an object sets or replaces it, `null` removes it. */
export interface SalonCouplingInput {
  externalBranchId: string;
}

/** Body of `POST /operator/tenants/:id/salons`; the strict API schema accepts exactly these keys. */
export interface CreateSalonBody {
  name: string;
  street?: string;
  postalCode?: string;
  city?: string;
  /** Always all seven days, explicit `closed`. */
  openingHours: OpeningHoursDay[];
  federalState: FederalState;
  /** Absent = no coupling. */
  coupling?: SalonCouplingInput;
}

/**
 * Body of `PATCH /operator/tenants/:id/salons/:salonId`: only the keys that changed. An address
 * field cleared by the operator is sent as `null`; `coupling` absent = unchanged.
 */
export interface UpdateSalonBody {
  name?: string;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  federalState?: FederalState;
  openingHours?: OpeningHoursDay[];
  coupling?: SalonCouplingInput | null;
}

/** Derived status of a support access at the time the server answered (Issue #93). */
export type SupportAccessStatus = "ACTIVE" | "EXPIRED" | "ENDED";

/** Who ended a support access early. */
export type SupportAccessEndedBy = "OPERATOR" | "TENANT";

/** The durations the server accepts for a support access, in hours (D-03). */
export type SupportDurationHours = 1 | 4 | 8 | 24;

/** One support access as `GET /operator/tenants/:id/support-access` reports it (mirror of the API DTO). */
export interface OperatorSupportAccess {
  id: string;
  tenantId: string;
  reason: string;
  durationHours: number;
  /** ISO instants. */
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: SupportAccessEndedBy | null;
  status: SupportAccessStatus;
}

/** Wire type of `GET /operator/tenants/:id/support-access`: the running access and every own grant, newest first. */
export interface OperatorSupportAccessState {
  active: OperatorSupportAccess | null;
  history: OperatorSupportAccess[];
}

/** Body of `POST /operator/tenants/:id/support-access`; the strict API schema accepts exactly these keys. */
export interface RequestSupportAccessBody {
  reason: string;
  durationHours: SupportDurationHours;
}

/** 201 body of the request and 200 body of the end call. */
export interface SupportAccessResult {
  access: OperatorSupportAccess;
}

// ── Support reads (Issue #93, D-05) ─────────────────────────────────────────
// Mirrors of the DTOs in `apps/api/src/contexts/platform/support-access-types.ts`. Enum-like fields
// stay plain strings on purpose: an unknown value is shown raw by `labelFor`, never rejected.

/** Derived employee status of the support views. */
export type SupportEmployeeStatus = "ACTIVE" | "EXITED" | "ANONYMIZED";

/** How the figures of a month were obtained. */
export type SupportFiguresBasis = "snapshot" | "fullMonth" | "toDate" | "untracked";

/** One employee of the support list; no e-mail, birth date, NFC card or address. */
export interface SupportEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  /** Calendar days, `YYYY-MM-DD`. */
  hireDate: string;
  exitDate: string | null;
  status: SupportEmployeeStatus;
  homeSalon: { id: string; name: string } | null;
  scheduleType: string | null;
}

/** Wire type of `GET …/support/employees`. */
export interface SupportEmployeeList {
  items: SupportEmployee[];
}

export interface SupportMonthEntry {
  id: string;
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Instants, ISO strings. */
  startTime: string;
  endTime: string | null;
  breakMinutes: number;
  breaks: { startTime: string; endTime: string }[];
  breakStatus: string;
  salon: { id: string; name: string };
  type: string;
  source: string;
  isInvalid: boolean;
  invalidReasonCode: string | null;
  deleted: boolean;
  isLocked: boolean;
}

export interface SupportDayBreak {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
}

export interface SupportLeaveRequest {
  id: string;
  typeCode: string;
  typeName: string;
  status: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  days: number;
  daysProvisional: boolean | null;
}

export interface SupportAbsence {
  id: string;
  type: string;
  source: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
}

export interface SupportMonthFigures {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  balanceAdjustmentMinutes: number;
  basis: SupportFiguresBasis;
}

/** Wire type of `GET …/support/employees/:employeeId/month`. */
export interface SupportEmployeeMonth {
  employee: {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    status: SupportEmployeeStatus;
  };
  /** `YYYY-MM`. */
  month: string;
  timezone: string;
  entries: SupportMonthEntry[];
  dayBreaks: SupportDayBreak[];
  leaveRequests: SupportLeaveRequest[];
  absences: SupportAbsence[];
  figures: SupportMonthFigures | null;
  figuresUnavailableReason: null | "NO_ACTIVE_SALON";
  snapshot: { confirmed: boolean; basis: SupportFiguresBasis } | null;
}

/** One contract row of the history. The `{day}Hours` columns are authoritative for FIXED_SCHEDULE only. */
export interface SupportContract {
  id: string;
  type: string;
  /** Instant, ISO string. */
  validFrom: string;
  weeklyHours: number | null;
  monthlyHours: number | null;
  dayHours: {
    monday: number;
    tuesday: number;
    wednesday: number;
    thursday: number;
    friday: number;
    saturday: number;
    sunday: number;
  };
  workDays: number[];
  contractWorkDaysPerWeek: number | null;
  usualWorkDays: number[];
  overtimeMode: string;
  overtimeThreshold: number;
  allowOvertimePayout: boolean;
  maxNegativeBalanceMinutes: number | null;
  coreStart: string | null;
  coreEnd: string | null;
  coreDays: number[];
}

/** Wire type of `GET …/support/employees/:employeeId/contracts`. */
export interface SupportContractList {
  items: SupportContract[];
}

/** One row of the tenant change log; old and new values are already redacted by type on the server. */
export interface SupportAuditItem {
  id: string;
  createdAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  userId: string | null;
  oldValue: unknown;
  newValue: unknown;
}

/** Wire type of `GET …/support/audit-log`. */
export interface SupportAuditPage {
  items: SupportAuditItem[];
  total: number;
  page: number;
  pageSize: number;
  from: string;
  to: string;
}

/** Query of `GET …/support/audit-log`; `from`/`to` are calendar days, at most 92 days apart. */
export interface SupportAuditQuery {
  from: string;
  to: string;
  page?: number;
  employeeId?: string;
}
