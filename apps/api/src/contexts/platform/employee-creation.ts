/**
 * Employee creation — the ONE place that decides which rows creating an employee writes
 * (Phase 88, D-04/D-04a, research F3 Option A).
 *
 * `POST /api/v1/employees` and the operator's first-admin provisioning
 * (`provisionTenantWithAdmin`, `tenant-provisioning.ts`) both call these functions; there is no
 * second copy of the User / Employee / WorkSchedule / OvertimeAccount / vacation-entitlement /
 * system-role / Stammsalon (HOME) / Invitation sequence.
 *
 * Why an audit port: the in-transaction audit rows of that sequence used to be written through
 * helpers that need a tenant REQUEST (`auditRoleAssignmentChange(app, req, …)`,
 * `auditSalonAssignmentEvent(app, req, …)`, `userId: req.user.sub`). The operator path has no
 * tenant request and must never write a row "as if a tenant user did it" (D-07, repudiation): its
 * port leaves `AuditLog.userId` empty and records `newValue.actor = { type: "OPERATOR",
 * operatorId }`. The tenant route wires the port to the existing helpers, so its rows are
 * byte-identical to what it wrote before the extraction.
 *
 * The invitation rule (random token, stored hashed, 24 h lifetime, open invitations expired on
 * re-issue) lives here once: employee creation, the tenant-side resend route and the operator
 * resend all use it.
 */
import bcrypt from "bcryptjs";
import crypto, { createHash } from "crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { DEFAULT_PASSWORD_POLICY, validatePassword, type PasswordPolicy } from "./password-policy";
import { normalizeWorkDays, type PerDayHours } from "./calculate-work-days";
import { replaceSystemRoleAssignment, syncCompatRoleColumn } from "./compat-role";
import { lockTenantForRoleChanges } from "./facade/role-assignments";
import {
  createdAssignmentAuditEntry,
  type RoleAssignmentAuditEntry,
} from "./role-assignment-audit";
import { validateUsualWorkDays } from "./usual-work-days";
import {
  createInitialHomeAssignment,
  resolveHomeSalonForNewEmployee,
} from "./facade/salon-assignments";
import { tenantLocalDay, toAssignmentDto } from "./salon-assignment-rules";
import { createOvertimeAccount, getTenantTimezone } from "../working-time-account";
import {
  ARBZG_FLOOR_OVER_6H,
  ARBZG_FLOOR_OVER_9H,
  BREAK_MAX_OVER_6H,
  BREAK_MAX_OVER_9H,
} from "../time-tracking";
import {
  BS_DAILY_MIN_BOUND,
  BS_DAILY_MAX_BOUND,
  BS_BLOCK_WEEKLY_MIN_BOUND,
  BS_BLOCK_WEEKLY_MAX_BOUND,
  ensureVacationEntitlementForYear, // Issue #416 — auto-seed vacation entitlement at hire time
  resolveVacationBaseDays, // Issue #482 — the classification-aware base value
  statutoryMinimumVacationDays, // Issue #435 (D-11) — 5-day-base floor
  statutoryMinimumViolationMessage, // Issue #435 (D-11) — the ONE German 400 message builder
  contractWorkDaysPerWeekFrom, // Phase 436 Plan 02 (D-02) — comparison value for validateUsualWorkDays
} from "../absence";

// ── Schema ──────────────────────────────────────────────────────────────────

// Phase 76.31 D-06 — per-employee bsSlot* override Zod fields (highest layer of
// the 4-layer slot hierarchy). Nullable Int — explicit null CLEARS the employee
// override so resolution delegates down to Pattern → TenantConfig → daily-Soll.
// Daily bounds 240..600 (4h..10h); block-week bounds 1200..3000 (20h..50h).
export const bsSlotEmployeeFields = {
  bsSlotFirstLongDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotSecondLongDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotShortDayMinutes: z
    .number()
    .int()
    .min(BS_DAILY_MIN_BOUND)
    .max(BS_DAILY_MAX_BOUND)
    .nullable()
    .optional(),
  bsSlotBlockWeekMinutes: z
    .number()
    .int()
    .min(BS_BLOCK_WEEKLY_MIN_BOUND)
    .max(BS_BLOCK_WEEKLY_MAX_BOUND)
    .nullable()
    .optional(),
};

