/**
 * Issue #93 (Phase 93b-01) — types and control values of the support access. Types and constants only:
 * no Prisma call and no behaviour live here, so the composition layer may import this file (through
 * `contexts/platform/index.ts`) without reaching the decider.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

/** Derived status of a grant at a given instant (see `supportAccessStatus` in `support-access.ts`). */
export type SupportAccessStatus = "ACTIVE" | "EXPIRED" | "ENDED";

/** Who ended a grant early. Control values; stored in `SupportAccess.endedBy` (CHECK in the DB). */
export type SupportAccessEndedBy = "OPERATOR" | "TENANT";

/**
 * The categories of data a support read can open (D-05, D-06). Control values written to both audit
 * logs as `newValue.category`; never a display string.
 */
export const SUPPORT_READ_CATEGORIES = [
  "EMPLOYEES",
  "EMPLOYEE_MONTH",
  "CONTRACTS",
  "AUDIT_LOG",
] as const;

export type SupportReadCategory = (typeof SUPPORT_READ_CATEGORIES)[number];

/** Operator view of one grant. Instants are ISO strings; explicit keys only, never a row spread. */
export interface SupportAccessDto {
  id: string;
  tenantId: string;
  reason: string;
  durationHours: number;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: SupportAccessEndedBy | null;
  status: SupportAccessStatus;
}

/**
 * One support access as the controlling tenant sees it (D-08, D-29): the operator's display name only —
 * never its e-mail or the client address — and the number of reads made under the grant.
 */
export interface TenantSupportAccessItemDto {
  id: string;
  operatorName: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedBy: SupportAccessEndedBy | null;
  status: SupportAccessStatus;
  readCount: number;
}

/** One read made under a grant, as stored in the tenant's own log (control values, dates and ids only). */
export interface TenantSupportAccessReadDto {
  at: string;
  category: string;
  /** `name` is null for an anonymised employee (D-13) and for an id that no longer resolves. */
  employee: { id: string; name: string | null; anonymized: boolean } | null;
  month: string | null;
  filters: Record<string, unknown> | null;
}

export interface TenantSupportAccessDetailDto {
  access: TenantSupportAccessItemDto;
  reads: TenantSupportAccessReadDto[];
  timezone: string;
}

/**
 * One employee as the operator sees it in the support list (D-05): no e-mail, birth date, NFC card id
 * or address. `status` is derived by `supportEmployeeStatus`; an anonymised employee keeps its stored
 * (anonymised) name.
 */
export interface SupportEmployeeDto {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  hireDate: string;
  exitDate: string | null;
  status: "ACTIVE" | "EXITED" | "ANONYMIZED";
  homeSalon: { id: string; name: string } | null;
  scheduleType: string | null;
}

/** One time entry of the support month view (D-05(2)): no note, waived-break reason or creator. */
export interface SupportMonthEntryDto {
  id: string;
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Instants, ISO strings. */
  startTime: string;
  endTime: string | null;
  breakMinutes: number;
  breaks: { startTime: string; endTime: string }[];
  /** The break-confirmation enum (D-05(2) "breaks" block); its free-text waived reason is excluded. */
  breakStatus: string;
  salon: { id: string; name: string };
  type: string;
  source: string;
  isInvalid: boolean;
  /** The authoritative invalid-reason enum, never the derived display text. */
  invalidReasonCode: string | null;
  /** True for a soft-deleted entry (named carve-out: support traces vanished entries). */
  deleted: boolean;
  isLocked: boolean;
}

/** A break lying in a gap between entries (`DayBreak`): no creator, no deleter, no acknowledgement. */
export interface SupportDayBreakDto {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
}

/** A requested absence (`LeaveRequest`): type, status and dates only, no note, attest or reviewer. */
export interface SupportLeaveRequestDto {
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

/** An imposed absence (`Absence`): no note, document path, creator or Unterrichtszeit. */
export interface SupportAbsenceDto {
  id: string;
  type: string;
  source: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
}

/** Soll/Ist/Saldo of the month, exactly what `computeMonthReportFigures` returns for the report. */
export interface SupportMonthFiguresDto {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  balanceAdjustmentMinutes: number;
  basis: "snapshot" | "fullMonth" | "toDate" | "untracked";
}

/** The month of one employee as the operator sees it (D-05(2)). */
export interface SupportEmployeeMonthDto {
  employee: {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    status: "ACTIVE" | "EXITED" | "ANONYMIZED";
  };
  /** `YYYY-MM`. */
  month: string;
  timezone: string;
  entries: SupportMonthEntryDto[];
  dayBreaks: SupportDayBreakDto[];
  leaveRequests: SupportLeaveRequestDto[];
  absences: SupportAbsenceDto[];
  /** `null` only when the tenant has no active salon (the figures need a holiday resolution). */
  figures: SupportMonthFiguresDto | null;
  figuresUnavailableReason: null | "NO_ACTIVE_SALON";
  /** The snapshot state of the month: `confirmed` is true only for a closed month. */
  snapshot: { confirmed: boolean; basis: SupportMonthFiguresDto["basis"] } | null;
}

/**
 * One contract row of the history (D-05(3)): the schedule columns only. The `{day}Hours` columns are
 * served as stored — authoritative only for FIXED_SCHEDULE (CLAUDE.md Schedule Types), never corrected.
 */
export interface SupportContractDto {
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

/**
 * One row of the tenant change log as the operator sees it (D-05(4), D-17): the AuditLog columns only,
 * never the user's e-mail, IP address or user agent. `oldValue`/`newValue` are already redacted by type
 * (`redactSupportAuditValue`): every free-text string is the constant placeholder.
 */
export interface SupportAuditItemDto {
  id: string;
  /** Instant, ISO string. */
  createdAt: string;
  action: string;
  entity: string;
  entityId: string | null;
  userId: string | null;
  oldValue: unknown;
  newValue: unknown;
}

/** One page of the support audit-log read. `from`/`to` are the validated UTC calendar days of the window. */
export interface SupportAuditPageDto {
  items: SupportAuditItemDto[];
  total: number;
  page: number;
  pageSize: number;
  from: string;
  to: string;
}

/**
 * The reads the operator support routes receive from the composition layer (pattern of the operator
 * salon ports). Declared structurally here so the Unterbau names no context; 93b-02 implements it in
 * `composition/operator-support-ports.ts` and later plans extend it.
 */
export interface OperatorSupportPorts {
  /** True when the employee exists in the tenant; a foreign or unknown id is indistinguishable. */
  employeeExists(
    db: Prisma.TransactionClient,
    tenantId: string,
    employeeId: string,
  ): Promise<boolean>;
  listEmployees(app: FastifyInstance, tenantId: string): Promise<SupportEmployeeDto[]>;
  /** The month of one employee; the caller has already resolved the employee inside the tenant. */
  employeeMonth(
    app: FastifyInstance,
    input: { tenantId: string; employeeId: string; year: number; month: number },
  ): Promise<SupportEmployeeMonthDto>;
  /** The contract history of one employee, newest `validFrom` first. */
  employeeContracts(
    app: FastifyInstance,
    input: { tenantId: string; employeeId: string },
  ): Promise<SupportContractDto[]>;
  /**
   * One page of the tenant's own change log inside `[from, to]` (UTC calendar days, inclusive), newest
   * first, values redacted by type. `employeeId`, when given, has already been resolved inside the tenant.
   */
  auditPage(
    app: FastifyInstance,
    input: { tenantId: string; employeeId?: string; from: string; to: string; page: number },
  ): Promise<SupportAuditPageDto>;
}
