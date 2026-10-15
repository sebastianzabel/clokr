/**
 * Support access (Issue #93, Phase 93b-01) — a time-boxed, read-only, fully logged view of one tenant's
 * data for the operator principal.
 *
 * This is the ONE place that decides whether a support access is active (D-10): `assertActiveSupportAccess`
 * is the only reader of the question, `isSupportAccessActive` / `supportAccessStatus` the only definition
 * of the predicate for rows already in memory. A grant is active exactly while `endedAt IS NULL AND
 * expiresAt > now`. Expiry is derived per request from the application clock (D-22) — there is no cron
 * and no row is written when a grant lapses; tests seed already-expired rows directly.
 *
 * Grant creation runs under the Tenant row lock (`FOR NO KEY UPDATE`, the same anchor as the package
 * rules, D-12) in READ COMMITTED on purpose (D-23): a probe on PostgreSQL 18 showed that REPEATABLE READ
 * keeps the snapshot of the first statement and therefore does NOT see a grant a parallel request
 * committed while this one waited on the lock. Never pass an isolation level to the transaction below.
 *
 * Reads are audit-first (D-19): the caller writes both audit rows with `writeSupportReadAudit` BEFORE it
 * reads any tenant data, so a failing audit write returns nothing. With `lockGrant` the decider also
 * holds the grant row `FOR SHARE` until the transaction ends, which closes the check-then-audit window
 * against a concurrent end (see the option below).
 *
 * Every function takes a required `tenantId: string` (the nullish-tenant rule: Prisma drops a filter
 * whose value is `undefined`). The decider, the grant writer and the audit writers stay internal to the
 * platform context; `index.ts` re-exports only the types and the employee status helper.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient, SupportAccess } from "@clokr/db";
import { isAnonymizedEmployee } from "./employee-anonymization-filter";
import { userIdsHoldingPermission } from "./facade/role-assignments";
import { readTenantTimezone } from "./facade/salon-assignments";
import {
  OPERATOR_AUDIT_ACTIONS,
  OPERATOR_AUDIT_RETENTION_MONTHS,
  operatorAuditRequestFields,
  recordOperatorAudit,
  subtractUtcMonths,
} from "./operator-audit";
import { operatorTenantAudit } from "./operator-tenant-audit";
import { isTenantRowActive } from "./tenant-status";
import { lockTenantForPackages } from "./tenant-packages";
import type {
  SupportAccessDto,
  SupportAccessEndedBy,
  SupportAccessStatus,
  SupportReadCategory,
} from "./support-access-types";

// ── Constants (D-02, D-03) ────────────────────────────────────────────────────────────────────────

/** The durations an operator can choose; the server never accepts a free end time. */
export const SUPPORT_ACCESS_DURATION_HOURS = [1, 4, 8, 24] as const;
export type SupportAccessDurationHours = (typeof SUPPORT_ACCESS_DURATION_HOURS)[number];
export const SUPPORT_ACCESS_DEFAULT_HOURS: SupportAccessDurationHours = 1;

/** Bounds of the trimmed reason text (D-03). */
export const SUPPORT_ACCESS_REASON_MIN = 10;
export const SUPPORT_ACCESS_REASON_MAX = 500;

const MS_PER_HOUR = 3_600_000;

type SupportRequestLike = NonNullable<Parameters<typeof operatorAuditRequestFields>[0]>;

// ── The predicate (D-10) ──────────────────────────────────────────────────────────────────────────