// Personalstruktur (Phase 41) — keep enum in sync with prisma EmployeeClassification
export const employeeClassificationSchema = z.enum([
  "VOLLZEIT",
  "TEILZEIT",
  "MINIJOB",
  "AZUBI",
  "AUSHILFE",
  "WERKSTUDENT",
  "PRAKTIKANT",
]);

export const createEmployeeSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  employeeNumber: z.string().min(1),
  hireDate: z.string().datetime(),
  role: z.enum(["ADMIN", "MANAGER", "EMPLOYEE"]).default("EMPLOYEE"),
  weeklyHours: z.number().min(0).max(60).nullable().optional().default(0),
  scheduleType: z
    .enum(["FIXED_SCHEDULE", "FLEXTIME", "MONTHLY_HOURS", "SHIFT_BASED"])
    .default("SHIFT_BASED"),
  monthlyHours: z.number().min(0).max(999).nullable().optional(),
  nfcCardId: z.string().optional(),
  password: z.string().min(8).optional(),
  // Personalstruktur (Phase 41)
  classification: employeeClassificationSchema.optional(),
  coverageWeight: z.number().min(0).max(9.99).optional(),
  requiresSupervision: z.boolean().optional(),
  // Phase 49.2 — FLEXTIME Kernarbeitszeit (optional; only applied when scheduleType=FLEXTIME)
  coreStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
    .nullable()
    .optional(),
  coreEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "Format HH:MM erwartet")
    .nullable()
    .optional(),
  coreDays: z.array(z.number().int().min(0).max(6)).optional(),
  // Phase 49.5 — workdays per week (optional; falls back to TenantConfig.defaultWorkDays)
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  // Phase 107 (D-01, issue #94) — contractual number of workdays per week, filled for
  // SHIFT_BASED only. .optional().nullable(): see settings.ts's identical field
  // for the rationale (Svelte forms send `field: x ? x : null`).
  contractWorkDaysPerWeek: z.number().int().min(1).max(7).optional().nullable(),
  // Phase 436 Plan 02 (D-02): optional "usual workdays" (übliche Arbeitstage) at creation, SHIFT_BASED only.
  // .optional().nullable() (not bare .optional()): same convention as settings.ts — this
  // project's Svelte forms send `field: x ? x : null`.
  usualWorkDays: z.array(z.number().int().min(0).max(6)).max(7).optional().nullable(),
  // Phase 64 — Pausendauer Override (D-08, BREAK-02, BREAK-04):
  // nullable Int — null clears override → fall back to TenantConfig defaults.
  // Floor enforces ArbZG §4 Pflichtpause; cap is a sane upper bound.
  breakOver6hOverride: z
    .number()
    .int()
    .min(
      ARBZG_FLOOR_OVER_6H,
      "Pausendauer für Arbeitstage über 6 Stunden darf nicht unter 30 Minuten liegen (ArbZG §4 Pflichtpause).",
    )
    .max(
      BREAK_MAX_OVER_6H,
      "Pausendauer für Arbeitstage über 6 Stunden darf 120 Minuten nicht überschreiten.",
    )
    .nullable()
    .optional(),
  breakOver9hOverride: z
    .number()
    .int()
    .min(
      ARBZG_FLOOR_OVER_9H,
      "Pausendauer für Arbeitstage über 9 Stunden darf nicht unter 45 Minuten liegen (ArbZG §4 Pflichtpause).",
    )
    .max(
      BREAK_MAX_OVER_9H,
      "Pausendauer für Arbeitstage über 9 Stunden darf 180 Minuten nicht überschreiten.",
    )
    .nullable()
    .optional(),
  // Phase 85.1.1 (D-01, D-04) — per-employee Phorest Vor-/Nachbereitungszeit
  // Override (create). Plain 0-30 bound (no ArbZG floor). null = fall back to
  // TenantConfig.phorestPrepMinutes/phorestWrapupMinutes; 0 = explicit "no puffer".
  phorestPrepMinutesOverride: z
    .number()
    .int()
    .min(0, "Vorbereitungszeit darf nicht negativ sein.")
    .max(30, "Vorbereitungszeit darf 30 Minuten nicht überschreiten.")
    .nullable()
    .optional(),
  phorestWrapupMinutesOverride: z
    .number()
    .int()
    .min(0, "Nachbereitungszeit darf nicht negativ sein.")
    .max(30, "Nachbereitungszeit darf 30 Minuten nicht überschreiten.")
    .nullable()
    .optional(),
  // Phase 76.31 D-06 — per-employee bsSlot* overrides (create).
  ...bsSlotEmployeeFields,
  // Phase 67b Plan 03 (D-22, issue #67) — the new employee's Stammsalon. Omitted or explicit
  // null resolves automatically when the tenant has exactly one active salon; explicit null is
  // accepted because Clokr frontends send `field: x ? x : null`, never omit the key.
  homeSalonId: z.string().uuid().optional().nullable(),
  // Issue #435 D-02 — base days at a 5-day week, two decimals because the JArbSchG minimum is
  // 20,83 (D-11 pre-fill), Decimal(5,2) column. null = the classification-aware base value from
  // resolveVacationBaseDays() (Issue #482). The statutory-minimum 400 is plan 03's (D-11) and
  // runs in prepareEmployeeCreation, not in Zod.
  annualVacationDays: z
    .number()
    .min(0.5)
    .max(365)
    .refine((v) => Math.round(v * 100) / 100 === v, "Höchstens zwei Nachkommastellen.")
    .optional()
    .nullable(),
  // Issue #435 D-11 (prerequisite): needed at creation so the statutory minimum is checked and
  // applied from day one — mirrors updateEmployeeSchema's identical field (Phase 65).
  birthDate: z.string().datetime().nullable().optional(),
});

