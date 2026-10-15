/**
 * Issue #93 (Phase 93b-03) — a support grant is immutable at the database, with exactly two legal
 * changes: the single end transition (`endedAt` + `endedBy` set once) and the retention purge of a row
 * older than 120 months inside a flagged transaction. Every other UPDATE, every other DELETE and
 * TRUNCATE are refused by the `support_access_guard` trigger; the CHECK constraints pin the value sets.
 *
 * The raw statements run through `app.prisma.$executeRawUnsafe` on grants made with `seedSupportAccess`.
 * Operator accounts and operator audit rows are never deleted here (append-only by design); the tenant
 * fixture is cleaned up in `afterAll`, which also removes its grants through the trigger-disabled delete
 * of `cleanupTestData`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedGrundversionTenant,
  seedOperator,
  seedSupportAccess,
  cleanupTestData,
} from "./setup";
import { purgeExpiredSupportAccess } from "../contexts/platform";

type Fixture = Awaited<ReturnType<typeof seedGrundversionTenant>>;

let app: FastifyInstance;
let fixture: Fixture;
let operatorId: string;

/** `months` calendar months before now (UTC), shifted `extraDays` further into the past. */
function monthsAgo(months: number, extraDays = 0): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  d.setUTCDate(d.getUTCDate() - extraDays);
  return d;
}

type GrantOverrides = Partial<
  Omit<Parameters<typeof seedSupportAccess>[1], "tenantId" | "operatorId">
>;

function grant(opts: GrantOverrides) {
  return seedSupportAccess(app, { tenantId: fixture.tenant.id, operatorId, ...opts });
}

/**
 * The guard raises with ERRCODE `restrict_violation` (23001). A raw statement surfaces the trigger's own
 * message ("append-only"); the Prisma ORM maps that code to its foreign-key error and drops the text
 * ("Foreign key constraint violated"). Both are a refusal — the row is asserted unchanged on top.
 */
const ORM_REFUSAL = /append-only|Foreign key constraint violated/;

const exists = async (id: string) =>
  (await app.prisma.supportAccess.findUnique({ where: { id } })) !== null;

beforeAll(async () => {
  app = await getTestApp();
  fixture = await seedGrundversionTenant(app, "i93");
  operatorId = (await seedOperator(app)).id;
});

afterAll(async () => {
  try {
    await cleanupTestData(app, fixture.tenant.id);
  } catch (err) {
    console.error("Test cleanup failed:", err);
  }
  await closeTestApp();
});

describe("SupportAccess is append-only: no edit of what a grant stood for (D-07, AC-93-6)", () => {
  it.each([
    ["reason", `UPDATE "SupportAccess" SET "reason" = 'Tampered reason text' WHERE "id" = $1`],
    [
      "expiresAt",
      `UPDATE "SupportAccess" SET "expiresAt" = "expiresAt" + interval '1 day' WHERE "id" = $1`,
    ],
    [
      "startedAt",
      `UPDATE "SupportAccess" SET "startedAt" = "startedAt" - interval '1 day' WHERE "id" = $1`,
    ],
    ["tenantId", `UPDATE "SupportAccess" SET "tenantId" = '${randomUUID()}' WHERE "id" = $1`],
  ])("a raw UPDATE of %s raises append-only and changes nothing", async (_column, statement) => {
    const row = await grant({});
    await expect(app.prisma.$executeRawUnsafe(statement, row.id)).rejects.toThrow(/append-only/);
    const after = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toEqual(row);
  });

  it("a Prisma update of the reason is refused the same way", async () => {
    const row = await grant({});
    await expect(
      app.prisma.supportAccess.update({ where: { id: row.id }, data: { reason: "Tampered text" } }),
    ).rejects.toThrow(ORM_REFUSAL);
    expect(await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
      row,
    );
  });
});