/** Active ⇔ not ended and not yet expired at `now`. The only definition for rows held in memory. */
export function isSupportAccessActive(
  row: { endedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return row.endedAt === null && row.expiresAt.getTime() > now.getTime();
}

/** ENDED when `endedAt` is set, else ACTIVE while the window is open, else EXPIRED. */
export function supportAccessStatus(
  row: { endedAt: Date | null; expiresAt: Date },
  now: Date,
): SupportAccessStatus {
  if (row.endedAt !== null) return "ENDED";
  return isSupportAccessActive(row, now) ? "ACTIVE" : "EXPIRED";
}

// ── The decider (D-10, D-22, D-28) ────────────────────────────────────────────────────────────────

export type ActiveSupportAccessResult =
  | { status: "OK"; accessId: string; reason: string; expiresAt: Date }
  | { status: "TENANT_NOT_FOUND" }
  | { status: "TENANT_DEACTIVATED" }
  | { status: "REQUIRED" };

/**
 * Whether `operatorId` holds an active grant for `tenantId` at `now` (the application clock). A grant of
 * operator A never matches operator B and a grant of tenant A never matches tenant B. A deactivated
 * tenant is refused even with a running grant (D-28), an unknown tenant is reported as such so the
 * caller can answer its usual 404.
 *
 * `options.lockGrant` (valid only inside a transaction): the active row found is re-read with the same
 * active predicate plus its id, tenant and operator under `FOR SHARE`. The share lock conflicts with the
 * single end transition (an UPDATE), so an end waits for an in-flight read audit, and a read audit waits
 * for an uncommitted end — whose committed row READ COMMITTED then re-evaluates against
 * `"endedAt" IS NULL`, finds no row and answers REQUIRED. No `SUPPORT_DATA_READ` row is therefore ever
 * written after an end committed (the check-then-audit window of D-19). The window between the committed
 * audit and the read itself is inherent in audit-first and documented in the ADR. A row lock fires no
 * trigger.
 */
export async function assertActiveSupportAccess(
  db: Prisma.TransactionClient,
  input: { tenantId: string; operatorId: string },
  now: Date = new Date(),
  options: { lockGrant?: boolean } = {},
): Promise<ActiveSupportAccessResult> {
  const tenant = await db.tenant.findUnique({
    where: { id: input.tenantId },
    select: { deactivatedAt: true },
  });
  if (!tenant) return { status: "TENANT_NOT_FOUND" };
  if (!isTenantRowActive(tenant)) return { status: "TENANT_DEACTIVATED" };

  const grant = await db.supportAccess.findFirst({
    where: {
      tenantId: input.tenantId,
      operatorId: input.operatorId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, reason: true, expiresAt: true },
  });
  if (!grant) return { status: "REQUIRED" };

  if (options.lockGrant) {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "SupportAccess"
      WHERE "id" = ${grant.id}
        AND "tenantId" = ${input.tenantId}
        AND "operatorId" = ${input.operatorId}
        AND "endedAt" IS NULL
        AND "expiresAt" > ${now}::timestamptz
      FOR SHARE`;
    if (locked.length === 0) return { status: "REQUIRED" };
  }

  return { status: "OK", accessId: grant.id, reason: grant.reason, expiresAt: grant.expiresAt };
}

// ── Grant creation (D-02, D-03, D-04, D-06, D-12, D-23) ───────────────────────────────────────────

export type CreateSupportAccessResult =
  | { status: "NOT_FOUND" }
  | { status: "TENANT_DEACTIVATED" }
  | { status: "ALREADY_ACTIVE" }
  | { status: "CREATED"; row: SupportAccess };

export interface CreateSupportAccessInput {
  tenantId: string;
  operatorId: string;
  reason: string;
  durationHours: SupportAccessDurationHours;
  request?: SupportRequestLike;
}

/**
 * The body of grant creation, inside the caller's transaction. The first statement takes the Tenant row
 * lock, so two parallel requests of one operator serialise and the loser sees the winner's committed row
 * (READ COMMITTED). Writes the start row to the OperatorAuditLog (with IP/UA) and to the tenant's own
 * AuditLog (actor stamp, no IP/UA) in the same transaction.
 */
export async function createSupportAccessInTx(
  app: FastifyInstance,
  tx: Prisma.TransactionClient,
  input: CreateSupportAccessInput,
  now: Date = new Date(),
): Promise<CreateSupportAccessResult> {
  await lockTenantForPackages(tx, input.tenantId);

  const tenant = await tx.tenant.findUnique({
    where: { id: input.tenantId },
    select: { deactivatedAt: true },
  });
  if (!tenant) return { status: "NOT_FOUND" };
  if (!isTenantRowActive(tenant)) return { status: "TENANT_DEACTIVATED" };

  const active = await tx.supportAccess.findFirst({
    where: {
      tenantId: input.tenantId,
      operatorId: input.operatorId,
      endedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (active) return { status: "ALREADY_ACTIVE" };

  const expiresAt = new Date(now.getTime() + input.durationHours * MS_PER_HOUR);
  const row = await tx.supportAccess.create({
    data: {
      tenantId: input.tenantId,
      operatorId: input.operatorId,
      reason: input.reason,
      startedAt: now,
      expiresAt,
    },
  });

  const newValue = {
    reason: row.reason,
    expiresAt: expiresAt.toISOString(),
    durationHours: input.durationHours,
  };
  await recordOperatorAudit(tx, {
    action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_STARTED,
    operatorId: input.operatorId,
    subjectTenantId: input.tenantId,
    entity: "SupportAccess",
    entityId: row.id,
    newValue,
    request: input.request,
  });
  await operatorTenantAudit(app, { operatorId: input.operatorId, tenantId: input.tenantId })(
    {
      action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_STARTED,
      entity: "SupportAccess",
      entityId: row.id,
      newValue,
    },
    tx,
  );
  return { status: "CREATED", row };
}

/**
 * Grant creation in its own transaction. READ COMMITTED on purpose (D-23): never add an isolation level
 * here — REPEATABLE READ would defeat the lock (see the file header). The explicit timeout and maxWait
 * keep a request that waits on the Tenant lock from tripping Prisma's short interactive default.
 */
export async function createSupportAccess(
  app: FastifyInstance,
  input: CreateSupportAccessInput,
  now: Date = new Date(),
): Promise<CreateSupportAccessResult> {
  return app.prisma.$transaction((tx) => createSupportAccessInTx(app, tx, input, now), {
    timeout: 15_000,
    maxWait: 15_000,
  });
}

// ── Audit writers (D-06) ──────────────────────────────────────────────────────────────────────────

/**
 * A support read without an active grant (D-06). Own transaction: the refusal must persist although
 * nothing else happens. Entity "Route", entityId = the route pattern, so the log shows what was tried.
 */
export async function recordSupportAccessRefused(
  db: PrismaClient,
  input: {
    operatorId: string;
    tenantId: string;
    method: string;
    route: string;
    code: string;
    request?: SupportRequestLike;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await recordOperatorAudit(tx, {
      action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_REFUSED,
      operatorId: input.operatorId,
      subjectTenantId: input.tenantId,
      entity: "Route",
      entityId: input.route,
      newValue: { method: input.method, code: input.code },
      request: input.request,
    });
  });
}

/** What a read audit row records about the read (D-06); `category` is a control value. */
export interface SupportReadAuditValue {
  category: SupportReadCategory;
  employeeId?: string;
  month?: string;
  filters?: Record<string, unknown>;
  reason: string;
}

/**
 * One read, two rows, inside the caller's transaction (D-06, D-19): the OperatorAuditLog row carries the
 * client address and user agent, the tenant AuditLog row carries the operator stamp and neither (data
 * minimisation). A failing transaction persists neither, so no data is released without its record.
 */
export async function writeSupportReadAudit(
  app: FastifyInstance,
  tx: Prisma.TransactionClient,
  input: {
    operatorId: string;
    tenantId: string;
    accessId: string;
    newValue: SupportReadAuditValue;
    request?: SupportRequestLike;
  },
): Promise<void> {
  await recordOperatorAudit(tx, {
    action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ,
    operatorId: input.operatorId,
    subjectTenantId: input.tenantId,
    entity: "SupportAccess",
    entityId: input.accessId,
    newValue: input.newValue,
    request: input.request,
  });
  await operatorTenantAudit(app, { operatorId: input.operatorId, tenantId: input.tenantId })(
    {
      action: OPERATOR_AUDIT_ACTIONS.SUPPORT_DATA_READ,
      entity: "SupportAccess",
      entityId: input.accessId,
      newValue: input.newValue,
    },
    tx,
  );
}

// ── DTO and employee status ───────────────────────────────────────────────────────────────────────

function parseEndedBy(value: string | null): SupportAccessEndedBy | null {
  return value === "OPERATOR" || value === "TENANT" ? value : null;
}

/** Operator view of a grant. Explicit keys only, never a row spread; the duration is derived from the window. */
export function toSupportAccessDto(row: SupportAccess, now: Date): SupportAccessDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    reason: row.reason,
    durationHours: Math.round((row.expiresAt.getTime() - row.startedAt.getTime()) / MS_PER_HOUR),
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedBy: parseEndedBy(row.endedBy),
    status: supportAccessStatus(row, now),
  };
}

/**
 * Status of an employee in the support list: the anonymisation sentinel first, then an exit date
 * strictly before `today`; an exit today or later is still ACTIVE.
 */
export function supportEmployeeStatus(
  row: { firstName: string; lastName: string; exitDate: Date | null },
  today: Date,
): "ACTIVE" | "EXITED" | "ANONYMIZED" {
  if (isAnonymizedEmployee(row)) return "ANONYMIZED";
  if (row.exitDate !== null && row.exitDate.getTime() < today.getTime()) return "EXITED";
  return "ACTIVE";
}

// ── Operator history and early end (D-02, D-03, D-06) ─────────────────────────────────────────────

/** Newest grants returned by the operator history; older rows stay in the table, never in the view. */
const SUPPORT_ACCESS_HISTORY_LIMIT = 50;

/**
 * The grants of ONE operator for ONE tenant, newest `startedAt` first (at most 50), plus the one the
 * decider would accept right now. Reads only `SupportAccess` and never another operator's rows: both the
 * tenant and the operator are part of the single `where`.
 */
export async function listSupportAccessesForOperator(
  db: Prisma.TransactionClient,
  input: { tenantId: string; operatorId: string },
  now: Date = new Date(),
): Promise<{ active: SupportAccessDto | null; history: SupportAccessDto[] }> {
  const rows = await db.supportAccess.findMany({
    where: { tenantId: input.tenantId, operatorId: input.operatorId },
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    take: SUPPORT_ACCESS_HISTORY_LIMIT,
  });
  const history = rows.map((row) => toSupportAccessDto(row, now));
  const active = history.find((grant) => grant.status === "ACTIVE") ?? null;
  return { active, history };
}

export type EndSupportAccessResult =
  | { status: "NOT_FOUND" }
  | { status: "NOT_ACTIVE" }
  | { status: "ENDED"; access: SupportAccessDto };

/**
 * The operator ends its own active grant early. The guarded `updateMany` is the single transition the
 * database trigger allows (`endedAt` and `endedBy` set once, nothing else changed); `endedAt IS NULL` and
 * `expiresAt > now` in the `where` make a second end and the end of a lapsed grant a no-op. A grant of
 * another operator or tenant is looked up with the same keys, so it is indistinguishable from an unknown
 * id (`NOT_FOUND`). Both audit rows are written in the same transaction.
 */
export async function endSupportAccessByOperator(
  app: FastifyInstance,
  input: {
    tenantId: string;
    operatorId: string;
    accessId: string;
    request?: SupportRequestLike;
  },
  now: Date = new Date(),
): Promise<EndSupportAccessResult> {
  return app.prisma.$transaction(
    async (tx): Promise<EndSupportAccessResult> => {
      const { count } = await tx.supportAccess.updateMany({
        where: {
          id: input.accessId,
          tenantId: input.tenantId,
          operatorId: input.operatorId,
          endedAt: null,
          expiresAt: { gt: now },
        },
        data: { endedAt: now, endedBy: "OPERATOR" },
      });
      const row = await tx.supportAccess.findFirst({
        where: { id: input.accessId, tenantId: input.tenantId, operatorId: input.operatorId },
      });
      if (!row) return { status: "NOT_FOUND" };
      if (count === 0) return { status: "NOT_ACTIVE" };

      const newValue = { endedBy: "OPERATOR", endedAt: now.toISOString() };
      await recordOperatorAudit(tx, {
        action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_ENDED,
        operatorId: input.operatorId,
        subjectTenantId: input.tenantId,
        entity: "SupportAccess",
        entityId: row.id,
        newValue,
        request: input.request,
      });
      await operatorTenantAudit(app, { operatorId: input.operatorId, tenantId: input.tenantId })(
        {
          action: OPERATOR_AUDIT_ACTIONS.SUPPORT_ACCESS_ENDED,
          entity: "SupportAccess",
          entityId: row.id,
          newValue,
        },
        tx,
      );
      return { status: "ENDED", access: toSupportAccessDto(row, now) };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

// ── Retention (D-07, D-25) ────────────────────────────────────────────────────────────────────────

/**
 * The only deletion path of `SupportAccess`: removes grants created more than 120 months before `now`
 * (`OPERATOR_AUDIT_RETENTION_MONTHS.LIFECYCLE` — a grant is part of the operator lifecycle record and
 * follows that retention class). The delete runs in a transaction that sets the transaction-local flag
 * `clokr.support_access_retention`, which the append-only trigger requires for any DELETE; the trigger
 * additionally refuses rows younger than 120 months, so even a misused flag cannot erase a recent grant.
 * Called by the daily data-retention run, for every tenant — deactivated ones included.
 */
export async function purgeExpiredSupportAccess(
  db: PrismaClient,
  now: Date,
): Promise<{ deleted: number }> {
  const cutoff = subtractUtcMonths(now, OPERATOR_AUDIT_RETENTION_MONTHS.LIFECYCLE);
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL clokr.support_access_retention = 'on'`);
    const { count } = await tx.supportAccess.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return { deleted: count };
  });
}

