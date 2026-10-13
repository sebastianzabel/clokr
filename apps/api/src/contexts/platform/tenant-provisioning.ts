/**
 * Phase 88 (D-04/D-04a) — the ONE API-side place of the tenant-skeleton rule:
 * a tenant consists of the Tenant row, its TenantConfig and exactly one active default salon that
 * is named after the tenant, carries the requested Bundesland and
 * `DEFAULT_SALON_OPENING_HOURS`.
 *
 * Layers:
 * - L1 `createTenantWithConfig` — Tenant + TenantConfig (every other config column keeps its
 *   schema default).
 * - L2 `provisionTenant` — L1 + the default salon.
 * - L3 `provisionTenantWithAdmin` — L2 + the first tenant admin, created by the SAME code as every
 *   other employee (`employee-creation.ts`), in the same transaction. Its audit rows go through
 *   `operatorEmployeeCreationAudit`: `AuditLog.userId` stays empty and `newValue.actor` names the
 *   operator, so nothing is ever written "as if a tenant user did it" (D-07).
 *
 * Every function takes the caller's transaction client, so the caller decides atomicity and an
 * audit row can land in the same transaction. L1 and L2 write no audit row themselves: they have
 * no request principal (the test bootstrap has none either). L3 writes the audit rows of the
 * employee creation through the port it is given.
 *
 * Why the seeds keep a pinned copy: `packages/db` cannot import `apps/api` (research F1,
 * `packages/db/src/default-salon.ts`), so `seed.ts` / `seed-demo.ts` carry their own bootstrap.
 * `tenant-provisioning-88.test.ts` pins them to this rule at source level — a change to one
 * without the other turns that test red.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { FederalState, Prisma } from "@clokr/db";
import { DEFAULT_SALON_OPENING_HOURS, createSalon } from "./facade/salons.js";
import {
  createEmployeeInTransaction,
  createEmployeeSchema,
  employeeCreatedAuditValue,
  prepareEmployeeCreation,
  type EmployeeCreationAudit,
} from "./employee-creation.js";
import { tenantLocalDay } from "./salon-assignment-rules.js";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "./operator-audit.js";
import { reissueEmployeeInvitation } from "./employee-creation.js";

export interface TenantProvisioningInput {
  /** Explicit tenant id (test fixtures only); omitted, the schema generates one. */
  id?: string;
  name: string;
  slug: string;
  /**
   * The Bundesland decides the statutory holidays of every employee of the tenant (#71). It is
   * REQUIRED and always taken from the caller — never silently from the Tenant column default.
   */
  federalState: FederalState;
  /** Tenant-local IANA zone; omitted, TenantConfig keeps its schema default. */
  timezone?: string;
}

/** L1: the Tenant row and its TenantConfig. */
export async function createTenantWithConfig(
  db: Prisma.TransactionClient,
  input: TenantProvisioningInput,
) {
  const tenant = await db.tenant.create({
    data: {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      slug: input.slug,
      federalState: input.federalState,
    },
  });
  const config = await db.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    },
  });
  return { tenant, config };
}

/** L2: L1 plus the tenant's active default salon, in the caller's Bundesland. */
export async function provisionTenant(
  db: Prisma.TransactionClient,
  input: TenantProvisioningInput,
) {
  const { tenant, config } = await createTenantWithConfig(db, input);
  const salon = await createSalon(db, tenant.id, {
    name: tenant.name,
    // Passed explicitly: createSalon would otherwise read the tenant column, which is the very
    // inheritance this function must not rely on (T-88-20).
    federalState: input.federalState,
    openingHours: DEFAULT_SALON_OPENING_HOURS,
    // CreateSalonInput is the parsed output type, so the address keys are spelled out.
    street: null,
    postalCode: null,
    city: null,
  });
  return { tenant, config, salon };
}

// ── L3: the tenant with its first admin ─────────────────────────────────────