export type CreateEmployeeBody = z.infer<typeof createEmployeeSchema>;

// ── Invitation rule ─────────────────────────────────────────────────────────

/** Lifetime of an employee invitation. */
const INVITATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** SHA-256 hash for tokens stored in DB. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Creates the employee's invitation: a random 32-byte token (returned raw, for mailing only),
 * stored hashed, valid for 24 hours. The raw token never reaches a database column.
 */
export async function createEmployeeInvitation(
  db: Pick<Prisma.TransactionClient, "invitation">,
  input: { employeeId: string; email: string },
) {
  const token = crypto.randomBytes(32).toString("hex");
  const invitation = await db.invitation.create({
    data: {
      token: hashToken(token),
      employeeId: input.employeeId,
      email: input.email,
      expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
    },
  });
  return { invitation, token };
}

/**
 * Re-issues an invitation: every open (not yet accepted) invitation of the employee expires
 * now, then a new one is created. Returns the raw token for mailing.
 */
export async function reissueEmployeeInvitation(
  db: Pick<Prisma.TransactionClient, "invitation">,
  input: { employeeId: string; email: string },
): Promise<{ token: string }> {
  await db.invitation.updateMany({
    where: { employeeId: input.employeeId, acceptedAt: null },
    data: { expiresAt: new Date() },
  });
  const { token } = await createEmployeeInvitation(db, input);
  return { token };
}

// ── Audit port ──────────────────────────────────────────────────────────────

/** One pending audit row of the vacation entitlement written at hire time. */
export interface EmployeeCreationEntitlementAuditEntry {
  action: "CREATE";
  entity: "LeaveEntitlement";
  entityId: string;
  newValue: unknown;
}

/** One pending audit row of the Stammsalon (HOME) assignment or of the Employee itself. */
export interface EmployeeCreationAuditEntry {
  entityId: string;
  newValue: object;
}