// ── Tenant notification (D-08, D-14) ──────────────────────────────────────────────────────────────

/**
 * Tells the controlling tenant, in-app, that a support access has started. A REACTIVE handler (ADR 0002,
 * Entscheidung 10): the caller runs it after the grant transaction committed and inside its own
 * try/catch, it may fail, and it never undoes or delays the grant. It is never mailed (the
 * `SUPPORT_ACCESS_STARTED` entry of the email policy is "never") — the in-app notice and the log are the
 * accountability record, not an inbox item.
 *
 * Recipients follow D-08: every active user of the tenant who holds `tenant-settings:update` with
 * whole-tenant reach (the controller's administrators; the key has the relation MANDANT, so only
 * tenant-scope holders are candidates and no salon narrowing applies). The LINK to the admin page is
 * set only for a recipient who also holds `audit-log:read` with whole-tenant reach — the guard of the
 * link's target `/admin/support-access/[id]` — so nobody receives a dead link. A `tenant-settings:update`
 * holder without `audit-log:read` is still informed (D-08's recipient set stays whole), just without the
 * link it could not open.
 *
 * The end time is written in the tenant's time zone; the reason is the operator's free text and is
 * escaped by the notification layer (mail) and by Svelte (in-app).
 */
export async function notifySupportAccessStarted(
  app: FastifyInstance,
  input: { tenantId: string; accessId: string; reason: string; expiresAt: Date },
): Promise<void> {
  const holderIds = await userIdsHoldingPermission(
    app.prisma,
    input.tenantId,
    "tenant-settings:update:ZUGEWIESEN",
  );
  const recipients = await app.prisma.user.findMany({
    where: { id: { in: holderIds }, isActive: true, employee: { tenantId: input.tenantId } },
    select: { id: true },
  });
  if (recipients.length === 0) return;

  const linkHolderIds = new Set(
    await userIdsHoldingPermission(app.prisma, input.tenantId, "audit-log:read:ZUGEWIESEN"),
  );
  const timeZone = await readTenantTimezone(app.prisma, input.tenantId);
  const endsAt = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(input.expiresAt);
  const message = `Ein Support-Zugriff auf Ihren Mandanten wurde gestartet. Er endet am ${endsAt} Uhr. Grund: ${input.reason}`;

  for (const recipient of recipients) {
    try {
      await app.notify({
        userId: recipient.id,
        type: "SUPPORT_ACCESS_STARTED",
        title: "Support-Zugriff gestartet",
        message,
        ...(linkHolderIds.has(recipient.id)
          ? { link: `/admin/support-access/${input.accessId}` }
          : {}),
        tenantId: input.tenantId,
        relatedType: "SupportAccess",
        relatedId: input.accessId,
      });
    } catch (err) {
      // One failing recipient never stops the others; the grant itself is long committed.
      app.log.warn(
        { err, accessId: input.accessId, userId: recipient.id },
        "Support access notification failed",
      );
    }
  }
}

/** Dismisses the start notices of one access for every recipient — called after every end (D-14). */
export async function dismissSupportAccessNotices(
  app: FastifyInstance,
  accessId: string,
): Promise<void> {
  await app.dismissByRelated("SupportAccess", accessId);
}