type AuditRequestLike = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

/** The actor metadata of an operator-attributed `AuditLog.newValue`. */
function operatorActor(operatorId: string) {
  return { type: "OPERATOR" as const, operatorId };
}

/**
 * The employee-creation audit port of the operator path (D-07, research A8). It writes the same
 * `AuditLog` actions and entities as the tenant port — a tenant admin reading the history of a
 * provisioned employee sees the same rows — but with `userId` empty and `newValue.actor =
 * { type: "OPERATOR", operatorId }`, mirroring the API-key idiom of `plugins/audit.ts`. A tenant
 * user's id is never used: the operator did this, not a tenant principal. The operator's own
 * accountability row (`TENANT_CREATED`) goes to `OperatorAuditLog` and is written by the caller.
 */
export function operatorEmployeeCreationAudit(
  app: FastifyInstance,
  input: { operatorId: string; request?: AuditRequestLike },
): EmployeeCreationAudit {
  const actor = operatorActor(input.operatorId);
  const write = (
    entry: {
      action: string;
      entity: string;
      entityId: string;
      oldValue?: unknown;
      newValue?: object;
    },
    tx?: Prisma.TransactionClient,
  ) =>
    app.audit({
      userId: undefined,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      oldValue: entry.oldValue,
      newValue: { ...(entry.newValue ?? {}), actor },
      request: input.request,
      tx,
    });

  return {
    vacationEntitlement: (entry, tx) =>
      write(
        {
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId,
          newValue: entry.newValue as object,
        },
        tx,
      ),
    roleAssignmentChange: async (change, tx) => {
      const { entries, compatRole } = change;
      // Same shape as auditRoleAssignmentChange: the compat-column change rides on the LAST row,
      // or becomes one UPDATE row on `User` when no assignment row was written.
      if (compatRole !== null && entries.length === 0) {
        await write(
          { action: "UPDATE", entity: "User", entityId: change.userId, newValue: { compatRole } },
          tx,
        );
        return;
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLast = i === entries.length - 1;
        await write(
          {
            action: entry.action,
            entity: "RoleAssignment",
            entityId: entry.entityId,
            oldValue: entry.oldValue,
            newValue:
              isLast && compatRole !== null
                ? { ...(entry.newValue ?? {}), compatRole }
                : entry.newValue,
          },
          tx,
        );
      }
    },
    salonAssignmentCreated: (entry, tx) =>
      write(
        {
          action: "CREATE",
          entity: "EmployeeSalonAssignment",
          entityId: entry.entityId,
          newValue: entry.newValue,
        },
        tx,
      ),
    employeeCreated: (entry, tx) =>
      write(
        {
          action: "CREATE",
          entity: "Employee",
          entityId: entry.entityId,
          newValue: entry.newValue,
        },
        tx,
      ),
  };
}

export interface TenantWithAdminInput {
  tenant: TenantProvisioningInput;
  admin: {
    email: string;
    firstName: string;
    lastName: string;
    /** Defaults to "1": the first employee of a brand-new tenant. */
    employeeNumber?: string;
  };
  /**
   * Runs in the caller's transaction right after the tenant skeleton exists and BEFORE the first
   * admin is created. It is how a layer above (the composition root) adds what the Unterbau may
   * not import itself — the default leave types of the absence context — so that the admin's
   * hire-year vacation entitlement, written by the shared employee-creation code, finds its
   * leave type. No business rule lives in this seam: it only runs the callback.
   */
  onTenantCreated?: (tx: Prisma.TransactionClient, tenantId: string) => Promise<void>;
}