/**
 * Where the audit rows of an employee creation go and who they are attributed to. The tenant
 * route attributes them to the calling tenant user; the operator path attributes them to the
 * operator. The transaction-bound methods run on the creation transaction `tx`, so an audit
 * failure aborts the creation.
 */
export interface EmployeeCreationAudit {
  vacationEntitlement(
    entry: EmployeeCreationEntitlementAuditEntry,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  roleAssignmentChange(
    change: {
      userId: string;
      entries: RoleAssignmentAuditEntry[];
      compatRole: { from: string; to: string } | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  salonAssignmentCreated(
    entry: EmployeeCreationAuditEntry,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  /** The Employee CREATE row; `tx` is given when the caller writes it inside the transaction. */
  employeeCreated(entry: EmployeeCreationAuditEntry, tx?: Prisma.TransactionClient): Promise<void>;
}

/**
 * The `newValue` of the Employee CREATE audit row — one place, so the route and the operator path
 * record the identical shape.
 */
export function employeeCreatedAuditValue(
  employee: {
    coverageWeight: { toString(): string };
    annualVacationDays: { toString(): string } | null;
  },
  body: Pick<CreateEmployeeBody, "email">,
  workSchedule: {
    type: string;
    contractWorkDaysPerWeek: number | null;
    usualWorkDays: number[];
  },
  directPassword: boolean,
): object {
  return {
    ...employee,
    email: body.email,
    directPassword,
    // Personalstruktur (Phase 41) — Decimal → string for stable JSON
    coverageWeight: employee.coverageWeight.toString(),
    // Issue #435 (D-02) — Decimal → string for stable JSON (same treatment as coverageWeight)
    annualVacationDays: employee.annualVacationDays?.toString() ?? null,
    // Phase 436 Plan 02 (D-02): the initial Angabe must be traceable (CLAUDE.md "prefer
    // creating an audit entry over skipping it").
    workSchedule: {
      type: workSchedule.type,
      contractWorkDaysPerWeek: workSchedule.contractWorkDaysPerWeek,
      usualWorkDays: workSchedule.usualWorkDays,
    },
  };
}

// ── Preparation (before the transaction) ────────────────────────────────────

export type PreparedEmployeeCreation =
  | { ok: false; status: 400; error: string }
  | {
      ok: true;
      passwordHash: string;
      directPassword: boolean;
      resolvedWorkDays: number[];
      usualWorkDays: number[];
      tz: string;
    };

/**
 * Everything that is decided or rejected BEFORE the creation transaction: a rejected body must
 * create neither a User nor an Employee row. Statutory minimum, password policy, workDays
 * resolution, usualWorkDays validation, tenant time zone — with the German messages the route
 * has always answered.
 *
 * `opts.passwordPolicy` is the tenant's loaded policy; the caller loads it when the body carries a
 * password (the operator path never passes a password).
 */
export async function prepareEmployeeCreation(
  db: Pick<Prisma.TransactionClient, "tenantConfig">,
  tenantId: string,
  body: CreateEmployeeBody,
  opts: { passwordPolicy?: PasswordPolicy } = {},
): Promise<PreparedEmployeeCreation> {
  // Issue #435 (D-11): the 5-day base against the 5-day statutory minimum, age at 1 January
  // of the HIRE year — before any write. The regular computation additionally floors per
  // year (D-09, plan 02); this guard only stops an obviously unlawful input value.
  if (body.annualVacationDays != null) {
    const checkYear = new Date(body.hireDate).getUTCFullYear();
    const birthDateForCheck = body.birthDate ? new Date(body.birthDate) : null;
    const minimum = statutoryMinimumVacationDays(birthDateForCheck, checkYear, 5);
    if (Math.round(body.annualVacationDays * 100) < Math.round(minimum * 100)) {
      return {
        ok: false,
        status: 400,
        error: statutoryMinimumViolationMessage(minimum, birthDateForCheck, checkYear),
      };
    }
  }

  const directPassword = !!body.password;
  if (directPassword) {
    // Never skipped: a caller that forgot to load the tenant policy gets the platform default.
    const check = validatePassword(body.password!, opts.passwordPolicy ?? DEFAULT_PASSWORD_POLICY);
    if (!check.valid) {
      return { ok: false, status: 400, error: check.errors.join(". ") };
    }
  }
  const passwordHash = directPassword
    ? await bcrypt.hash(body.password!, 12)
    : await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

  // Phase 49.5 — workdays: body override > tenant default > Mon–Fri.
  // Phase 61 (v1.6.5) — also derive from per-day-hours when the body doesn't
  // carry them. createEmployeeSchema does not accept per-day-hours today, so
  // we synthesize the Prisma schema defaults (Mo-Fr=8, Sat/Sun=0). When a
  // future schema extension adds these fields, the helper picks them up
  // automatically. The tenant default still wins for callers who want a
  // non-Mo-Fr default at hire-time.
  const tenantConfigForDefaults = await db.tenantConfig.findUnique({
    where: { tenantId },
    select: { defaultWorkDays: true },
  });
  const perDayHoursForDerive: PerDayHours = {
    mondayHours: 8,
    tuesdayHours: 8,
    wednesdayHours: 8,
    thursdayHours: 8,
    fridayHours: 8,
    saturdayHours: 0,
    sundayHours: 0,
  };
  const resolvedWorkDays = normalizeWorkDays(
    body.workDays,
    perDayHoursForDerive,
    tenantConfigForDefaults?.defaultWorkDays,
  );

  // Phase 436 Plan 02 (D-02, 436-AC-03): validate BEFORE the transaction — a rejected body
  // must create neither Employee nor User row.
  const usualWorkDaysCheck = validateUsualWorkDays(
    body.scheduleType,
    body.usualWorkDays ?? [],
    contractWorkDaysPerWeekFrom(
      {
        contractWorkDaysPerWeek:
          body.scheduleType === "SHIFT_BASED" ? (body.contractWorkDaysPerWeek ?? 5) : null,
        workDays: resolvedWorkDays,
      },
      tenantConfigForDefaults?.defaultWorkDays,
    ),
  );
  if (!usualWorkDaysCheck.ok) {
    return { ok: false, status: 400, error: usualWorkDaysCheck.error };
  }

  // Phase 67b Plan 03 (D-22, issue #67): only reads TenantConfig (cached), safe before the tx.
  // getTenantTimezone only touches `tenantConfig.findUnique`, which a transaction client has too.
  const tz = await getTenantTimezone(db as unknown as FastifyInstance["prisma"], tenantId);

  return {
    ok: true,
    passwordHash,
    directPassword,
    resolvedWorkDays,
    usualWorkDays: usualWorkDaysCheck.value,
    tz,
  };
}

// ── The transaction body ────────────────────────────────────────────────────

/**
 * Writes the rows of one employee creation on the caller's transaction `tx`, in this order: the
 * Stammsalon resolution (first, so a rejection leaves nothing behind), User, Employee,
 * WorkSchedule, OvertimeAccount, the hire-year vacation entitlement, the system-role assignment,
 * the Stammsalon (HOME) row and — when no password was given — the invitation.
 *
 * Returns the created rows, or the Stammsalon rejection (`SALON_NOT_FOUND`, `SALON_INACTIVE`,
 * `HOME_SALON_REQUIRED`, `NO_ACTIVE_SALON`) for the caller to map. The tenant-user-attributed
 * Employee CREATE audit row is NOT written here; the caller writes it through
 * `audit.employeeCreated` after (route) or inside (operator) its transaction.
 */
export async function createEmployeeInTransaction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  body: CreateEmployeeBody,
  prepared: Extract<PreparedEmployeeCreation, { ok: true }>,
  audit: EmployeeCreationAudit,
) {
  const { passwordHash, directPassword, resolvedWorkDays, usualWorkDays, tz } = prepared;

  // D-22/D-02: the FIRST statement in the transaction — a rejected outcome below returns
  // before any write, so a 400 never leaves behind a User, Employee or assignment row.
  const salonOutcome = await resolveHomeSalonForNewEmployee(tx, tenantId, body.homeSalonId);
  if (salonOutcome.status !== "OK") return salonOutcome;

  const user = await tx.user.create({
    data: {
      email: body.email,
      passwordHash,
      role: body.role,
      isActive: directPassword, // active immediately when a password was given
    },
  });

  const emp = await tx.employee.create({
    data: {
      tenantId,
      userId: user.id,
      firstName: body.firstName,
      lastName: body.lastName,
      employeeNumber: body.employeeNumber,
      hireDate: new Date(body.hireDate),
      nfcCardId: body.nfcCardId,
      // Personalstruktur (Phase 41) — schema defaults apply if omitted
      ...(body.classification !== undefined ? { classification: body.classification } : {}),
      ...(body.coverageWeight !== undefined ? { coverageWeight: body.coverageWeight } : {}),
      ...(body.requiresSupervision !== undefined
        ? { requiresSupervision: body.requiresSupervision }
        : {}),
      // Phase 64 (D-08, BREAK-02): per-employee break override on create.
      // undefined / omitted → null (fall back to tenant default).
      breakOver6hOverride: body.breakOver6hOverride ?? null,
      breakOver9hOverride: body.breakOver9hOverride ?? null,
      // Phase 85.1.1 (D-01, D-04): per-employee Phorest puffer override on
      // create. undefined / omitted → null (fall back to tenant default).
      phorestPrepMinutesOverride: body.phorestPrepMinutesOverride ?? null,
      phorestWrapupMinutesOverride: body.phorestWrapupMinutesOverride ?? null,
      // Phase 76.31 (D-06): per-employee bsSlot* overrides on create.
      // undefined / omitted → null (delegate down the slot hierarchy).
      bsSlotFirstLongDayMinutes: body.bsSlotFirstLongDayMinutes ?? null,
      bsSlotSecondLongDayMinutes: body.bsSlotSecondLongDayMinutes ?? null,
      bsSlotShortDayMinutes: body.bsSlotShortDayMinutes ?? null,
      bsSlotBlockWeekMinutes: body.bsSlotBlockWeekMinutes ?? null,
      // Issue #482: per-person vacation base value, null = the classification's own
      // Standard, resolved by resolveVacationBaseDays().
      annualVacationDays: body.annualVacationDays ?? null,
      // Issue #435 (D-11 prerequisite): needed at creation for the statutory-minimum floor.
      birthDate: body.birthDate ? new Date(body.birthDate) : null,
    },
  });

  const workSchedule = await tx.workSchedule.create({
    data: {
      employeeId: emp.id,
      type: body.scheduleType,
      // For SHIFT_BASED: default to 40h if caller omits weeklyHours (null/0/undefined)
      weeklyHours: body.scheduleType === "SHIFT_BASED" ? body.weeklyHours || 40 : body.weeklyHours,
      monthlyHours: body.monthlyHours ?? null,
      // Phase 49.2 — FLEXTIME Kernarbeitszeit (only persisted when FLEXTIME)
      coreStart: body.scheduleType === "FLEXTIME" ? (body.coreStart ?? null) : null,
      coreEnd: body.scheduleType === "FLEXTIME" ? (body.coreEnd ?? null) : null,
      coreDays: body.scheduleType === "FLEXTIME" ? (body.coreDays ?? []) : [],
      workDays: resolvedWorkDays,
      // Phase 107 (D-01, issue #94) — mirrors the weeklyHours SHIFT_BASED
      // default-if-omitted convention above. Initial schedule on employee
      // creation is a contract START (not a contract CHANGE), so workDays
      // above is still allowed to resolve/derive normally — only the D-02
      // freeze on the settings.ts re-save path is exempted from this.
      contractWorkDaysPerWeek:
        body.scheduleType === "SHIFT_BASED" ? (body.contractWorkDaysPerWeek ?? 5) : null,
      // Phase 436 Plan 02 (D-02): the Angabe is only ever non-empty for SHIFT_BASED,
      // validated by prepareEmployeeCreation before this transaction started.
      usualWorkDays: body.scheduleType === "SHIFT_BASED" ? usualWorkDays : [],
      validFrom: new Date(body.hireDate),
    },
  });

  await createOvertimeAccount(tx, emp.id, tenantId);

  // Issue #416: auto-seed the new hire's VACATION LeaveEntitlement for their hire year —
  // no code path previously created one, leaving new employees with no Urlaubsanspruch
  // until an admin happened to open the Urlaubsanspruch tab. Runs on `tx` (invariant-
  // carrying, ADR 0002 Entscheidung 10): if this fails, the whole employee-creation
  // transaction rolls back rather than committing an employee with a silently missing
  // entitlement. The create path itself has no classification branch of its own — since
  // Issue #482 the Azubi-Standard is resolved inside resolveVacationBaseDays() below, the
  // one place that chain lives.
  const workDaysPerWeek =
    body.scheduleType === "SHIFT_BASED"
      ? (body.contractWorkDaysPerWeek ?? 5)
      : // Mirrors countWorkDaysPerWeek()'s workDays.length tier — the same raw input
        // resolvedWorkDays above already resolved for the WorkSchedule row.
        resolvedWorkDays.length;
  // Issue #482: the ONE base-value resolution — the classification-aware base value from
  // resolveVacationBaseDays() — on `tx` since `emp` already exists inside this transaction.
  const vacationBaseDays = await resolveVacationBaseDays(tx, emp.id, tenantId);
  await ensureVacationEntitlementForYear(
    tx,
    emp.id,
    tenantId,
    emp.hireDate.getFullYear(),
    emp.hireDate,
    emp.birthDate,
    // Issue #447 (D-05): the create schema has no exitDate field, so this is always null at
    // hire time — passed anyway, truthfully, now that the parameter is required.
    emp.exitDate,
    workDaysPerWeek,
    vacationBaseDays,
    "Automatisch angelegt bei Mitarbeiteranlage",
    (entry) => audit.vacationEntitlement(entry, tx),
  );

  // Phase 75b (D-15): the new user's system-role assignment and its audit row, in this same
  // transaction. A grant cannot lower any holder count, so it takes the tenant lock (which
  // serialises it with every guarded role change) but needs no before/after count. The
  // column already holds `body.role`, so the write-back is a no-op kept for one uniform path.
  await lockTenantForRoleChanges(tx, tenantId);
  const { created: roleAssignment } = await replaceSystemRoleAssignment(
    tx,
    tenantId,
    user.id,
    body.role,
  );
  await audit.roleAssignmentChange(
    {
      userId: user.id,
      entries: roleAssignment !== null ? [createdAssignmentAuditEntry(roleAssignment)] : [],
      compatRole: await syncCompatRoleColumn(tx, tenantId, user.id),
    },
    tx,
  );

  // D-22: the new employee's Stammsalon (HOME) row, open-ended from its tenant-local hire
  // day, in the SAME transaction — audited CREATE right after, still inside the tx.
  const homeAssignment = await createInitialHomeAssignment(
    tx,
    tenantId,
    emp.id,
    salonOutcome.salonId,
    tenantLocalDay(emp.hireDate, tz),
  );
  await audit.salonAssignmentCreated(
    { entityId: homeAssignment.id, newValue: toAssignmentDto(homeAssignment) },
    tx,
  );

  // Only create an invitation when no password was given
  let token: string | null = null;
  let invitation: { expiresAt: Date; acceptedAt: Date | null } | null = null;
  if (!directPassword) {
    const created = await createEmployeeInvitation(tx, { employeeId: emp.id, email: body.email });
    token = created.token;
    invitation = created.invitation;
  }

  return {
    status: "OK" as const,
    employee: emp,
    user,
    workSchedule,
    invitation,
    invitationToken: token,
  };
}