describe("the single end transition (D-02, D-07)", () => {
  it("ends a grant once, repeats as a no-op, and refuses a direct second edit of endedAt", async () => {
    const row = await grant({});
    const end = `UPDATE "SupportAccess" SET "endedAt" = now(), "endedBy" = 'OPERATOR' WHERE "id" = $1 AND "endedAt" IS NULL`;

    expect(await app.prisma.$executeRawUnsafe(end, row.id)).toBe(1);
    const ended = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } });
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endedBy).toBe("OPERATOR");
    // Nothing but the end pair moved.
    expect({ ...ended, endedAt: null, endedBy: null }).toEqual(row);

    // The guarded statement finds no open row any more: zero rows, no error.
    expect(await app.prisma.$executeRawUnsafe(end, row.id)).toBe(0);

    // A statement without the guard reaches the row and the trigger refuses the second end.
    await expect(
      app.prisma.$executeRawUnsafe(
        `UPDATE "SupportAccess" SET "endedAt" = now() + interval '1 hour', "endedBy" = 'OPERATOR' WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/append-only/);
    const still = await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } });
    expect(still.endedAt?.toISOString()).toBe(ended.endedAt?.toISOString());
  });

  it("an end without endedBy is refused", async () => {
    const row = await grant({});
    await expect(
      app.prisma.$executeRawUnsafe(
        `UPDATE "SupportAccess" SET "endedAt" = now() WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/append-only|SupportAccess_end_pair/);
    expect(
      (await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } })).endedAt,
    ).toBeNull();
  });

  it("an end with an endedBy outside the value set is refused by the CHECK", async () => {
    const row = await grant({});
    await expect(
      app.prisma.$executeRawUnsafe(
        `UPDATE "SupportAccess" SET "endedAt" = now(), "endedBy" = 'X' WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/SupportAccess_endedBy_valid/);
    expect(
      (await app.prisma.supportAccess.findUniqueOrThrow({ where: { id: row.id } })).endedAt,
    ).toBeNull();
  });

  it("an insert whose window has no length is refused by SupportAccess_window_valid", async () => {
    const at = new Date();
    await expect(grant({ startedAt: at, expiresAt: at })).rejects.toThrow(
      /SupportAccess_window_valid/,
    );
  });
});

describe("no deletion except the flagged retention purge of a row older than 120 months (D-25)", () => {
  it("a raw DELETE without the flag raises append-only", async () => {
    const row = await grant({ createdAt: monthsAgo(130) });
    await expect(
      app.prisma.$executeRawUnsafe(`DELETE FROM "SupportAccess" WHERE "id" = $1`, row.id),
    ).rejects.toThrow(/append-only/);
    expect(await exists(row.id)).toBe(true);
  });

  it("a Prisma delete without the flag raises append-only", async () => {
    const row = await grant({});
    await expect(app.prisma.supportAccess.delete({ where: { id: row.id } })).rejects.toThrow(
      ORM_REFUSAL,
    );
    expect(await exists(row.id)).toBe(true);
  });

  it("TRUNCATE raises the trigger error, not the test's own rollback", async () => {
    const sentinel = new Error("sentinel-rollback");
    const outcome = await app.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE "SupportAccess"`);
        throw sentinel;
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(outcome).not.toBeNull();
    expect(outcome).not.toBe(sentinel);
    expect(String(outcome)).toMatch(/append-only/);
  });

  it("a DELETE with the retention flag on but a young row is still refused (database floor)", async () => {
    const young = await grant({ createdAt: monthsAgo(1) });
    const nearly = await grant({ createdAt: monthsAgo(119) });
    for (const row of [young, nearly]) {
      await expect(
        app.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL clokr.support_access_retention = 'on'`);
          await tx.supportAccess.delete({ where: { id: row.id } });
        }),
      ).rejects.toThrow(ORM_REFUSAL);
      expect(await exists(row.id)).toBe(true);
    }
  });
});

describe("purgeExpiredSupportAccess and the daily retention run (D-25)", () => {
  it("deletes a row 121 months old, keeps one 119 months old, reports the count", async () => {
    const old = await grant({ createdAt: monthsAgo(121) });
    const keep = await grant({ createdAt: monthsAgo(119) });

    // Earlier cases of this file left refused (hence still stored) rows older than 120 months; the purge
    // removes every eligible row of the database, so the count is measured, not assumed.
    const eligible = await app.prisma.supportAccess.count({
      where: { createdAt: { lt: monthsAgo(120) } },
    });
    expect(eligible).toBeGreaterThanOrEqual(1);

    const result = await purgeExpiredSupportAccess(app.prisma, new Date());

    expect(result).toEqual({ deleted: eligible });
    expect(await exists(old.id)).toBe(false);
    expect(await exists(keep.id)).toBe(true);
  });

  it("the daily retention run purges it too, for a deactivated tenant as well", async () => {
    const old = await grant({ createdAt: monthsAgo(121, 2) });
    const keep = await grant({ createdAt: monthsAgo(119, 2) });
    await app.prisma.tenant.update({
      where: { id: fixture.tenant.id },
      data: { deactivatedAt: new Date() },
    });
    try {
      await app.runPurgeableAuditLogs!();
    } finally {
      await app.prisma.tenant.update({
        where: { id: fixture.tenant.id },
        data: { deactivatedAt: null },
      });
      app.invalidateTenantState(fixture.tenant.id);
    }
    expect(await exists(old.id)).toBe(false);
    expect(await exists(keep.id)).toBe(true);
  });
});

describe("the operator audit trigger of Phase 88 is unchanged", () => {
  it("OperatorAuditLog still refuses UPDATE and DELETE", async () => {
    const row = await app.prisma.operatorAuditLog.create({
      data: { action: "OPERATOR_LOGIN", entity: "OperatorAccount", operatorId },
      select: { id: true },
    });
    await expect(
      app.prisma.$executeRawUnsafe(
        `UPDATE "OperatorAuditLog" SET "entity" = 'Tampered' WHERE "id" = $1`,
        row.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      app.prisma.$executeRawUnsafe(`DELETE FROM "OperatorAuditLog" WHERE "id" = $1`, row.id),
    ).rejects.toThrow(/append-only/);
  });
});

describe("no write route on any audit log or on the grant routes", () => {
  it("no PUT, PATCH or DELETE answers on /api/v1/audit-logs", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      for (const url of ["/api/v1/audit-logs", "/api/v1/audit-logs/:id"]) {
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
    }
  });

  it("no DELETE, PUT or PATCH answers on the operator support-access routes", () => {
    const base = "/api/v1/operator/tenants/:id/support-access";
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      for (const url of [base, `${base}/:accessId`, `${base}/:accessId/end`]) {
        expect(app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
    }
  });
});