export type ProvisionTenantWithAdminResult =
  | {
      status: "OK";
      tenant: Awaited<ReturnType<typeof provisionTenant>>["tenant"];
      config: Awaited<ReturnType<typeof provisionTenant>>["config"];
      salon: Awaited<ReturnType<typeof provisionTenant>>["salon"];
      employee: { id: string; hireDate: Date };
      user: { id: string; email: string };
      /**
       * The RAW invitation token. It exists to be mailed to the admin and must never be put into
       * an HTTP response (T-88-48): whoever holds it sets the admin's password.
       */
      invitationToken: string;
    }
  | { status: "SLUG_TAKEN" }
  | { status: "EMAIL_TAKEN" }
  | { status: "INVALID"; error: string };

/**
 * Thrown by L3 when a unique constraint is hit AFTER the pre-checks (two operators racing for the
 * same slug or e-mail). The caller's transaction is already poisoned at that point, so the error
 * propagates and rolls it back; the caller maps `status` to its HTTP answer.
 */
export class TenantProvisioningConflictError extends Error {
  constructor(readonly status: "SLUG_TAKEN" | "EMAIL_TAKEN") {
    super(status);
    this.name = "TenantProvisioningConflictError";
  }
}

function conflictFromUniqueViolation(err: unknown): "SLUG_TAKEN" | "EMAIL_TAKEN" | null {
  if (typeof err !== "object" || err === null || !("code" in err) || err.code !== "P2002") {
    return null;
  }
  const target = String(
    (err as { meta?: { target?: unknown } }).meta?.target ?? (err as { message?: unknown }).message,
  );
  if (target.includes("slug")) return "SLUG_TAKEN";
  if (target.includes("email")) return "EMAIL_TAKEN";
  return null;
}

/**
 * L3: L2 plus the first tenant admin, in the caller's transaction (all or nothing).
 *
 * The admin is created through `createEmployeeInTransaction` — the code every other employee goes
 * through — with: role ADMIN, Stammsalon = the new default salon, hire date = the tenant-local
 * today, an invitation (24 h) instead of a password.
 *
 * Why a track-only `MONTHLY_HOURS` contract without monthly hours: the tenant has configured no
 * real contract yet, and any Soll-bearing contract would start accruing a phantom saldo for an
 * account nobody time-tracks on yet (CLAUDE.md "track-only" rule: `monthlyHours` null/0 is pure
 * time tracking, saldo 0). The tenant changes the contract later like any other.
 *
 * `invitationToken` is for the invitation mail only.
 */
export async function provisionTenantWithAdmin(
  tx: Prisma.TransactionClient,
  input: TenantWithAdminInput,
  audit: EmployeeCreationAudit,
): Promise<ProvisionTenantWithAdminResult> {
  if (await tx.tenant.findUnique({ where: { slug: input.tenant.slug }, select: { id: true } })) {
    return { status: "SLUG_TAKEN" };
  }
  if (await tx.user.findUnique({ where: { email: input.admin.email }, select: { id: true } })) {
    return { status: "EMAIL_TAKEN" };
  }

  // Validate the admin input BEFORE the first write, so an INVALID answer leaves nothing behind.
  // The salon id and the hire day are placeholders here; the real ones are known only afterwards.
  const adminBody = (hireDate: string, homeSalonId: string) => ({
    email: input.admin.email,
    firstName: input.admin.firstName,
    lastName: input.admin.lastName,
    employeeNumber: input.admin.employeeNumber ?? "1",
    hireDate,
    role: "ADMIN" as const,
    scheduleType: "MONTHLY_HOURS" as const,
    monthlyHours: null,
    homeSalonId,
  });
  const precheck = createEmployeeSchema.safeParse(
    adminBody("2000-01-01T00:00:00.000Z", randomUUID()),
  );
  if (!precheck.success) {
    return { status: "INVALID", error: precheck.error.issues.map((i) => i.message).join(". ") };
  }

  try {
    const { tenant, config, salon } = await provisionTenant(tx, input.tenant);
    await input.onTenantCreated?.(tx, tenant.id);

    // Midnight UTC of the tenant-local day: the Stammsalon row starts on that same local day.
    const hireDay = tenantLocalDay(new Date(), config.timezone);
    const body = createEmployeeSchema.parse(adminBody(`${hireDay}T00:00:00.000Z`, salon.id));

    const prepared = await prepareEmployeeCreation(tx, tenant.id, body);
    // Cannot fail for this input (no password, no vacation override, empty usual workdays on a
    // MONTHLY_HOURS contract); if it ever does, throwing rolls the whole provisioning back.
    if (!prepared.ok) throw new Error(`First-admin preparation failed: ${prepared.error}`);

    const created = await createEmployeeInTransaction(tx, tenant.id, body, prepared, audit);
    if (created.status !== "OK") {
      // Unreachable for a tenant that has exactly its default salon; fail closed regardless.
      throw new Error(`First-admin Stammsalon not resolvable: ${created.status}`);
    }
    await audit.employeeCreated(
      {
        entityId: created.employee.id,
        newValue: employeeCreatedAuditValue(
          created.employee,
          body,
          created.workSchedule,
          prepared.directPassword,
        ),
      },
      tx,
    );

    return {
      status: "OK",
      tenant,
      config,
      salon,
      employee: { id: created.employee.id, hireDate: created.employee.hireDate },
      user: { id: created.user.id, email: created.user.email },
      invitationToken: created.invitationToken!,
    };
  } catch (err) {
    const conflict = conflictFromUniqueViolation(err);
    if (conflict) throw new TenantProvisioningConflictError(conflict);
    throw err;
  }
}

// ── Re-issuing the first admin's invitation ─────────────────────────────────

export type ResendFirstAdminInvitationResult =
  | {
      status: "OK";
      employee: { id: string; firstName: string };
      email: string;
      /** The RAW token: for the invitation mail only, never for an HTTP response (T-88-52). */
      token: string;
    }
  | { status: "NOT_FOUND" }
  | { status: "TENANT_DEACTIVATED" }
  | { status: "TENANT_IN_USE" }
  | { status: "NO_PENDING_INVITATION" };

/**
 * Re-issues the invitation of the provisioned first admin, inside the caller's transaction, and
 * writes `ADMIN_INVITATION_RESENT` (employee id only, no e-mail address) to the operator audit log.
 *
 * This is the BOOTSTRAP WINDOW only: it is allowed while the tenant is not deactivated and no user
 * of the tenant is active yet, i.e. while the operator's mail never arrived or expired and nobody
 * can sign in to resend it from the tenant UI. Afterwards invitations are the tenant's own
 * business. The pending employee is the one whose user is still inactive — by construction the
 * provisioned admin.
 */
export async function resendFirstAdminInvitation(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { operatorId: string; request?: AuditRequestLike },
): Promise<ResendFirstAdminInvitationResult> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, deactivatedAt: true },
  });
  if (!tenant) return { status: "NOT_FOUND" };
  if (tenant.deactivatedAt) return { status: "TENANT_DEACTIVATED" };

  const activeUsers = await tx.user.count({ where: { isActive: true, employee: { tenantId } } });
  if (activeUsers > 0) return { status: "TENANT_IN_USE" };

  const pending = await tx.employee.findFirst({
    where: { tenantId, user: { isActive: false } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, firstName: true, user: { select: { email: true } } },
  });
  if (!pending) return { status: "NO_PENDING_INVITATION" };

  const { token } = await reissueEmployeeInvitation(tx, {
    employeeId: pending.id,
    email: pending.user.email,
  });
  await recordOperatorAudit(tx, {
    action: OPERATOR_AUDIT_ACTIONS.ADMIN_INVITATION_RESENT,
    operatorId: input.operatorId,
    subjectTenantId: tenantId,
    entity: "Employee",
    entityId: pending.id,
    newValue: { employeeId: pending.id },
    request: input.request,
  });
  return {
    status: "OK",
    employee: { id: pending.id, firstName: pending.firstName },
    email: pending.user.email,
    token,
  };
}
